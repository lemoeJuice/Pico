import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import type { ModelRequestTrace } from '../../contracts/model.js';
import type { ChatGptModelChoice } from './types.js';

const authIssuer = 'https://auth.openai.com';
const authorizeEndpoint = `${authIssuer}/api/accounts/authorize`;
const tokenEndpoint = `${authIssuer}/api/accounts/oauth/token`;
const resource = 'https://api.openai.com/v1';
const authStateKey = 'oauth';
const planScope = 'chatgpt.tokens.use.direct';
const requestedScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const refreshAheadMs = 120_000;
const modelCatalogRefreshMs = 10 * 60_000;
const modelCatalogRetryMs = 60_000;
const modelCatalogStateKey = 'modelCatalog';

interface CachedModelCatalog {
  models: ChatGptModelChoice[];
  refreshedAt: number;
}

interface StoredCredentials {
  hostId: string;
  clientId: string | null;
  subject: string | null;
  email: string | null;
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
}

interface PendingAuthorization {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  createdAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface OidcMetadata {
  issuer?: unknown;
  jwks_uri?: unknown;
  revocation_endpoint?: unknown;
}

interface JsonWebKeySet {
  keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
}

interface IdentityClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  sub?: unknown;
  exp?: unknown;
  nonce?: unknown;
  email?: unknown;
}

class UnusableChatGptRefreshToken extends Error {}

export class RetryableChatGptAuthorizationExchange extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`ChatGPT sign-in response is missing ${name}.`);
  return value;
}

function decodeJwtPart(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('ChatGPT returned a malformed identity token.');
  }
}

function scopesFrom(value: unknown): string[] {
  return typeof value === 'string' ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
}

function expiryFrom(value: unknown, now: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('ChatGPT sign-in response did not include a valid token lifetime.');
  }
  return now + value * 1000;
}

function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(code)) return code;
    if ((current as { name?: unknown }).name === 'TimeoutError') return 'timeout';
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function normalizedCredential(value: unknown): StoredCredentials | null {
  if (!isObject(value) || typeof value.hostId !== 'string') return null;
  return {
    hostId: value.hostId,
    clientId: typeof value.clientId === 'string' ? value.clientId : null,
    subject: typeof value.subject === 'string' ? value.subject : null,
    email: typeof value.email === 'string' ? value.email : null,
    idToken: typeof value.idToken === 'string' ? value.idToken : null,
    accessToken: typeof value.accessToken === 'string' ? value.accessToken : null,
    refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : null,
    expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
    scopes: Array.isArray(value.scopes) ? value.scopes.filter((item): item is string => typeof item === 'string') : [],
  };
}

export interface ChatGptAccountStatus {
  connected: boolean;
  accountLabel: string | null;
}

export interface ChatGptPluginState {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
}

export interface ChatGptPluginSecrets {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
}

export interface ChatGptPluginCache {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
}

/** Implements OpenAI's public Sign in with ChatGPT flow for eligible open-source clients. */
export class ChatGptPlanAuth {
  private readonly pending = new Map<string, PendingAuthorization>();
  private refreshInFlight: Promise<string> | null = null;
  private metadata: OidcMetadata | null = null;
  private jwks: JsonWebKeySet | null = null;
  private modelCatalogRefreshInFlight: Promise<ChatGptModelChoice[]> | null = null;
  private modelCatalogLastRefreshAttemptAt = 0;

  constructor(
    state: ChatGptPluginState,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly secrets: ChatGptPluginSecrets = state,
    private readonly cache: ChatGptPluginCache = state,
  ) {}

  status(): ChatGptAccountStatus {
    const credentials = this.readCredentials();
    const connected = Boolean(
      credentials?.clientId && credentials.refreshToken && credentials.scopes.includes(planScope),
    );
    return { connected, accountLabel: connected ? (credentials?.email ?? 'ChatGPT account') : null };
  }

