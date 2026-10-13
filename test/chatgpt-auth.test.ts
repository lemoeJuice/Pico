import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChatGptPlanAuth, type ChatGptPluginState } from '../src/plugins/chatgpt-plan/auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...(publicKey.export({ format: 'jwk' }) as JsonWebKey),
  kid: 'pico-test-key',
  alg: 'RS256',
  use: 'sig',
};
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function identityToken(clientId: string, nonce: string, now: number): string {
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid: 'pico-test-key' });
  const payload = base64url({
    iss: 'https://auth.openai.com',
    aud: clientId,
    sub: 'chatgpt-user-1',
    email: 'pico-user@example.test',
    exp: Math.floor(now / 1000) + 3600,
    nonce,
  });
  const content = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
  return `${content}.${signature}`;
}

class MemoryPluginState implements ChatGptPluginState {
  values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }
  set<T>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

describe('Sign in with ChatGPT credentials', () => {
  it('validates PKCE callback state, OIDC identity and scope, then refreshes rotating tokens once', async () => {
    const state = new MemoryPluginState();
    const now = { value: 1_800_000_000_000 };
    const tokenRequests: URLSearchParams[] = [];
    let refreshRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        });
      }
      if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
      if (url.pathname === '/api/accounts/oauth/token') {
        const request = new URLSearchParams(String(init?.body));
        tokenRequests.push(request);
        if (request.get('grant_type') === 'authorization_code') {
          return Response.json({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            id_token: identityToken(request.get('client_id')!, authorization.searchParams.get('nonce')!, now.value),
            token_type: 'Bearer',
            expires_in: 3600,
            scope: scopes,
          });
        }
        refreshRequests += 1;
        return Response.json({
          access_token: `access-${refreshRequests + 1}`,
          refresh_token: `refresh-${refreshRequests + 1}`,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (url.pathname === '/api/accounts/oauth/revoke') return new Response(null, { status: 200 });
      if (url.pathname === '/v1/models') {
        return Response.json({
          models: [
            {
              slug: 'gpt-6.1-sol',
              display_name: 'GPT 6.1 Sol',
              visibility: 'list',
            },
            { slug: 'internal-preview', display_name: 'Internal', visibility: 'hidden' },
          ],
        });
      }
      throw new Error(`Unexpected mocked request: ${url}`);
    };
    const auth = new ChatGptPlanAuth(state, fetcher, () => now.value);
    const redirectUri = 'http://127.0.0.1:14555/auth/callback';
    const { authorizationUrl } = await auth.beginSignIn(redirectUri);
    const authorization = new URL(authorizationUrl);
    expect(authorization.origin).toBe('https://auth.openai.com');
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorization.searchParams.get('agent_name_hint')).toBe('Pico');
    expect(authorization.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(authorization.searchParams.has('client_secret')).toBe(false);

    const oauthState = authorization.searchParams.get('state')!;
    const connected = await auth.completeSignIn(
      new URLSearchParams({
        state: oauthState,
        code: 'one-time-code',
        client_id: 'oaiapp_pico_test',
        scope: scopes,
      }),
      redirectUri,
    );
    expect(connected).toEqual({ connected: true, accountLabel: 'pico-user@example.test' });
    expect(tokenRequests[0]?.get('grant_type')).toBe('authorization_code');
    expect(tokenRequests[0]?.get('client_id')).toBe('oaiapp_pico_test');
    expect(tokenRequests[0]?.get('code')).toBe('one-time-code');
    expect(tokenRequests[0]?.get('redirect_uri')).toBe(redirectUri);
    expect(tokenRequests[0]?.get('resource')).toBe('https://api.openai.com/v1');
    expect(tokenRequests[0]?.get('code_verifier')).toBeTruthy();
    expect(state.get<Record<string, unknown>>('oauth', {}).refreshToken).toBe('refresh-1');

    await expect(
      auth.completeSignIn(
        new URLSearchParams({ state: oauthState, code: 'replayed', client_id: 'oaiapp_pico_test' }),
        redirectUri,
      ),
    ).rejects.toThrow('expired or did not match');

    now.value += 3_600_000;
    await expect(Promise.all([auth.accessToken(), auth.accessToken()])).resolves.toEqual(['access-2', 'access-2']);
    expect(refreshRequests).toBe(1);
    expect(tokenRequests.at(-1)?.get('refresh_token')).toBe('refresh-1');
    expect(state.get<Record<string, unknown>>('oauth', {}).refreshToken).toBe('refresh-2');

    await expect(auth.listModels()).resolves.toEqual([{ slug: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol' }]);
    expect(auth.status().connected).toBe(true);

    const reauthorization = new URL((await auth.beginSignIn(redirectUri)).authorizationUrl);
    expect(reauthorization.searchParams.get('client_id')).toBe('oaiapp_pico_test');
    expect(reauthorization.searchParams.get('id_token_hint')).toBeTruthy();
    expect(reauthorization.searchParams.get('login_hint')).toBe('pico-user@example.test');
    expect(reauthorization.searchParams.has('agent_name_hint')).toBe(false);
    await expect(
      auth.completeSignIn(
        new URLSearchParams({ state: reauthorization.searchParams.get('state')!, error: 'access_denied' }),
        redirectUri,
      ),
    ).rejects.toThrow('cancelled');
    expect(auth.status().connected).toBe(true);

    await expect(auth.signOut()).resolves.toEqual({ remoteRevoked: true });
    expect(auth.status()).toEqual({ connected: false, accountLabel: null });
    const retained = state.get<Record<string, unknown>>('oauth', {});
    expect(retained.clientId).toBe('oaiapp_pico_test');
    expect(retained.refreshToken).toBeNull();
  });

  it('does not save credentials when ChatGPT plan scope is missing', async () => {
    const state = new MemoryPluginState();
    const now = 1_800_000_000_000;
    let authorization: URL | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
        });
      }
      if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
      if (url.pathname === '/api/accounts/oauth/token') {
        const request = new URLSearchParams(String(init?.body));
        return Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          id_token: identityToken(request.get('client_id')!, authorization!.searchParams.get('nonce')!, now),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke',
        });
      }
      throw new Error(`Unexpected mocked request: ${url}`);
    };
    const auth = new ChatGptPlanAuth(state, fetcher, () => now);
    const result = await auth.beginSignIn('http://127.0.0.1:14556/auth/callback');
    authorization = new URL(result.authorizationUrl);

    await expect(
      auth.completeSignIn(
        new URLSearchParams({
          state: authorization.searchParams.get('state')!,
          code: 'one-time-code',
          client_id: 'oaiapp_no_plan',
          scope: scopes,
        }),
        'http://127.0.0.1:14556/auth/callback',
      ),
    ).rejects.toThrow('did not authorize plan usage');
    expect(auth.status().connected).toBe(false);
  });

  it('preserves credentials during transient refresh failures and clears an unusable rotating token', async () => {
    const state = new MemoryPluginState();
    state.set('oauth', {
      hostId: 'urn:uuid:pico-test',
      clientId: 'oaiapp_pico_test',
      subject: 'chatgpt-user-1',
      email: 'pico-user@example.test',
      idToken: 'retained-id-token',
      accessToken: 'expired-access-token',
      refreshToken: 'still-live-refresh-token',
      expiresAt: 1,
      scopes: scopes.split(' '),
    });
    let refreshError = 'temporarily_unavailable';
    const auth = new ChatGptPlanAuth(state, async () => Response.json({ error: refreshError }, { status: 503 }));

    await expect(auth.accessToken(true)).rejects.toThrow('HTTP 503');
    expect(auth.status().connected).toBe(true);
    expect(state.get<Record<string, unknown>>('oauth', {}).refreshToken).toBe('still-live-refresh-token');

    refreshError = 'invalid_grant';
    await expect(auth.accessToken(true)).rejects.toThrow('Reconnect your account');
    expect(auth.status()).toEqual({ connected: false, accountLabel: null });
    const expired = state.get<Record<string, unknown>>('oauth', {});
    expect(expired.refreshToken).toBeNull();
    expect(expired.accessToken).toBeNull();
    expect(expired.idToken).toBe('retained-id-token');
  });
});
