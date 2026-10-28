// src/plugins/chatgpt-plan.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { createServer } from "node:http";
import { join as join2 } from "node:path";

// src/plugins/chatgpt-plan/oauth-store.ts
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
var databaseLocks = /* @__PURE__ */ new Map();
function secureSidecars(databasePath) {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(`${databasePath}${suffix}`, 384);
    } catch {
    }
  }
}
function createSharedChatGptOAuthSecrets(filename, owner) {
  const databasePath = resolve(filename);
  const runtimeDatabasePath = resolve(process.env.PICO_DB_PATH?.trim() || join(process.cwd(), "data", "pico.sqlite"));
  if (databasePath === runtimeDatabasePath) {
    throw new Error("PICO_CHATGPT_OAUTH_DB_PATH must point to a dedicated OAuth database.");
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 448 });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA busy_timeout = 30000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS private_secrets (
      owner TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner, key)
    );
  `);
  chmodSync(databasePath, 384);
  secureSidecars(databasePath);
  return {
    get(key, fallback) {
      const row = db.prepare("SELECT value_json FROM private_secrets WHERE owner = ? AND key = ?").get(owner, key);
      if (!row || typeof row.value_json !== "string") return fallback;
      try {
        return JSON.parse(row.value_json);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      const serialized = JSON.stringify(value);
      if (serialized === void 0) throw new Error("Private secret must be JSON serializable");
      db.prepare(
        `INSERT INTO private_secrets (owner, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      ).run(owner, key, serialized, (/* @__PURE__ */ new Date()).toISOString());
      secureSidecars(databasePath);
    },
    delete(key) {
      db.prepare("DELETE FROM private_secrets WHERE owner = ? AND key = ?").run(owner, key);
    },
    clear() {
      db.prepare("DELETE FROM private_secrets WHERE owner = ?").run(owner);
    },
    async withLock(operation) {
      const previous = databaseLocks.get(databasePath) ?? Promise.resolve();
      let release;
      const current = new Promise((resolve2) => {
        release = resolve2;
      });
      const tail = previous.then(() => current);
      databaseLocks.set(databasePath, tail);
      await previous;
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await operation();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("COMMIT");
          } catch {
            try {
              db.exec("ROLLBACK");
            } catch {
            }
          }
          throw error;
        }
      } finally {
        release();
        if (databaseLocks.get(databasePath) === tail) databaseLocks.delete(databasePath);
      }
    },
    close() {
      db.close();
    }
  };
}