  async beginSignIn(redirectUri: string): Promise<{ authorizationUrl: string }> {
    const redirect = new URL(redirectUri);
    if (
      redirect.protocol !== 'http:' ||
      redirect.hostname !== '127.0.0.1' ||
      redirect.username ||
      redirect.password ||
      !redirect.pathname.endsWith('/auth/callback')
    ) {
      throw new Error('ChatGPT sign-in requires the registered 127.0.0.1 loopback callback.');
    }

    const stored = this.readCredentials();
    const hostId = stored?.hostId ?? `urn:uuid:${randomUUID()}`;
    const clientId = stored?.clientId ?? 'dynamic_agent_client';
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const attempt: PendingAuthorization = {
      state,
      nonce,
      verifier,
      redirectUri: redirect.toString(),
      clientId,
      createdAt: this.now(),
    };
    for (const [key, existing] of this.pending) {
      if (existing.createdAt + 10 * 60_000 <= this.now()) this.pending.delete(key);
    }
    this.pending.set(state, attempt);

    const url = new URL(authorizeEndpoint);
    url.search = new URLSearchParams({
      client_id: clientId,
      ...(clientId === 'dynamic_agent_client' ? { agent_name_hint: 'Pico' } : {}),
      ext_agent_host_id: hostId,
      ...(clientId !== 'dynamic_agent_client' && stored?.idToken ? { id_token_hint: stored.idToken } : {}),
      ...(clientId !== 'dynamic_agent_client' && stored?.email ? { login_hint: stored.email } : {}),
      response_type: 'code',
      redirect_uri: redirect.toString(),
      scope: requestedScopes,
      resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString();
    this.writeCredentials({
      hostId,
      clientId: stored?.clientId ?? null,
      subject: stored?.subject ?? null,
      email: stored?.email ?? null,
      idToken: stored?.idToken ?? null,
      accessToken: stored?.accessToken ?? null,
      refreshToken: stored?.refreshToken ?? null,
      expiresAt: stored?.expiresAt ?? null,
      scopes: stored?.scopes ?? [],
    });
    return { authorizationUrl: url.toString() };
  }

  parseCallbackUrl(callbackUrl: string, redirectUri: string): URLSearchParams {
    if (callbackUrl.length > 8192) throw new Error('ChatGPT callback URL is too long.');

    let callback: URL;
    let redirect: URL;
    try {
      callback = new URL(callbackUrl.trim());
      redirect = new URL(redirectUri);
    } catch {
      throw new Error('Paste the full ChatGPT callback URL from the browser address bar.');
    }

    if (
      callback.protocol !== 'http:' ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname
    ) {
      throw new Error('This callback URL does not match the active ChatGPT sign-in attempt.');
    }

    const states = callback.searchParams.getAll('state');
    const codes = callback.searchParams.getAll('code');
    const errors = callback.searchParams.getAll('error');
    const clientIds = callback.searchParams.getAll('client_id');
    if (
      states.length !== 1 ||
      codes.length > 1 ||
      errors.length > 1 ||
      clientIds.length > 1 ||
      (clientIds.length === 1 && !clientIds[0]) ||
      Boolean(codes.length) === Boolean(errors.length)
    ) {
      throw new Error('The ChatGPT callback URL is incomplete or malformed.');
    }

    if (!this.hasPendingAuthorization(states[0] ?? null, redirectUri)) {
      throw new Error('This ChatGPT sign-in attempt expired or did not match. Start again.');
    }

    return callback.searchParams;
  }

  hasPendingAuthorization(state: string | null, redirectUri: string): boolean {
    if (!state) return false;
    const attempt = this.pending.get(state);
    return Boolean(attempt && attempt.redirectUri === redirectUri && attempt.createdAt + 10 * 60_000 > this.now());
  }

  async completeSignIn(
    callback: URLSearchParams,
    redirectUri: string,
    options: { allowTransportRetry?: boolean } = {},
  ): Promise<ChatGptAccountStatus> {
    const state = callback.get('state');
    const attempt = state ? this.pending.get(state) : undefined;
    if (!attempt || attempt.redirectUri !== redirectUri || attempt.createdAt + 10 * 60_000 <= this.now()) {
      throw new Error('ChatGPT sign-in expired or did not match this authorization attempt. Start again.');
    }
    const codes = callback.getAll('code');
    const errors = callback.getAll('error');
    const clientIds = callback.getAll('client_id');
    if (
      callback.getAll('state').length !== 1 ||
      codes.length > 1 ||
      errors.length > 1 ||
      clientIds.length > 1 ||
      (clientIds.length === 1 && !clientIds[0]) ||
      Boolean(codes.length) === Boolean(errors.length) ||
      (codes.length === 1 && !codes[0]) ||
      (errors.length === 1 && !errors[0])
    ) {
      throw new Error('The ChatGPT callback is incomplete or malformed.');
    }
    if (callback.get('error')) {
      this.pending.delete(attempt.state);
      if (callback.get('error') === 'access_denied') throw new Error('ChatGPT sign-in was cancelled.');
      throw new Error('ChatGPT sign-in was not completed.');
    }

    const code = stringField(callback.get('code'), 'authorization code');
    const callbackClientId = callback.get('client_id');
    let clientId = attempt.clientId;
    try {
      if (attempt.clientId === 'dynamic_agent_client') {
        clientId = stringField(callbackClientId, 'registered client ID');
        if (clientId === 'dynamic_agent_client') {
          throw new Error('ChatGPT did not finish registering Pico. Start again.');
        }
      } else if (callbackClientId && callbackClientId !== attempt.clientId) {
        throw new Error('ChatGPT returned a different client registration. Start sign-in again.');
      }
    } catch (error) {
      this.pending.delete(attempt.state);
      throw error;
    }

    let tokenResponse: TokenResponse;
    try {
      tokenResponse = await this.exchangeToken({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource,
      });
    } catch (error) {
      if (!(error instanceof RetryableChatGptAuthorizationExchange && options.allowTransportRetry !== false)) {
        this.pending.delete(attempt.state);
      }
      throw error;
    }
    this.pending.delete(attempt.state);
    const accessToken = stringField(tokenResponse.access_token, 'access token');
    const refreshToken = stringField(tokenResponse.refresh_token, 'refresh token');
    const idToken = stringField(tokenResponse.id_token, 'identity token');
    if (stringField(tokenResponse.token_type, 'token type').toLowerCase() !== 'bearer') {
      throw new Error('ChatGPT returned an unsupported token type.');
    }
    const scopes = scopesFrom(tokenResponse.scope);
    if (!scopes.includes(planScope)) throw new Error('This ChatGPT account did not authorize plan usage for Pico.');
    const claims = await this.verifyIdentityToken(idToken, clientId, attempt.nonce);
    const existing = this.readCredentials();
    if (attempt.clientId !== 'dynamic_agent_client' && existing?.subject && existing.subject !== claims.sub) {
      throw new Error('The ChatGPT account changed during reauthorization. The saved account was not replaced.');
    }
    const saved: StoredCredentials = {
      hostId: existing?.hostId ?? `urn:uuid:${randomUUID()}`,
      clientId,
      subject: claims.sub as string,
      email: typeof claims.email === 'string' ? claims.email : (existing?.email ?? null),
      idToken,
      accessToken,
      refreshToken,
      expiresAt: expiryFrom(tokenResponse.expires_in, this.now()),
      scopes,
    };
    this.writeCredentials(saved);
    return this.status();
  }

  async accessToken(forceRefresh = false, requestTrace?: ModelRequestTrace): Promise<string> {
    const credentials = this.readCredentials();
    if (!credentials?.clientId || !credentials.refreshToken || !credentials.accessToken || !credentials.expiresAt) {
      throw new Error('Connect a ChatGPT account in Settings before using this model provider.');
    }
    if (!credentials.scopes.includes(planScope)) {
      throw new Error('The connected ChatGPT account has not granted plan usage to Pico. Reconnect it in Settings.');
    }
    if (!forceRefresh && credentials.expiresAt > this.now() + refreshAheadMs) return credentials.accessToken;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refresh(credentials, requestTrace).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async listModels(forceRefresh = false): Promise<ChatGptModelChoice[]> {
    const cached = this.readModelCatalog();
    if (cached && !forceRefresh) {
      if (
        cached.refreshedAt + modelCatalogRefreshMs <= this.now() &&
        this.modelCatalogLastRefreshAttemptAt + modelCatalogRetryMs <= this.now()
      ) {
        void this.refreshModels().catch(() => undefined);
      }
      return cached.models;
    }
    try {
      return await this.refreshModels();
    } catch (error) {
      if (cached) return cached.models;
      throw error;
    }
  }

  refreshModels(): Promise<ChatGptModelChoice[]> {
    if (this.modelCatalogRefreshInFlight) return this.modelCatalogRefreshInFlight;
    this.modelCatalogLastRefreshAttemptAt = this.now();
    const request = this.fetchModels()
      .then((models) => {
        this.cache.set<CachedModelCatalog>(modelCatalogStateKey, { models, refreshedAt: this.now() });
        return models;
      })
      .finally(() => {
        this.modelCatalogRefreshInFlight = null;
      });
    this.modelCatalogRefreshInFlight = request;
    return request;
  }

  private readModelCatalog(): CachedModelCatalog | null {
    const value: unknown = this.cache.get<unknown>(modelCatalogStateKey, null);
    if (!isObject(value) || !Array.isArray(value.models) || typeof value.refreshedAt !== 'number') return null;
    const models = value.models.flatMap((entry): ChatGptModelChoice[] => {
      if (!isObject(entry) || typeof entry.slug !== 'string' || typeof entry.displayName !== 'string') return [];
      return [{ slug: entry.slug, displayName: entry.displayName }];
    });
    return { models, refreshedAt: value.refreshedAt };
  }

  private async fetchModels(): Promise<ChatGptModelChoice[]> {
    let accessToken = await this.accessToken();
    const response = await this.fetcher('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    let modelsResponse = response;
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      accessToken = await this.accessToken(true);
      modelsResponse = await this.fetcher('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    }
    if (!modelsResponse.ok) throw new Error(`Could not load ChatGPT models (HTTP ${modelsResponse.status}).`);
    const payload: unknown = await modelsResponse.json();
    if (!isObject(payload) || !Array.isArray(payload.models)) {
      throw new Error('ChatGPT returned an invalid model catalog.');
    }
    return payload.models.flatMap((entry): ChatGptModelChoice[] => {
      if (!isObject(entry) || entry.visibility !== 'list' || typeof entry.slug !== 'string') return [];
      return [
        {
          slug: entry.slug,
          displayName: typeof entry.display_name === 'string' ? entry.display_name : entry.slug,
        },
      ];
    });
  }

  async signOut(): Promise<{ remoteRevoked: boolean }> {
    const credentials = this.readCredentials();
    let remoteRevoked = !credentials?.refreshToken || !credentials.clientId;
    if (credentials?.refreshToken && credentials.clientId) {
      try {
        const metadata = await this.oidcMetadata();
        const endpoint = typeof metadata.revocation_endpoint === 'string' ? metadata.revocation_endpoint : null;
        if (endpoint && new URL(endpoint).protocol === 'https:' && new URL(endpoint).hostname === 'auth.openai.com') {
          for (let attempt = 0; attempt < 3 && !remoteRevoked; attempt += 1) {
            const response = await this.fetcher(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: credentials.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: credentials.clientId,
              }),
              signal: AbortSignal.timeout(10_000),
            });
            remoteRevoked = response.status === 200;
            if (remoteRevoked || (response.status < 500 && response.status !== 429)) break;
            await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 200 : 700));
          }
        }
      } catch {
        remoteRevoked = false;
      }
    }
    if (credentials) {
      this.writeCredentials({
        ...credentials,
        idToken: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      });
    }
    this.cache.set<CachedModelCatalog | null>(modelCatalogStateKey, null);
    return { remoteRevoked };
  }

