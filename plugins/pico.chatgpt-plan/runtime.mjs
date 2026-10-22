// src/plugins/chatgpt-plan.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { createServer } from "node:http";

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
    if (!credentials?.clientId || !credentials.refreshToken || !credentials.accessToken || !credentials.expiresAt) {
      throw new Error("Connect a ChatGPT account in Settings before using this model provider.");
    }
    if (!credentials.scopes.includes(planScope)) {
      throw new Error("The connected ChatGPT account has not granted plan usage to Pico. Reconnect it in Settings.");
    }
    if (!forceRefresh && credentials.expiresAt > this.now() + refreshAheadMs) return credentials.accessToken;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refresh(credentials, requestTrace).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
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
      if (unusableRefreshCodes.has(error)) {
        throw new UnusableChatGptRefreshToken("ChatGPT authorization expired. Reconnect your account in Settings.");
      }
      throw new Error(`ChatGPT token exchange failed (HTTP ${response.status}).`);
    }
    if (!isObject(payload)) {
      settle({
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        terminalEvent: "http_response",
        errorCategory: "protocol",
        errorCode: "invalid_token_response"
      });
      throw new Error("ChatGPT returned an invalid token response.");
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

// src/plugins/chatgpt-plan/model.ts
var responsesUrl = "https://api.openai.com/v1/responses";
var FETCH_FAILED_RETRY_INTERVAL_MS = 2e3;
var MAX_FETCH_FAILED_RETRIES = 5;
var RETRYABLE_FETCH_ERROR_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);
function responseInput(prompt) {
  const input = [];
  for (let index = 0; index < prompt.turns.length; index += 1) {
    const turn = prompt.turns[index];
    if (turn.kind === "message") {
      if (turn.role !== "assistant") {
        input.push({ role: turn.role, content: turn.content });
        continue;
      }
      const replay = reasoningItems(turn.reasoningReplay);
      input.push(...replay, { role: turn.role, content: turn.content });
      continue;
    }
    if (turn.kind === "assistant_tools") {
      input.push(
        ...reasoningItems(turn.reasoningReplay),
        ...turn.content ? [{ role: "assistant", content: turn.content }] : [],
        ...turn.calls.map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments)
        }))
      );
      continue;
    }
    const batchId = turn.batchId;
    const group = [turn];
    while (index + 1 < prompt.turns.length) {
      const next = prompt.turns[index + 1];
      if (next.kind !== "tool_result") break;
      if (batchId ? next.batchId !== batchId : Boolean(next.batchId)) break;
      group.push(next);
      index += 1;
    }
    input.push(
      ...group.map((result) => ({
        type: "function_call_output",
        call_id: result.callId,
        output: result.content
      }))
    );
    for (const result of group) {
      if (!result.images?.length) continue;
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: `Images returned by tool ${result.toolName} (call id ${result.callId}).` },
          ...result.images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.data}`
          }))
        ]
      });
    }
  }
  return input;
}
function reasoningItems(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const candidate = object(item);
    return candidate?.type === "reasoning" ? [candidate] : [];
  });
}
function responseTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readUsage(value) {
  const usage = object(value);
  if (!usage) return null;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : void 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : void 0;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : void 0;
  const inputDetails = object(usage.input_tokens_details);
  const cached = typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : void 0;
  const cacheWrite = typeof inputDetails?.cache_write_tokens === "number" ? inputDetails.cache_write_tokens : void 0;
  if (input === void 0 && output === void 0 && total === void 0 && cached === void 0 && cacheWrite === void 0)
    return null;
  return {
    ...input === void 0 ? {} : { inputTokens: input },
    ...output === void 0 ? {} : { outputTokens: output },
    ...total === void 0 ? {} : { totalTokens: total },
    ...cached === void 0 ? {} : { cachedInputTokens: cached },
    ...cacheWrite === void 0 ? {} : { cacheWriteTokens: cacheWrite }
  };
}
function parseArguments(value, name) {
  if (typeof value !== "string" || !value.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Model returned invalid arguments for tool ${name}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Tool arguments for ${name} must be a JSON object.`);
  }
  return parsed;
}
function outputFrom(response, prompt) {
  const output = Array.isArray(response.output) ? response.output : [];
  let content = "";
  const reasoningSummaryParts = [];
  const reasoningReplay = [];
  const toolCalls = [];
  for (const rawItem of output) {
    const item = object(rawItem);
    if (!item) continue;
    if (item.type === "reasoning") {
      reasoningReplay.push(item);
      if (Array.isArray(item.summary)) {
        for (const rawPart of item.summary) {
          const text = object(rawPart)?.text;
          if (typeof text === "string" && text.length > 0) reasoningSummaryParts.push(text);
        }
      }
    } else if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawContent of item.content) {
        const part = object(rawContent);
        if (part?.type === "output_text" && typeof part.text === "string") content += part.text;
        if (part?.type === "refusal" && typeof part.refusal === "string") content += part.refusal;
      }
    } else if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `call-${toolCalls.length}`,
        name: item.name,
        arguments: parseArguments(item.arguments, item.name)
      });
    }
  }
  const incomplete = object(response.incomplete_details);
  const reasoningSummary = reasoningSummaryParts.join("\n\n");
  return {
    content,
    ...reasoningSummary ? { reasoningSummary } : {},
    ...reasoningReplay.length > 0 ? { reasoningReplay } : {},
    toolCalls,
    usage: readUsage(response.usage),
    model: typeof response.model === "string" ? response.model : prompt.model,
    finishReason: response.status === "incomplete" ? incomplete?.reason === "max_output_tokens" ? "length" : "incomplete" : toolCalls.length > 0 ? "tool_calls" : "stop"
  };
}
function replayableReasoningItems(response, streamed) {
  const output = Array.isArray(response.output) ? response.output : [];
  const completedItems = output.flatMap((rawItem, outputIndex) => {
    const item = object(rawItem);
    if (item?.type !== "reasoning") return [];
    const streamedItem = streamed.get(outputIndex);
    if (!streamedItem) return [item];
    const merged = { ...streamedItem, ...item };
    if (typeof item.encrypted_content !== "string" && typeof streamedItem.encrypted_content === "string") {
      merged.encrypted_content = streamedItem.encrypted_content;
    }
    return [merged];
  });
  const items = completedItems.length > 0 ? completedItems : [...streamed.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
  return items.length > 0 ? items : void 0;
}
function finalFunctionCalls(response) {
  if (!Array.isArray(response.output)) return [];
  const calls = [];
  for (const [outputIndex, rawItem] of response.output.entries()) {
    const item = object(rawItem);
    if (item?.type !== "function_call" || typeof item.name !== "string") continue;
    calls.push({
      ...typeof item.id === "string" ? { itemId: item.id } : {},
      outputIndex,
      ...typeof item.call_id === "string" ? { callId: item.call_id } : {},
      ...typeof item.arguments === "string" ? { argumentsText: item.arguments } : {},
      toolCallIndex: calls.length
    });
  }
  return calls;
}
function errorCodeFrom(error) {
  let current = error;
  const visited = /* @__PURE__ */ new Set();
  for (let depth = 0; depth < 5 && current && typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = current.code;
    if (typeof code === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(code)) return code;
    current = current.cause;
  }
  return void 0;
}
function isRetryableFetchFailure(error) {
  const code = errorCodeFrom(error)?.toUpperCase();
  if (code) return RETRYABLE_FETCH_ERROR_CODES.has(code);
  return error instanceof TypeError && error.message.toLowerCase() === "fetch failed";
}
function waitForFetchRetry(signal) {
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  return new Promise((resolve, reject) => {
    let timeout;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, FETCH_FAILED_RETRY_INTERVAL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function withProviderErrorCode(error, code) {
  if (error instanceof Error && error.name === "AbortError") return error;
  const resolvedCode = errorCodeFrom(error) ?? (code && /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : void 0);
  if (!resolvedCode) return error;
  if (object(error)?.code === resolvedCode) return error;
  const message = error instanceof Error ? error.message : "ChatGPT model request failed.";
  const tagged = Object.assign(new Error(message), { cause: error, code: resolvedCode });
  if (error instanceof Error) tagged.name = error.name;
  return tagged;
}
function providerError(message, code) {
  return Object.assign(new Error(message), { code });
}
function outputItemCounts(response) {
  const counts = {};
  if (!Array.isArray(response.output)) return counts;
  for (const rawItem of response.output) {
    const item = object(rawItem);
    const type = typeof item?.type === "string" ? item.type : "unknown";
    if (/^[a-z0-9_.:-]{1,80}$/i.test(type)) counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}
var ChatGptResponsesAdapter = class {
  constructor(auth, fetcher = fetch) {
    this.auth = auth;
    this.fetcher = fetcher;
  }
  auth;
  fetcher;
  async complete(prompt, signal, onText, requestTrace, onEvent, requestParameters, threadId, promptCacheKey) {
    if (!prompt.model.trim()) throw new Error("Choose a ChatGPT model in Settings before sending a message.");
    const cacheKey = promptCacheKey ?? threadId;
    const body = {
      model: prompt.model,
      instructions: prompt.system,
      input: responseInput(prompt),
      store: false,
      stream: true,
      parallel_tool_calls: true,
      tools: responseTools(prompt.tools),
      reasoning: { summary: "auto" },
      ...requestParameters?.fields,
      include: ["reasoning.encrypted_content"],
      ...cacheKey ? { prompt_cache_key: cacheKey } : {}
    };
    let accessToken;
    try {
      accessToken = await this.auth.accessToken(false, requestTrace);
    } catch (error) {
      throw withProviderErrorCode(error, "auth");
    }
    const retryState = { attempt: 0, retries: 0 };
    let tracedRequest = await this.requestTraced(
      body,
      accessToken,
      signal,
      requestTrace,
      retryState,
      threadId,
      cacheKey
    );
    if (tracedRequest.response.status === 401) {
      await tracedRequest.response.body?.cancel().catch(() => void 0);
      try {
        accessToken = await this.auth.accessToken(true, requestTrace);
      } catch (error) {
        tracedRequest.settle({
          outcome: "failed",
          durationMs: Date.now() - tracedRequest.startedAt,
          terminalEvent: "http_response",
          errorCategory: "http",
          errorCode: "http_401"
        });
        throw withProviderErrorCode(error, "http_401");
      }
      tracedRequest.settle({
        outcome: "retrying",
        durationMs: Date.now() - tracedRequest.startedAt,
        terminalEvent: "http_response",
        errorCategory: "http",
        errorCode: "http_401"
      });
      tracedRequest = await this.requestTraced(body, accessToken, signal, requestTrace, retryState, threadId, cacheKey);
    }
    const response = tracedRequest.response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => void 0);
      tracedRequest.settle({
        outcome: "failed",
        durationMs: Date.now() - tracedRequest.startedAt,
        terminalEvent: "http_response",
        errorCategory: "http",
        errorCode: `http_${response.status}`
      });
      throw providerError(`ChatGPT model request returned HTTP ${response.status}.`, `http_${response.status}`);
    }
    if (!response.body) {
      tracedRequest.settle({
        outcome: "failed",
        durationMs: Date.now() - tracedRequest.startedAt,
        terminalEvent: "http_response",
        errorCategory: "protocol",
        errorCode: "empty_stream"
      });
      throw providerError("ChatGPT returned an empty Responses stream.", "empty_stream");
    }
    let reader;
    try {
      reader = response.body.getReader();
    } catch (error) {
      const interrupted = signal.aborted || error instanceof Error && error.name === "AbortError";
      tracedRequest.settle({
        outcome: interrupted ? "interrupted" : "failed",
        durationMs: Date.now() - tracedRequest.startedAt,
        errorCategory: interrupted ? "aborted" : "protocol",
        errorCode: interrupted ? "aborted" : "invalid_stream"
      });
      throw withProviderErrorCode(error, interrupted ? void 0 : "invalid_stream");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let eventData = [];
    let finalResponse = null;
    let streamedReasoningSummary = "";
    let previousReasoningSummaryKey = null;
    let streamFailure = null;
    let streamFailureCode;
    let failureCategory;
    let failureCode;
    let terminalEvent;
    const eventCounts = {};
    let firstTextMs;
    let deltaTextCharacters = 0;
    let ended = false;
    const streamedTextParts = /* @__PURE__ */ new Map();
    const streamedFunctionCalls = [];
    const streamedReasoningItems = /* @__PURE__ */ new Map();
    const callsByItemId = /* @__PURE__ */ new Map();
    const callsByOutputIndex = /* @__PURE__ */ new Map();
    const getStreamedCall = (itemId, outputIndex) => {
      const byItemId = itemId ? callsByItemId.get(itemId) : void 0;
      const byOutputIndex = outputIndex === void 0 ? void 0 : callsByOutputIndex.get(outputIndex);
      let call = byItemId ?? byOutputIndex;
      if (byItemId && byOutputIndex && byItemId !== byOutputIndex) {
        call = byItemId.order <= byOutputIndex.order ? byItemId : byOutputIndex;
        const duplicate = call === byItemId ? byOutputIndex : byItemId;
        if (call.itemId === void 0 && duplicate.itemId !== void 0) call.itemId = duplicate.itemId;
        if (call.outputIndex === void 0 && duplicate.outputIndex !== void 0)
          call.outputIndex = duplicate.outputIndex;
        if (call.callId === void 0 && duplicate.callId !== void 0) call.callId = duplicate.callId;
        if (call.name === void 0 && duplicate.name !== void 0) call.name = duplicate.name;
        if (duplicate.argumentsComplete && !call.argumentsComplete) {
          call.argumentsText = duplicate.argumentsText;
        } else if (!call.argumentsText) {
          call.argumentsText = duplicate.argumentsText;
        }
        call.argumentsComplete ||= duplicate.argumentsComplete;
        call.order = Math.min(call.order, duplicate.order);
        for (const [id, candidate] of callsByItemId) {
          if (candidate === duplicate) callsByItemId.set(id, call);
        }
        for (const [index, candidate] of callsByOutputIndex) {
          if (candidate === duplicate) callsByOutputIndex.set(index, call);
        }
        const duplicateIndex = streamedFunctionCalls.indexOf(duplicate);
        if (duplicateIndex >= 0) streamedFunctionCalls.splice(duplicateIndex, 1);
      }
      if (!call) {
        call = { argumentsText: "", argumentsComplete: false, order: streamedFunctionCalls.length };
        streamedFunctionCalls.push(call);
      }
      if (itemId) {
        call.itemId = itemId;
        callsByItemId.set(itemId, call);
      }
      if (outputIndex !== void 0) {
        call.outputIndex = outputIndex;
        callsByOutputIndex.set(outputIndex, call);
      }
      return call;
    };
    const recordStreamedCall = (event, item, completeArguments = false) => {
      const itemId = typeof event.item_id === "string" ? event.item_id : typeof item?.id === "string" ? item.id : void 0;
      const outputIndex = typeof event.output_index === "number" && Number.isInteger(event.output_index) ? event.output_index : void 0;
      const call = getStreamedCall(itemId, outputIndex);
      if (typeof item?.call_id === "string") call.callId = item.call_id;
      if (typeof item?.name === "string") call.name = item.name;
      if (completeArguments && typeof event.arguments === "string") {
        call.argumentsText = event.arguments;
        call.argumentsComplete = true;
      } else if (completeArguments && typeof item?.arguments === "string") {
        call.argumentsText = item.arguments;
        call.argumentsComplete = true;
      }
      return call;
    };
    const recordStreamedText = (event, text, append) => {
      const outputIndex = typeof event.output_index === "number" && Number.isInteger(event.output_index) ? event.output_index : Number.MAX_SAFE_INTEGER;
      const contentIndex = typeof event.content_index === "number" && Number.isInteger(event.content_index) ? event.content_index : Number.MAX_SAFE_INTEGER;
      const key = `${outputIndex}:${contentIndex}`;
      const existing = streamedTextParts.get(key);
      streamedTextParts.set(key, {
        outputIndex,
        contentIndex,
        order: existing?.order ?? streamedTextParts.size,
        text: append ? `${existing?.text ?? ""}${text}` : text
      });
    };
    const streamedText = () => [...streamedTextParts.values()].sort(
      (left, right) => left.outputIndex - right.outputIndex || left.contentIndex - right.contentIndex || left.order - right.order
    ).map((part) => part.text).join("");
    const countEvent = (name) => {
      if (/^[a-z0-9_.:-]{1,80}$/i.test(name)) eventCounts[name] = (eventCounts[name] ?? 0) + 1;
    };
    const consumeEvent = () => {
      if (eventData.length === 0) return;
      const data = eventData.join("\n");
      eventData = [];
      if (data === "[DONE]") {
        countEvent("done");
        terminalEvent = "done";
        ended = true;
        return;
      }
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        failureCategory = "protocol";
        failureCode = "invalid_json";
        throw new Error("ChatGPT returned invalid streaming JSON.");
      }
      const value = object(event);
      if (!value || typeof value.type !== "string") return;
      countEvent(value.type);
      if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
        if (value.delta.length > 0 && firstTextMs === void 0) firstTextMs = Date.now() - tracedRequest.startedAt;
        deltaTextCharacters += value.delta.length;
        recordStreamedText(value, value.delta, true);
        onText(value.delta);
      } else if (value.type === "response.reasoning_summary_text.delta" && typeof value.delta === "string") {
        const outputIndex = typeof value.output_index === "number" ? value.output_index : 0;
        const summaryIndex = typeof value.summary_index === "number" ? value.summary_index : 0;
        const summaryKey = `${outputIndex}:${summaryIndex}`;
        if (value.delta && previousReasoningSummaryKey !== null && previousReasoningSummaryKey !== summaryKey) {
          streamedReasoningSummary += "\n\n";
          onEvent?.({ type: "reasoning_summary.delta", delta: "\n\n" });
        }
        if (value.delta) previousReasoningSummaryKey = summaryKey;
        streamedReasoningSummary += value.delta;
        onEvent?.({ type: "reasoning_summary.delta", delta: value.delta });
      } else if (value.type === "response.output_text.done" && typeof value.text === "string") {
        recordStreamedText(value, value.text, false);
      } else if (value.type === "response.output_item.added") {
        const item = object(value.item);
        if (item?.type === "function_call") {
          const call = recordStreamedCall(value, item);
          onEvent?.({
            type: "tool_call.preview",
            index: call.outputIndex ?? call.order,
            ...call.callId ? { id: call.callId } : {},
            ...call.name ? { name: call.name } : {},
            argumentsText: call.argumentsText
          });
        }
      } else if (value.type === "response.function_call_arguments.delta" && typeof value.delta === "string") {
        const call = recordStreamedCall(value);
        call.argumentsText += value.delta;
        onEvent?.({
          type: "tool_call.preview",
          index: call.outputIndex ?? call.order,
          ...call.callId ? { id: call.callId } : {},
          ...call.name ? { name: call.name } : {},
          argumentsText: call.argumentsText
        });
      } else if (value.type === "response.function_call_arguments.done") {
        recordStreamedCall(value, void 0, true);
      } else if (value.type === "response.output_item.done") {
        const item = object(value.item);
        if (item?.type === "function_call") recordStreamedCall(value, item, true);
        if (item?.type === "reasoning" && typeof value.output_index === "number" && Number.isInteger(value.output_index)) {
          streamedReasoningItems.set(value.output_index, item);
        }
      } else if (value.type === "response.completed") {
        terminalEvent = value.type;
        finalResponse = object(value.response);
        ended = true;
      } else if (value.type === "response.failed" || value.type === "error") {
        const responseError = object(object(value.response)?.error);
        const error = object(value.error) ?? responseError;
        const code = typeof error?.code === "string" ? error.code : null;
        streamFailureCode = code && /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : void 0;
        streamFailure = streamFailureCode ? `ChatGPT model request failed (${streamFailureCode}).` : "ChatGPT model request failed.";
        terminalEvent = value.type;
        ended = true;
      } else if (value.type === "response.incomplete") {
        terminalEvent = value.type;
        finalResponse = object(value.response);
        ended = true;
      }
    };
    const processLines = (final = false) => {
      const lines = buffer.split(/\r?\n/);
      buffer = final ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line) consumeEvent();
        else if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
      }
      if (final) consumeEvent();
    };
    try {
      while (!ended) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          processLines(true);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        processLines();
      }
    } catch (error) {
      await reader.cancel().catch(() => void 0);
      const interrupted = signal.aborted || error instanceof Error && error.name === "AbortError";
      tracedRequest.settle({
        outcome: interrupted ? "interrupted" : "failed",
        durationMs: Date.now() - tracedRequest.startedAt,
        ...terminalEvent ? { terminalEvent } : {},
        errorCategory: interrupted ? "aborted" : failureCategory ?? "transport",
        ...(interrupted ? "aborted" : failureCode ?? errorCodeFrom(error)) ? { errorCode: interrupted ? "aborted" : failureCode ?? errorCodeFrom(error) } : {},
        eventCounts,
        ...firstTextMs === void 0 ? {} : { firstTextMs },
        deltaTextCharacters
      });
      throw withProviderErrorCode(
        error,
        interrupted ? void 0 : failureCode ?? errorCodeFrom(error) ?? "transport"
      );
    }
    await reader.cancel().catch(() => void 0);
    try {
      if (streamFailure) {
        failureCategory = "protocol";
        failureCode = streamFailureCode ?? "response_failed";
        throw new Error(streamFailure);
      }
      const completedResponse = finalResponse;
      if (!completedResponse) {
        failureCategory = "protocol";
        failureCode = "missing_completion";
        throw new Error("ChatGPT stream ended before the model step completed.");
      }
      if (completedResponse.status === "incomplete") {
        const incomplete = object(completedResponse.incomplete_details);
        if (incomplete?.reason !== "max_output_tokens") {
          failureCategory = "protocol";
          failureCode = typeof incomplete?.reason === "string" ? incomplete.reason : "incomplete";
          throw new Error(`ChatGPT response was incomplete (${failureCode}).`);
        }
      }
      const result = outputFrom(completedResponse, prompt);
      const reasoningReplay = replayableReasoningItems(completedResponse, streamedReasoningItems);
      if (reasoningReplay) result.reasoningReplay = reasoningReplay;
      if (!result.reasoningSummary && streamedReasoningSummary) result.reasoningSummary = streamedReasoningSummary;
      if (!result.content) result.content = streamedText();
      const finalCalls = finalFunctionCalls(completedResponse);
      for (const streamedCall of streamedFunctionCalls.sort((left, right) => left.order - right.order)) {
        const finalCall = finalCalls.find(
          (call) => streamedCall.callId !== void 0 && call.callId === streamedCall.callId || streamedCall.itemId !== void 0 && call.itemId === streamedCall.itemId || streamedCall.outputIndex !== void 0 && call.outputIndex === streamedCall.outputIndex
        );
        if (finalCall) {
          const finalArguments = finalCall.argumentsText;
          if ((!finalArguments || !finalArguments.trim()) && streamedCall.argumentsComplete) {
            const name = streamedCall.name;
            if (!name) {
              failureCategory = "protocol";
              failureCode = "missing_function_name";
              throw new Error("ChatGPT completed a function call without a tool name.");
            }
            result.toolCalls[finalCall.toolCallIndex] = {
              id: finalCall.callId ?? result.toolCalls[finalCall.toolCallIndex]?.id ?? streamedCall.callId ?? `call-${finalCall.toolCallIndex}`,
              name,
              arguments: parseArguments(streamedCall.argumentsText, name)
            };
          }
          continue;
        }
        if (!streamedCall.argumentsComplete) {
          failureCategory = "protocol";
          failureCode = "incomplete_function_call";
          throw new Error("ChatGPT streamed a function call without completing its arguments.");
        }
        if (!streamedCall.name) {
          failureCategory = "protocol";
          failureCode = "missing_function_name";
          throw new Error("ChatGPT completed a function call without a tool name.");
        }
        result.toolCalls.push({
          id: streamedCall.callId ?? `call-${result.toolCalls.length}`,
          name: streamedCall.name,
          arguments: parseArguments(streamedCall.argumentsText, streamedCall.name)
        });
      }
      if (completedResponse.status !== "incomplete" && result.toolCalls.length > 0) {
        result.finishReason = "tool_calls";
      }
      if (!result.content.trim() && result.toolCalls.length === 0) {
        failureCategory = "protocol";
        failureCode = "empty_output";
        throw new Error("ChatGPT completed a response without text or tool calls.");
      }
      tracedRequest.settle({
        outcome: "completed",
        durationMs: Date.now() - tracedRequest.startedAt,
        ...terminalEvent ? { terminalEvent } : {},
        eventCounts,
        ...firstTextMs === void 0 ? {} : { firstTextMs },
        deltaTextCharacters,
        outputTextCharacters: result.content.length,
        outputItemCounts: outputItemCounts(completedResponse),
        toolCallCount: result.toolCalls.length,
        finishReason: result.finishReason,
        ...typeof completedResponse.id === "string" ? { responseId: completedResponse.id } : {},
        usage: result.usage
      });
      return result;
    } catch (error) {
      const interrupted = signal.aborted || error instanceof Error && error.name === "AbortError";
      tracedRequest.settle({
        outcome: interrupted ? "interrupted" : "failed",
        durationMs: Date.now() - tracedRequest.startedAt,
        ...terminalEvent ? { terminalEvent } : {},
        errorCategory: interrupted ? "aborted" : failureCategory ?? "protocol",
        ...(interrupted ? "aborted" : failureCode ?? errorCodeFrom(error)) ? { errorCode: interrupted ? "aborted" : failureCode ?? errorCodeFrom(error) } : {},
        eventCounts,
        ...firstTextMs === void 0 ? {} : { firstTextMs },
        deltaTextCharacters
      });
      throw withProviderErrorCode(
        error,
        interrupted ? void 0 : failureCode ?? errorCodeFrom(error) ?? "response_failed"
      );
    }
  }
  async requestTraced(body, accessToken, signal, trace, retryState, threadId, promptCacheKey) {
    while (true) {
      const startedAt = Date.now();
      const attempt = ++retryState.attempt;
      const providerAttemptId = trace?.started({
        provider: "chatgpt-plan",
        protocol: "https+sse",
        endpoint: responsesUrl,
        attempt
      }) ?? "";
      let settled = false;
      const settle = (summary) => {
        if (settled) return;
        settled = true;
        if (providerAttemptId) trace?.settled(providerAttemptId, summary);
      };
      try {
        const response = await this.request(body, accessToken, signal, threadId, promptCacheKey);
        if (providerAttemptId) {
          const providerRequestId = response.headers.get("x-request-id") ?? response.headers.get("openai-request-id");
          trace?.response(providerAttemptId, {
            status: response.status,
            contentType: response.headers.get("content-type"),
            ...providerRequestId ? { providerRequestId } : {}
          });
        }
        return { response, startedAt, settle };
      } catch (error) {
        const interrupted = signal.aborted || error instanceof Error && error.name === "AbortError";
        const retryableFetchFailure = isRetryableFetchFailure(error);
        const shouldRetry = !interrupted && retryState.retries < MAX_FETCH_FAILED_RETRIES && retryableFetchFailure;
        const errorCode = interrupted ? "aborted" : errorCodeFrom(error) ?? (retryableFetchFailure ? "fetch_failed" : void 0);
        settle({
          outcome: interrupted ? "interrupted" : shouldRetry ? "retrying" : "failed",
          durationMs: Date.now() - startedAt,
          errorCategory: interrupted ? "aborted" : "transport",
          ...errorCode ? { errorCode } : {}
        });
        if (interrupted || !shouldRetry) {
          throw withProviderErrorCode(error, interrupted ? void 0 : errorCode ?? "transport");
        }
        retryState.retries += 1;
        await waitForFetchRetry(signal);
      }
    }
  }
  request(body, accessToken, signal, threadId, promptCacheKey) {
    const sessionId = promptCacheKey ?? threadId;
    return this.fetcher(responsesUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...sessionId ? { "session-id": sessionId } : {},
        ...threadId ? { "thread-id": threadId } : {}
      },
      body: JSON.stringify(body),
      signal
    });
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
function promptCacheKeyFor(input) {
  const call = input.pluginModelCall;
  if (!call) return input.thread.id;
  const digest = createHash2("sha256").update(JSON.stringify(["pico.chatgpt-plan.plugin-cache.v1", input.thread.id, call.pluginId, call.purpose])).digest("hex");
  return `pico-plugin:${digest.slice(0, 52)}`;
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
  let auth = null;
  const closeCallbackServer = (server) => {
    const timeout = callbackTimeouts.get(server);
    if (timeout) clearTimeout(timeout);
    callbackTimeouts.delete(server);
    callbackServers.delete(server);
    for (const [operationId, operation] of callbackOperations) {
      if (operation.server === server) callbackOperations.delete(operationId);
    }
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  };
  const completeCallback = async (operation, callback, retryExchange = false) => {
    if (operation.handlingCallback) {
      return {
        status: "failed",
        message: "Authorization is already being completed.",
        retryable: true,
        retryExchange: Boolean(operation.retryCallback)
      };
    }
    if (!auth.hasPendingAuthorization(callback.get("state"), operation.redirectUri)) {
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
      await auth.completeSignIn(callback, operation.redirectUri, { allowTransportRetry: !retryExchange });
      operation.retryCallback = null;
      void auth.refreshModels().catch(() => void 0);
      result = {
        status: "connected",
        message: "ChatGPT is connected. Return to Pico.",
        retryable: false,
        retryExchange: false
      };
    } catch (error) {
      const pending = auth.hasPendingAuthorization(callback.get("state"), operation.redirectUri);
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
      auth = new ChatGptPlanAuth(context.state, fetch, Date.now, context.secrets, context.cache);
      const model = new ChatGptResponsesAdapter(auth);
      context.models.registerProvider(
        {
          id: "chatgpt-plan",
          label: "ChatGPT account",
          description: "Use a ChatGPT plan account through OpenAI\u2019s Responses API.",
          supportsImages: true
        },
        async (input) => {
          input.recordModelInput(input.prompt, input.provider, input.projectionProvenance);
          return model.complete(
            input.prompt,
            input.signal,
            input.onText,
            input.requestTrace,
            input.onEvent,
            input.requestParameters,
            input.thread.id,
            promptCacheKeyFor(input)
          );
        }
      );
      context.commands.register({
        name: "chatgpt-provider",
        description: "Show whether the ChatGPT account provider is connected.",
        execute() {
          const status = auth?.status();
          return {
            text: status?.connected ? `ChatGPT account connected${status.accountLabel ? ` as ${status.accountLabel}` : ""}.` : "No ChatGPT account is connected. Open the ChatGPT plugin settings to connect one."
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
      context.ui.contribute({
        slot: "composer.model",
        id: "model-controls",
        label: "ChatGPT model controls",
        description: "Choose the ChatGPT model, reasoning effort, and Fast mode for this provider.",
        entry: "webui",
        component: "ChatGptPlanComposerModel",
        providers: ["chatgpt-plan"],
        externalAuthOrigins: ["https://auth.openai.com"]
      });
      context.http.register("GET", "/status", () => auth.status());
      context.http.register("GET", "/models", async () => await auth.listModels());
      context.http.register("POST", "/models/refresh", async () => await auth.listModels(true));
      context.http.register("POST", "/sign-in", async (request) => {
        const uiOrigin = request.origin;
        if (!uiOrigin) throw new Error("ChatGPT sign-in must be started from the Pico Web UI.");
        const operationId = randomUUID2();
        let server;
        let operation = null;
        let redirectUri = "";
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
        await new Promise((resolve, reject) => {
          const onError = (error) => reject(error);
          server.once("error", onError);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve();
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
      context.http.register("POST", "/sign-in/complete", async ({ body }) => {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Paste the full ChatGPT callback URL from the browser address bar.");
        }
        const input = body;
        if (typeof input.operationId !== "string" || typeof input.callbackUrl !== "string" || input.callbackUrl.length > 8192) {
          throw new Error("Paste the full ChatGPT callback URL from the browser address bar.");
        }
        const operation = callbackOperations.get(input.operationId);
        if (!operation) throw new Error("This ChatGPT sign-in attempt is no longer active. Start again.");
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
      context.http.register("POST", "/sign-in/retry", async ({ body }) => {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("This ChatGPT sign-in cannot be retried. Start again.");
        }
        const input = body;
        if (Object.keys(input).length !== 1 || typeof input.operationId !== "string") {
          throw new Error("This ChatGPT sign-in cannot be retried. Start again.");
        }
        const operation = callbackOperations.get(input.operationId);
        if (!operation || !operation.retryCallback || operation.retryAttempted) {
          throw new Error("The ChatGPT token retry is no longer available. Start a new sign-in.");
        }
        operation.retryAttempted = true;
        const callback = operation.retryCallback;
        const result = await completeCallback(operation, callback, true);
        if (!result.retryable) await closeCallbackServer(operation.server);
        return result;
      });
      context.http.register("DELETE", "/account", async () => await auth.signOut());
    },
    async deactivate() {
      await Promise.all([...callbackServers].map((server) => closeCallbackServer(server)));
      auth = null;
    }
  };
}
export {
  createChatGptPlanPlugin
};