// src/plugins/chatgpt-plan/auth.ts
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
var authIssuer = "https://auth.openai.com";
var authorizeEndpoint = `${authIssuer}/api/accounts/authorize`;
var tokenEndpoint = `${authIssuer}/api/accounts/oauth/token`;
var resource = "https://api.openai.com/v1";
var authStateKey = "oauth";
var planScope = "chatgpt.tokens.use.direct";
var requestedScopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
var refreshAheadMs = 12e4;
var modelCatalogRefreshMs = 10 * 6e4;
var modelCatalogRetryMs = 6e4;
var modelCatalogStateKey = "modelCatalog";
var UnusableChatGptRefreshToken = class extends Error {
};
var RetryableChatGptAuthorizationExchange = class extends Error {
};
function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function stringField(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`ChatGPT sign-in response is missing ${name}.`);
  return value;
}
function decodeJwtPart(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("ChatGPT returned a malformed identity token.");
  }
}
function scopesFrom(value) {
  return typeof value === "string" ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
}
function expiryFrom(value, now) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("ChatGPT sign-in response did not include a valid token lifetime.");
  }
  return now + value * 1e3;
}
function networkErrorCode(error) {
  let current = error;
  const visited = /* @__PURE__ */ new Set();
  for (let depth = 0; depth < 5 && current && typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = current.code;
    if (typeof code === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(code)) return code;
    if (current.name === "TimeoutError") return "timeout";
    current = current.cause;
  }
  return void 0;
}
function normalizedCredential(value) {
  if (!isObject(value) || typeof value.hostId !== "string") return null;
  return {
    hostId: value.hostId,
    clientId: typeof value.clientId === "string" ? value.clientId : null,
    subject: typeof value.subject === "string" ? value.subject : null,
    email: typeof value.email === "string" ? value.email : null,
    idToken: typeof value.idToken === "string" ? value.idToken : null,
    accessToken: typeof value.accessToken === "string" ? value.accessToken : null,
    refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : null,
    expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : null,
    scopes: Array.isArray(value.scopes) ? value.scopes.filter((item) => typeof item === "string") : []
  };
}
var ChatGptPlanAuth = class {
  constructor(state, fetcher = fetch, now = Date.now, secrets = state, cache = state) {
    this.fetcher = fetcher;
    this.now = now;
    this.secrets = secrets;
    this.cache = cache;
  }
  fetcher;
  now;
  secrets;
  cache;
  pending = /* @__PURE__ */ new Map();
  refreshInFlight = null;
  metadata = null;
  jwks = null;
  modelCatalogRefreshInFlight = null;
  modelCatalogLastRefreshAttemptAt = 0;
  status() {
    const credentials = this.readCredentials();
    const connected = Boolean(
      credentials?.clientId && credentials.refreshToken && credentials.scopes.includes(planScope)
    );
    return { connected, accountLabel: connected ? credentials?.email ?? "ChatGPT account" : null };
  }
  async beginSignIn(redirectUri) {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.username || redirect.password || !redirect.pathname.endsWith("/auth/callback")) {
      throw new Error("ChatGPT sign-in requires the registered 127.0.0.1 loopback callback.");
    }
    const stored = this.readCredentials();
    const hostId = stored?.hostId ?? `urn:uuid:${randomUUID()}`;
    const clientId = stored?.clientId ?? "dynamic_agent_client";
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const attempt = {
      state,
      nonce,
      verifier,
      redirectUri: redirect.toString(),
      clientId,
      createdAt: this.now()
    };
    for (const [key, existing] of this.pending) {
      if (existing.createdAt + 10 * 6e4 <= this.now()) this.pending.delete(key);
    }
    this.pending.set(state, attempt);
    const url = new URL(authorizeEndpoint);
    url.search = new URLSearchParams({
      client_id: clientId,
      ...clientId === "dynamic_agent_client" ? { agent_name_hint: "Pico" } : {},
      ext_agent_host_id: hostId,
      ...clientId !== "dynamic_agent_client" && stored?.idToken ? { id_token_hint: stored.idToken } : {},
      ...clientId !== "dynamic_agent_client" && stored?.email ? { login_hint: stored.email } : {},
      response_type: "code",
      redirect_uri: redirect.toString(),
      scope: requestedScopes,
      resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challenge
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
      scopes: stored?.scopes ?? []
    });
    return { authorizationUrl: url.toString() };
  }
  parseCallbackUrl(callbackUrl, redirectUri) {
    if (callbackUrl.length > 8192) throw new Error("ChatGPT callback URL is too long.");
    let callback;
    let redirect;
    try {
      callback = new URL(callbackUrl.trim());
      redirect = new URL(redirectUri);
    } catch {
      throw new Error("Paste the full ChatGPT callback URL from the browser address bar.");
    }
    if (callback.protocol !== "http:" || callback.username || callback.password || callback.hash || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) {
      throw new Error("This callback URL does not match the active ChatGPT sign-in attempt.");
    }
    const states = callback.searchParams.getAll("state");
    const codes = callback.searchParams.getAll("code");
    const errors = callback.searchParams.getAll("error");
    const clientIds = callback.searchParams.getAll("client_id");
    if (states.length !== 1 || codes.length > 1 || errors.length > 1 || clientIds.length > 1 || clientIds.length === 1 && !clientIds[0] || Boolean(codes.length) === Boolean(errors.length)) {
      throw new Error("The ChatGPT callback URL is incomplete or malformed.");
    }
    if (!this.hasPendingAuthorization(states[0] ?? null, redirectUri)) {
      throw new Error("This ChatGPT sign-in attempt expired or did not match. Start again.");
    }
    return callback.searchParams;
  }
  hasPendingAuthorization(state, redirectUri) {
    if (!state) return false;
    const attempt = this.pending.get(state);
    return Boolean(attempt && attempt.redirectUri === redirectUri && attempt.createdAt + 10 * 6e4 > this.now());
  }
  async completeSignIn(callback, redirectUri, options = {}) {
    const state = callback.get("state");
    const attempt = state ? this.pending.get(state) : void 0;
    if (!attempt || attempt.redirectUri !== redirectUri || attempt.createdAt + 10 * 6e4 <= this.now()) {
      throw new Error("ChatGPT sign-in expired or did not match this authorization attempt. Start again.");
    }
    const codes = callback.getAll("code");
    const errors = callback.getAll("error");
    const clientIds = callback.getAll("client_id");
    if (callback.getAll("state").length !== 1 || codes.length > 1 || errors.length > 1 || clientIds.length > 1 || clientIds.length === 1 && !clientIds[0] || Boolean(codes.length) === Boolean(errors.length) || codes.length === 1 && !codes[0] || errors.length === 1 && !errors[0]) {
      throw new Error("The ChatGPT callback is incomplete or malformed.");
    }
    if (callback.get("error")) {
      this.pending.delete(attempt.state);
      if (callback.get("error") === "access_denied") throw new Error("ChatGPT sign-in was cancelled.");
      throw new Error("ChatGPT sign-in was not completed.");
    }
    const code = stringField(callback.get("code"), "authorization code");
    const callbackClientId = callback.get("client_id");
    let clientId = attempt.clientId;
    try {
      if (attempt.clientId === "dynamic_agent_client") {
        clientId = stringField(callbackClientId, "registered client ID");
        if (clientId === "dynamic_agent_client") {
          throw new Error("ChatGPT did not finish registering Pico. Start again.");
        }
      } else if (callbackClientId && callbackClientId !== attempt.clientId) {
        throw new Error("ChatGPT returned a different client registration. Start sign-in again.");
      }
    } catch (error) {
      this.pending.delete(attempt.state);
      throw error;
    }
    let tokenResponse;
    try {
      tokenResponse = await this.exchangeToken({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource
      });
    } catch (error) {
      if (!(error instanceof RetryableChatGptAuthorizationExchange && options.allowTransportRetry !== false)) {
        this.pending.delete(attempt.state);
      }
      throw error;
    }
    this.pending.delete(attempt.state);
    const accessToken = stringField(tokenResponse.access_token, "access token");
    const refreshToken = stringField(tokenResponse.refresh_token, "refresh token");
    const idToken = stringField(tokenResponse.id_token, "identity token");
    if (stringField(tokenResponse.token_type, "token type").toLowerCase() !== "bearer") {
      throw new Error("ChatGPT returned an unsupported token type.");
    }
    const scopes = scopesFrom(tokenResponse.scope);
    if (!scopes.includes(planScope)) throw new Error("This ChatGPT account did not authorize plan usage for Pico.");
    const claims = await this.verifyIdentityToken(idToken, clientId, attempt.nonce);
    const existing = this.readCredentials();
    if (attempt.clientId !== "dynamic_agent_client" && existing?.subject && existing.subject !== claims.sub) {
      throw new Error("The ChatGPT account changed during reauthorization. The saved account was not replaced.");
    }
    const saved = {
      hostId: existing?.hostId ?? `urn:uuid:${randomUUID()}`,
      clientId,
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : existing?.email ?? null,
      idToken,
      accessToken,
      refreshToken,
      expiresAt: expiryFrom(tokenResponse.expires_in, this.now()),
      scopes
    };
    this.writeCredentials(saved);
    return this.status();
  }
  async accessToken(forceRefresh = false, requestTrace) {
    const credentials = this.readCredentials();
    this.assertUsableCredentials(credentials);
    if (!forceRefresh && credentials.expiresAt > this.now() + refreshAheadMs) return credentials.accessToken;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshWithCoordination(credentials, forceRefresh, requestTrace).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }
  assertUsableCredentials(credentials) {
    if (!credentials?.clientId || !credentials.refreshToken || !credentials.accessToken || !credentials.expiresAt) {
      throw new Error("Connect a ChatGPT account in Settings before using this model provider.");
    }
    if (!credentials.scopes.includes(planScope)) {
      throw new Error("The connected ChatGPT account has not granted plan usage to Pico. Reconnect it in Settings.");
    }
  }
  async refreshWithCoordination(observed, forceRefresh, requestTrace) {
    const refresh = async () => {
      const latest = this.readCredentials();
      this.assertUsableCredentials(latest);
      if (!forceRefresh && latest.expiresAt > this.now() + refreshAheadMs) return latest.accessToken;
      if (forceRefresh && latest.refreshToken !== observed.refreshToken && latest.expiresAt > this.now()) {
        return latest.accessToken;
      }
      return this.refresh(latest, requestTrace);
    };
    return this.secrets.withLock ? this.secrets.withLock(refresh) : refresh();
  }
  async listModels(forceRefresh = false) {
    const cached = this.readModelCatalog();
    if (cached && !forceRefresh) {
      if (cached.refreshedAt + modelCatalogRefreshMs <= this.now() && this.modelCatalogLastRefreshAttemptAt + modelCatalogRetryMs <= this.now()) {
        void this.refreshModels().catch(() => void 0);
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
  refreshModels() {
    if (this.modelCatalogRefreshInFlight) return this.modelCatalogRefreshInFlight;
    this.modelCatalogLastRefreshAttemptAt = this.now();
    const request = this.fetchModels().then((models) => {
      this.cache.set(modelCatalogStateKey, { models, refreshedAt: this.now() });
      return models;
    }).finally(() => {
      this.modelCatalogRefreshInFlight = null;
    });
    this.modelCatalogRefreshInFlight = request;
    return request;
  }
  readModelCatalog() {
    const value = this.cache.get(modelCatalogStateKey, null);
    if (!isObject(value) || !Array.isArray(value.models) || typeof value.refreshedAt !== "number") return null;
    const models = value.models.flatMap((entry) => {
      if (!isObject(entry) || typeof entry.slug !== "string" || typeof entry.displayName !== "string") return [];
      return [{ slug: entry.slug, displayName: entry.displayName }];
    });
    return { models, refreshedAt: value.refreshedAt };
  }
  async fetchModels() {
    let accessToken = await this.accessToken();
    const response = await this.fetcher("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15e3)
    });
    let modelsResponse = response;
    if (response.status === 401) {
      await response.body?.cancel().catch(() => void 0);
      accessToken = await this.accessToken(true);
      modelsResponse = await this.fetcher("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(15e3)
      });
    }
    if (!modelsResponse.ok) throw new Error(`Could not load ChatGPT models (HTTP ${modelsResponse.status}).`);
    const payload = await modelsResponse.json();
    if (!isObject(payload) || !Array.isArray(payload.models)) {
      throw new Error("ChatGPT returned an invalid model catalog.");
    }
    return payload.models.flatMap((entry) => {
      if (!isObject(entry) || entry.visibility !== "list" || typeof entry.slug !== "string") return [];
      return [
        {
          slug: entry.slug,
          displayName: typeof entry.display_name === "string" ? entry.display_name : entry.slug
        }
      ];
    });
  }
  async signOut() {
    const credentials = this.readCredentials();
    let remoteRevoked = !credentials?.refreshToken || !credentials.clientId;
    if (credentials?.refreshToken && credentials.clientId) {
      try {
        const metadata = await this.oidcMetadata();
        const endpoint = typeof metadata.revocation_endpoint === "string" ? metadata.revocation_endpoint : null;
        if (endpoint && new URL(endpoint).protocol === "https:" && new URL(endpoint).hostname === "auth.openai.com") {
          for (let attempt = 0; attempt < 3 && !remoteRevoked; attempt += 1) {
            const response = await this.fetcher(endpoint, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: credentials.refreshToken,
                token_type_hint: "refresh_token",
                client_id: credentials.clientId
              }),
              signal: AbortSignal.timeout(1e4)
            });
            remoteRevoked = response.status === 200;
            if (remoteRevoked || response.status < 500 && response.status !== 429) break;
            await new Promise((resolve2) => setTimeout(resolve2, attempt === 0 ? 200 : 700));
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
        scopes: []
      });
    }
    this.cache.set(modelCatalogStateKey, null);
    return { remoteRevoked };
  }
  async refresh(credentials, requestTrace) {
    let tokenResponse;
    try {
      tokenResponse = await this.exchangeToken(
        {
          grant_type: "refresh_token",
          client_id: credentials.clientId,
          refresh_token: credentials.refreshToken,
          resource
        },
        requestTrace
      );
    } catch (error) {
      if (error instanceof UnusableChatGptRefreshToken) {
        this.writeCredentials({
          ...credentials,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          scopes: []
        });
      }
      throw error;
    }
    const accessToken = stringField(tokenResponse.access_token, "refreshed access token");
    const refreshToken = stringField(tokenResponse.refresh_token, "rotated refresh token");
    const scopes = scopesFrom(tokenResponse.scope);
    if (scopes.length > 0 && !scopes.includes(planScope)) {
      this.writeCredentials({
        ...credentials,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scopes: []
      });
      throw new UnusableChatGptRefreshToken(
        "The refreshed ChatGPT session no longer permits plan usage. Reconnect it in Settings."
      );
    }
    this.writeCredentials({
      ...credentials,
      accessToken,
      refreshToken,
      expiresAt: expiryFrom(tokenResponse.expires_in, this.now()),
      scopes: scopes.length ? scopes : credentials.scopes,
      idToken: credentials.idToken
    });
    return accessToken;
  }
  async exchangeToken(fields, requestTrace) {
    const startedAt = Date.now();
    const providerAttemptId = requestTrace?.started({
      provider: "chatgpt-plan",
      protocol: "https+oauth-token",
      endpoint: tokenEndpoint,
      attempt: 1
    });
    let settled = false;
    const settle = (details) => {
      if (!providerAttemptId || settled) return;
      settled = true;
      requestTrace?.settled(providerAttemptId, details);
    };
    let response;
    try {
      response = await this.fetcher(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(15e3)
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const errorCode = aborted ? "aborted" : networkErrorCode(error);
      settle({
        outcome: aborted ? "interrupted" : "failed",
        durationMs: Date.now() - startedAt,
        errorCategory: aborted ? "aborted" : "transport",
        ...errorCode ? { errorCode } : {}
      });
      if (fields.grant_type === "authorization_code") {
        throw new RetryableChatGptAuthorizationExchange(
          "The ChatGPT token request did not return a response. You can retry it once; if the authorization code was already used, start a new sign-in."
        );
      }
      throw error;
    }
    if (providerAttemptId) {
      requestTrace?.response(providerAttemptId, {
        status: response.status,
        contentType: response.headers.get("content-type")
      });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      settle({
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        terminalEvent: "http_response",
        errorCategory: "http",
        errorCode: `http_${response.status}`
      });
      const error = isObject(payload) && typeof payload.error === "string" ? payload.error : "";
      const unusableRefreshCodes = /* @__PURE__ */ new Set([
        "invalid_grant",
        "invalid_refresh_token",
        "token_expired",
        "refresh_token_expired",
        "refresh_token_invalidated",
        "refresh_token_reused"
      ]);
      const safeOAuthErrorCodes = /* @__PURE__ */ new Set([
        "access_denied",
        "invalid_client",
        "invalid_grant",
        "invalid_request",
        "invalid_scope",
        "invalid_token_response",
        "invalid_refresh_token",
        "refresh_token_expired",
        "refresh_token_invalidated",
        "refresh_token_reused",
        "server_error",
        "temporarily_unavailable",
        "token_expired",
        "unauthorized_client",
        "unsupported_grant_type"
      ]);
      const providerErrorCode = typeof error === "string" && safeOAuthErrorCodes.has(error) ? error : void 0;
      if (unusableRefreshCodes.has(error)) {
        throw Object.assign(
          new UnusableChatGptRefreshToken("ChatGPT authorization expired. Reconnect your account in Settings."),
          {
            providerStatus: response.status,
            providerPhase: "oauth_token",
            ...providerErrorCode ? { providerError: { reason: "unknown", code: providerErrorCode } } : {}
          }
        );
      }
      throw Object.assign(new Error(`ChatGPT token exchange failed (HTTP ${response.status}).`), {
        providerStatus: response.status,
        providerPhase: "oauth_token",
        ...providerErrorCode ? { providerError: { reason: "unknown", code: providerErrorCode } } : {}
      });
    }
    if (!isObject(payload)) {
      settle({
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        terminalEvent: "http_response",
        errorCategory: "protocol",
        errorCode: "invalid_token_response"
      });
      throw Object.assign(new Error("ChatGPT returned an invalid token response."), {
        code: "invalid_token_response",
        providerPhase: "oauth_token"
      });
    }
    settle({
      outcome: "completed",
      durationMs: Date.now() - startedAt,
      terminalEvent: "http_response"
    });
    return payload;
  }
  async oidcMetadata() {
    if (this.metadata) return this.metadata;
    const response = await this.fetcher(`${authIssuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) throw new Error("Could not load ChatGPT identity verification metadata.");
    const value = await response.json();
    if (!isObject(value) || value.issuer !== authIssuer || typeof value.jwks_uri !== "string") {
      throw new Error("ChatGPT identity metadata is invalid.");
    }
    const jwksUrl = new URL(value.jwks_uri);
    if (jwksUrl.protocol !== "https:" || jwksUrl.hostname !== "auth.openai.com") {
      throw new Error("ChatGPT identity metadata contains an untrusted signing key location.");
    }
    this.metadata = value;
    return this.metadata;
  }
  async verifyIdentityToken(token, clientId, expectedNonce) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("ChatGPT returned a malformed identity token.");
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    const alg = header.alg;
    const kid = header.kid;
    if (alg !== "RS256" && alg !== "ES256" || typeof kid !== "string") {
      throw new Error("ChatGPT identity token uses an unsupported signing key.");
    }
    const metadata = await this.oidcMetadata();
    const loadJwks = async (force = false) => {
      if (this.jwks && !force) return this.jwks;
      const response = await this.fetcher(metadata.jwks_uri, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1e4)
      });
      if (!response.ok) throw new Error("Could not load ChatGPT identity signing keys.");
      const value = await response.json();
      if (!isObject(value) || !Array.isArray(value.keys)) throw new Error("ChatGPT signing key set is invalid.");
      this.jwks = value;
      return this.jwks;
    };
    let keySet = await loadJwks();
    let jwk = keySet.keys?.find(
      (key2) => key2.kid === kid && key2.use !== "enc" && (!key2.alg || key2.alg === alg) && (!key2.key_ops || key2.key_ops.includes("verify"))
    );
    if (!jwk) {
      keySet = await loadJwks(true);
      jwk = keySet.keys?.find(
        (key2) => key2.kid === kid && key2.use !== "enc" && (!key2.alg || key2.alg === alg) && (!key2.key_ops || key2.key_ops.includes("verify"))
      );
    }
    if (!jwk) throw new Error("ChatGPT identity token signing key was not found.");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
    const signature = Buffer.from(parts[2], "base64url");
    const validSignature = alg === "RS256" ? verify("RSA-SHA256", data, key, signature) : verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
    const nowSeconds = Math.floor(this.now() / 1e3);
    const audience = claims.aud;
    const audienceMatches = Array.isArray(audience) ? audience.includes(clientId) : audience === clientId;
    if (!validSignature || claims.iss !== authIssuer || !audienceMatches || claims.azp !== void 0 && claims.azp !== clientId || typeof claims.sub !== "string" || typeof claims.exp !== "number" || claims.exp <= nowSeconds || claims.nonce !== expectedNonce) {
      throw new Error("ChatGPT identity token validation failed. The account was not connected.");
    }
    return claims;
  }
  readCredentials() {
    return normalizedCredential(this.secrets.get(authStateKey, null));
  }
  writeCredentials(credentials) {
    this.secrets.set(authStateKey, credentials);
  }
};

// src/plugins/chatgpt-plan.ts
function callbackForRetry(callback) {
  const retry = new URLSearchParams();
  for (const name of ["state", "code", "client_id"]) {
    const values = callback.getAll(name);
    if (values.length === 1 && values[0]) retry.set(name, values[0]);
  }
  return retry;
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
function pluginAuthResultHtml(operationId, status, message, retryable, retryExchange) {
  const payload = JSON.stringify({
    type: "pico:plugin-auth",
    pluginId: "pico.chatgpt-plan",
    operationId,
    status,
    message,
    retryable,
    retryExchange
  }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const closePopup = status === "connected" || retryExchange;
  return `<!doctype html><meta charset="utf-8"><title>ChatGPT sign-in</title><p>${escapeHtml(message)}</p><p>You can close this tab and return to Pico.</p><script>if(window.opener){window.opener.postMessage(${payload},'*');if(${closePopup})window.close();}</script>`;
}
function createChatGptPlanPlugin() {
  const callbackServers = /* @__PURE__ */ new Set();
  const callbackTimeouts = /* @__PURE__ */ new Map();
  const callbackOperations = /* @__PURE__ */ new Map();
  const authByInstance = /* @__PURE__ */ new Map();
  let sharedOAuthSecrets = null;
  const instanceSharedSecrets = /* @__PURE__ */ new Map();
  let instanceAvailable = () => false;
  let refreshCatalog = async () => void 0;
  const closeCallbackServer = (server, force = false) => {
    const timeout = callbackTimeouts.get(server);
    if (timeout) clearTimeout(timeout);
    callbackTimeouts.delete(server);
    callbackServers.delete(server);
    for (const [operationId, operation] of callbackOperations) {
      if (operation.server === server) callbackOperations.delete(operationId);
    }
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve2) => {
      server.close(() => resolve2());
      if (force) server.closeAllConnections();
    });
  };
  const completeCallback = async (operation, callback, retryExchange = false) => {
    if (!instanceAvailable(operation.instanceId)) {
      return {
        status: "failed",
        message: "This ChatGPT account instance no longer exists.",
        retryable: false,
        retryExchange: false
      };
    }
    if (operation.handlingCallback) {
      return {
        status: "failed",
        message: "Authorization is already being completed.",
        retryable: true,
        retryExchange: Boolean(operation.retryCallback)
      };
    }
    if (!operation.auth.hasPendingAuthorization(callback.get("state"), operation.redirectUri)) {
      return {
        status: "failed",
        message: "This ChatGPT sign-in attempt expired or did not match. Start again.",
        retryable: false,
        retryExchange: false
      };
    }
    operation.handlingCallback = true;
    let result;
    try {
      await operation.auth.completeSignIn(callback, operation.redirectUri, { allowTransportRetry: !retryExchange });
      operation.retryCallback = null;
      void operation.auth.refreshModels().then(() => refreshCatalog(operation.instanceId)).catch(() => void 0);
      result = {
        status: "connected",
        message: "ChatGPT is connected. Return to Pico.",
        retryable: false,
        retryExchange: false
      };
    } catch (error) {
      const pending = operation.auth.hasPendingAuthorization(callback.get("state"), operation.redirectUri);
      const canRetryExchange = !retryExchange && pending && error instanceof RetryableChatGptAuthorizationExchange && !operation.retryAttempted;
      operation.retryCallback = canRetryExchange ? callbackForRetry(callback) : null;
      result = {
        status: "failed",
        message: retryExchange && error instanceof RetryableChatGptAuthorizationExchange ? "The retry did not return a response. Start a new ChatGPT sign-in." : error instanceof Error ? error.message : "ChatGPT sign-in failed.",
        retryable: pending,
        retryExchange: canRetryExchange
      };
    }
    if (result.retryable) operation.handlingCallback = false;
    return result;
  };
  return {
    id: "pico.chatgpt-plan",
    name: "ChatGPT plan provider",
    version: "0.1.0",
    activate(context) {
      const sharedOAuthPath = process.env.PICO_CHATGPT_OAUTH_DB_PATH?.trim() || (process.env.NODE_ENV === "production" ? join2(process.cwd(), "data", "chatgpt-oauth.sqlite") : null);
      sharedOAuthSecrets = sharedOAuthPath ? createSharedChatGptOAuthSecrets(sharedOAuthPath, "pico.chatgpt-plan") : null;
      instanceAvailable = (id) => context.providers.get(id)?.typeId === "chatgpt-plan";
      refreshCatalog = (id) => context.providers.refresh(id);
      const providerConfig = { chatgpt: true, fetchRetries: 5, retryDelayMs: 2e3, refreshOnUnauthorized: true };
      const sharedSecretsFor = (instance) => {
        if (sharedOAuthSecrets && instance.config.legacyShared === true) return sharedOAuthSecrets;
        if (!sharedOAuthPath) return null;
        let secrets = instanceSharedSecrets.get(instance.id);
        if (!secrets) {
          secrets = createSharedChatGptOAuthSecrets(sharedOAuthPath, `pico.chatgpt-plan:instance:${instance.id}`);
          instanceSharedSecrets.set(instance.id, secrets);
        }
        return secrets;
      };
      const secretsFor = (id) => {
        const instance = context.providers.get(id);
        if (!instance || instance.typeId !== "chatgpt-plan") throw new Error("ChatGPT account instance not found.");
        const shared = sharedSecretsFor(instance);
        const raw = shared ?? context.providers.secrets(id);
        const ensureActive = () => {
          if (!instanceAvailable(id)) throw new Error("ChatGPT account instance no longer exists.");
        };
        const guarded = {
          get: (key, fallback) => {
            ensureActive();
            return raw.get(key, fallback);
          },
          set: (key, value) => {
            ensureActive();
            raw.set(key, value);
          }
        };
        return shared ? {
          ...guarded,
          withLock: async (operation) => {
            ensureActive();
            return shared.withLock(async () => {
              ensureActive();
              return operation();
            });
          }
        } : guarded;
      };
      const getAuth = (id) => {
        const instance = context.providers.get(id);
        if (!instance || instance.typeId !== "chatgpt-plan") throw new Error("ChatGPT account instance not found.");
        let auth = authByInstance.get(id);
        if (!auth) {
          const prefix = `instance:${id}:`;
          const cache = {
            get: (key, fallback) => context.cache.get(prefix + key, fallback),
            set: (key, value) => {
              if (!instanceAvailable(id)) throw new Error("ChatGPT account instance no longer exists.");
              context.cache.set(prefix + key, value);
            }
          };
          auth = new ChatGptPlanAuth(context.state, fetch, Date.now, secretsFor(id), cache);
          authByInstance.set(id, auth);
        }
        return auth;
      };
      const requireInstance = (request) => {
        const values = request.query.getAll("instanceId");
        if (values.length !== 1 || !values[0]) throw new Error("A ChatGPT account instance is required.");
        return { id: values[0], auth: getAuth(values[0]) };
      };
      context.providers.registerType(
        {
          id: "chatgpt-plan",
          label: "ChatGPT account",
          description: "Use a ChatGPT plan account through OpenAI\u2019s Responses API.",
          addPage: { pluginId: "pico.chatgpt-plan", pageId: "account" }
        },
        {
          listModels: async (instance) => (await getAuth(instance.id).listModels()).map((model) => ({
            id: model.slug,
            name: model.slug,
            label: model.displayName,
            protocol: "openai-responses",
            supportsImages: true,
            endpoint: "https://api.openai.com/v1/responses"
          })),
          authorize: async (instance, forceRefresh, signal) => {
            if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
            return { authorization: `Bearer ${await getAuth(instance.id).accessToken(forceRefresh)}` };
          },
          disposeInstance: async (instance) => {
            const operations = [...callbackOperations.values()].filter(
              (operation) => operation.instanceId === instance.id
            );
            await Promise.all(operations.map((operation) => closeCallbackServer(operation.server, true)));
            authByInstance.delete(instance.id);
            context.cache.set(`instance:${instance.id}:modelCatalog`, null);
            const secrets = sharedSecretsFor(instance);
            if (secrets) {
              try {
                await secrets.withLock(async () => {
                  secrets.clear();
                });
              } finally {
                if (secrets !== sharedOAuthSecrets) {
                  instanceSharedSecrets.delete(instance.id);
                  secrets.close();
                }
              }
            }
            if (instance.config.legacyMigration === true) context.secrets?.delete("oauth");
          }
        }
      );
      const sharedLegacy = sharedOAuthSecrets?.get("oauth", null) ?? null;
      const legacy = sharedLegacy ?? context.secrets?.get("oauth", null) ?? null;
      const legacyId = context.state.get("legacyInstanceId", null);
      if (legacy && !legacyId) {
        const instance = context.providers.list().find((item) => item.typeId === "chatgpt-plan" && item.config.legacyMigration === true) ?? context.providers.add("chatgpt-plan", {
          label: "ChatGPT account",
          config: { ...providerConfig, legacyMigration: true, legacyShared: Boolean(sharedLegacy) }
        });
        const secrets = secretsFor(instance.id);
        if (!secrets.get("oauth", null)) secrets.set("oauth", legacy);
        const catalog = context.cache.get("modelCatalog", null) ?? context.state.get("modelCatalog", null);
        if (catalog) context.cache.set(`instance:${instance.id}:modelCatalog`, catalog);
        context.state.set("legacyInstanceId", instance.id);
      }
      context.commands.register({
        name: "chatgpt-provider",
        description: "Show whether a ChatGPT account provider is connected.",
        execute() {
          const connected = context.providers.list().filter((instance) => instance.typeId === "chatgpt-plan").some((instance) => getAuth(instance.id).status().connected);
          return {
            text: connected ? "A ChatGPT account is connected." : "No ChatGPT account is connected. Open the ChatGPT plugin settings to connect one."
          };
        }
      });
      context.ui.registerPage({
        id: "account",
        label: "ChatGPT",
        description: "Connect and configure a ChatGPT plan account.",
        entry: "webui",
        externalAuthOrigins: ["https://auth.openai.com"]
      });
      context.http.register(
        "GET",
        "/instances",
        () => context.providers.list().filter((instance) => instance.typeId === "chatgpt-plan")
      );
      context.http.register("POST", "/instances", (request) => {
        const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body : {};
        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (!label || label.length > 120) throw new Error("Enter an account label.");
        return context.providers.add("chatgpt-plan", { label, config: providerConfig });
      });
      context.http.register("GET", "/status", (request) => requireInstance(request).auth.status());
      context.http.register("GET", "/models", async (request) => await requireInstance(request).auth.listModels());
      context.http.register("POST", "/models/refresh", async (request) => {
        const { id, auth } = requireInstance(request);
        const models = await auth.listModels(true);
        await context.providers.refresh(id);
        return models;
      });
      context.http.register("POST", "/sign-in", async (request) => {
        const { id: instanceId, auth } = requireInstance(request);
        const uiOrigin = request.origin;
        if (!uiOrigin) throw new Error("ChatGPT sign-in must be started from the Pico Web UI.");
        const operationId = randomUUID2();
        let server;
        let operation = null;
        let redirectUri;
        server = createServer((callbackRequest, callbackResponse) => {
          const callbackUrl = new URL(callbackRequest.url ?? "/", "http://127.0.0.1");
          if (callbackRequest.method !== "GET" || callbackUrl.pathname !== "/auth/callback") {
            callbackResponse.writeHead(404).end("Not found");
            return;
          }
          if (!operation) {
            callbackResponse.writeHead(503).end("Sign-in is not ready. Start again from Pico.");
            return;
          }
          if (operation.handlingCallback) {
            callbackResponse.writeHead(409).end("Authorization is already being completed.");
            return;
          }
          if (operation.retryCallback) {
            callbackResponse.writeHead(409).end("Return to Pico and retry the ChatGPT token exchange there.");
            return;
          }
          void completeCallback(operation, callbackUrl.searchParams).then(async (result) => {
            callbackResponse.writeHead(200, {
              "cache-control": "no-store",
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff"
            });
            callbackResponse.end(
              pluginAuthResultHtml(operationId, result.status, result.message, result.retryable, result.retryExchange),
              () => {
                if (!result.retryable) void closeCallbackServer(server);
              }
            );
          });
        });
        callbackServers.add(server);
        await new Promise((resolve2, reject) => {
          const onError = (error) => reject(error);
          server.once("error", onError);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve2();
          });
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          await closeCallbackServer(server);
          throw new Error("Could not start the local ChatGPT sign-in callback.");
        }
        redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
        operation = {
          operationId,
          instanceId,
          auth,
          redirectUri,
          server,
          handlingCallback: false,
          retryCallback: null,
          retryAttempted: false
        };
        callbackOperations.set(operationId, operation);
        try {
          const { authorizationUrl } = await auth.beginSignIn(redirectUri);
          const timeout = setTimeout(() => void closeCallbackServer(server), 10 * 6e4);
          timeout.unref();
          callbackTimeouts.set(server, timeout);
          return {
            authorizationUrl,
            callbackOrigin: `http://127.0.0.1:${address.port}`,
            operationId
          };
        } catch (error) {
          await closeCallbackServer(server);
          throw error;
        }
      });
      context.http.register("POST", "/sign-in/complete", async (request) => {
        const { id: instanceId, auth } = requireInstance(request);
        const { body } = request;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Paste the full ChatGPT callback URL from the browser address bar.");
        }
        const input = body;
        if (typeof input.operationId !== "string" || typeof input.callbackUrl !== "string" || input.callbackUrl.length > 8192) {
          throw new Error("Paste the full ChatGPT callback URL from the browser address bar.");
        }
        const operation = callbackOperations.get(input.operationId);
        if (!operation || operation.instanceId !== instanceId)
          throw new Error("This ChatGPT sign-in attempt is no longer active. Start again.");
        if (operation.retryCallback) {
          return {
            status: "failed",
            message: "The previous token request was not confirmed. Retry the token exchange below.",
            retryable: true,
            retryExchange: true
          };
        }
        const callback = auth.parseCallbackUrl(input.callbackUrl, operation.redirectUri);
        const result = await completeCallback(operation, callback);
        if (!result.retryable) await closeCallbackServer(operation.server);
        return result;
      });
      context.http.register("POST", "/sign-in/retry", async (request) => {
        const { id: instanceId } = requireInstance(request);
        const { body } = request;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("This ChatGPT sign-in cannot be retried. Start again.");
        }
        const input = body;
        if (Object.keys(input).length !== 1 || typeof input.operationId !== "string") {
          throw new Error("This ChatGPT sign-in cannot be retried. Start again.");
        }
        const operation = callbackOperations.get(input.operationId);
        if (!operation || operation.instanceId !== instanceId || !operation.retryCallback || operation.retryAttempted) {
          throw new Error("The ChatGPT token retry is no longer available. Start a new sign-in.");
        }
        operation.retryAttempted = true;
        const callback = operation.retryCallback;
        const result = await completeCallback(operation, callback, true);
        if (!result.retryable) await closeCallbackServer(operation.server);
        return result;
      });
      context.http.register("DELETE", "/account", async (request) => await requireInstance(request).auth.signOut());
    },
    async deactivate() {
      await Promise.all([...callbackServers].map((server) => closeCallbackServer(server)));
      authByInstance.clear();
      instanceAvailable = () => false;
      refreshCatalog = async () => void 0;
      for (const secrets of instanceSharedSecrets.values()) secrets.close();
      instanceSharedSecrets.clear();
      sharedOAuthSecrets?.close();
      sharedOAuthSecrets = null;
    }
  };
}
export {
  createChatGptPlanPlugin
};
export default createChatGptPlanPlugin();