  private async refresh(credentials: StoredCredentials, requestTrace?: ModelRequestTrace): Promise<string> {
    let tokenResponse: TokenResponse;
    try {
      tokenResponse = await this.exchangeToken(
        {
          grant_type: 'refresh_token',
          client_id: credentials.clientId!,
          refresh_token: credentials.refreshToken!,
          resource,
        },
        requestTrace,
      );
    } catch (error) {
      if (error instanceof UnusableChatGptRefreshToken) {
        this.writeCredentials({
          ...credentials,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          scopes: [],
        });
      }
      throw error;
    }
    const accessToken = stringField(tokenResponse.access_token, 'refreshed access token');
    const refreshToken = stringField(tokenResponse.refresh_token, 'rotated refresh token');
    const scopes = scopesFrom(tokenResponse.scope);
    if (scopes.length > 0 && !scopes.includes(planScope)) {
      this.writeCredentials({
        ...credentials,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      });
      throw new UnusableChatGptRefreshToken(
        'The refreshed ChatGPT session no longer permits plan usage. Reconnect it in Settings.',
      );
    }
    this.writeCredentials({
      ...credentials,
      accessToken,
      refreshToken,
      expiresAt: expiryFrom(tokenResponse.expires_in, this.now()),
      scopes: scopes.length ? scopes : credentials.scopes,
      idToken: credentials.idToken,
    });
    return accessToken;
  }

  private async exchangeToken(
    fields: Record<string, string>,
    requestTrace?: ModelRequestTrace,
  ): Promise<TokenResponse> {
    const startedAt = Date.now();
    const providerAttemptId = requestTrace?.started({
      provider: 'chatgpt-plan',
      protocol: 'https+oauth-token',
      endpoint: tokenEndpoint,
      attempt: 1,
    });
    let settled = false;
    const settle = (details: Parameters<ModelRequestTrace['settled']>[1]): void => {
      if (!providerAttemptId || settled) return;
      settled = true;
      requestTrace?.settled(providerAttemptId, details);
    };
    let response: Response;
    try {
      response = await this.fetcher(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const errorCode = aborted ? 'aborted' : networkErrorCode(error);
      settle({
        outcome: aborted ? 'interrupted' : 'failed',
        durationMs: Date.now() - startedAt,
        errorCategory: aborted ? 'aborted' : 'transport',
        ...(errorCode ? { errorCode } : {}),
      });
      if (fields.grant_type === 'authorization_code') {
        throw new RetryableChatGptAuthorizationExchange(
          'The ChatGPT token request did not return a response. You can retry it once; if the authorization code was already used, start a new sign-in.',
        );
      }
      throw error;
    }
    if (providerAttemptId) {
      requestTrace?.response(providerAttemptId, {
        status: response.status,
        contentType: response.headers.get('content-type'),
      });
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      settle({
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        terminalEvent: 'http_response',
        errorCategory: 'http',
        errorCode: `http_${response.status}`,
      });
      const error = isObject(payload) && typeof payload.error === 'string' ? payload.error : '';
      const unusableRefreshCodes = new Set([
        'invalid_grant',
        'invalid_refresh_token',
        'token_expired',
        'refresh_token_expired',
        'refresh_token_invalidated',
        'refresh_token_reused',
      ]);
      if (unusableRefreshCodes.has(error)) {
        throw new UnusableChatGptRefreshToken('ChatGPT authorization expired. Reconnect your account in Settings.');
      }
      throw new Error(`ChatGPT token exchange failed (HTTP ${response.status}).`);
    }
    if (!isObject(payload)) {
      settle({
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        terminalEvent: 'http_response',
        errorCategory: 'protocol',
        errorCode: 'invalid_token_response',
      });
      throw new Error('ChatGPT returned an invalid token response.');
    }
    settle({
      outcome: 'completed',
      durationMs: Date.now() - startedAt,
      terminalEvent: 'http_response',
    });
    return payload as TokenResponse;
  }

  private async oidcMetadata(): Promise<OidcMetadata> {
    if (this.metadata) return this.metadata;
    const response = await this.fetcher(`${authIssuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Could not load ChatGPT identity verification metadata.');
    const value: unknown = await response.json();
    if (!isObject(value) || value.issuer !== authIssuer || typeof value.jwks_uri !== 'string') {
      throw new Error('ChatGPT identity metadata is invalid.');
    }
    const jwksUrl = new URL(value.jwks_uri);
    if (jwksUrl.protocol !== 'https:' || jwksUrl.hostname !== 'auth.openai.com') {
      throw new Error('ChatGPT identity metadata contains an untrusted signing key location.');
    }
    this.metadata = value as OidcMetadata;
    return this.metadata;
  }

  private async verifyIdentityToken(token: string, clientId: string, expectedNonce: string): Promise<IdentityClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('ChatGPT returned a malformed identity token.');
    const header = decodeJwtPart(parts[0]!);
    const claims = decodeJwtPart(parts[1]!) as IdentityClaims;
    const alg = header.alg;
    const kid = header.kid;
    if ((alg !== 'RS256' && alg !== 'ES256') || typeof kid !== 'string') {
      throw new Error('ChatGPT identity token uses an unsupported signing key.');
    }
    const metadata = await this.oidcMetadata();
    const loadJwks = async (force = false): Promise<JsonWebKeySet> => {
      if (this.jwks && !force) return this.jwks;
      const response = await this.fetcher(metadata.jwks_uri as string, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Could not load ChatGPT identity signing keys.');
      const value: unknown = await response.json();
      if (!isObject(value) || !Array.isArray(value.keys)) throw new Error('ChatGPT signing key set is invalid.');
      this.jwks = value as JsonWebKeySet;
      return this.jwks;
    };
    let keySet = await loadJwks();
    let jwk = keySet.keys?.find(
      (key) =>
        key.kid === kid &&
        key.use !== 'enc' &&
        (!key.alg || key.alg === alg) &&
        (!key.key_ops || key.key_ops.includes('verify')),
    );
    if (!jwk) {
      keySet = await loadJwks(true);
      jwk = keySet.keys?.find(
        (key) =>
          key.kid === kid &&
          key.use !== 'enc' &&
          (!key.alg || key.alg === alg) &&
          (!key.key_ops || key.key_ops.includes('verify')),
      );
    }
    if (!jwk) throw new Error('ChatGPT identity token signing key was not found.');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const signature = Buffer.from(parts[2]!, 'base64url');
    const validSignature =
      alg === 'RS256'
        ? verify('RSA-SHA256', data, key, signature)
        : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    const nowSeconds = Math.floor(this.now() / 1000);
    const audience = claims.aud;
    const audienceMatches = Array.isArray(audience) ? audience.includes(clientId) : audience === clientId;
    if (
      !validSignature ||
      claims.iss !== authIssuer ||
      !audienceMatches ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      typeof claims.sub !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= nowSeconds ||
      claims.nonce !== expectedNonce
    ) {
      throw new Error('ChatGPT identity token validation failed. The account was not connected.');
    }
    return claims;
  }

  private readCredentials(): StoredCredentials | null {
    return normalizedCredential(this.secrets.get<unknown>(authStateKey, null));
  }

  private writeCredentials(credentials: StoredCredentials): void {
    this.secrets.set(authStateKey, credentials);
  }
}
