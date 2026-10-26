import { describe, expect, it } from 'vitest';
import { ChatGptPlanAuth, type ChatGptPluginState } from '../auth.js';

describe('ChatGPT model catalog cache', () => {
  it('persists the fetched catalog and serves it when a later refresh hits a network failure', async () => {
    const state = new Map<string, unknown>([
      [
        'oauth',
        {
          hostId: 'urn:uuid:pico-test',
          clientId: 'dynamic_agent_client',
          subject: 'chatgpt-user-1',
          email: 'pico-user@example.test',
          idToken: 'id-token',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: 2_000_000,
          scopes: ['chatgpt.tokens.use.direct'],
        },
      ],
    ]);
    const pluginState: ChatGptPluginState = {
      get<T>(key: string, fallback: T): T {
        return state.has(key) ? (state.get(key) as T) : fallback;
      },
      set<T>(key: string, value: T): void {
        state.set(key, value);
      },
    };
    const now = 1_000_000;
    const firstAuth = new ChatGptPlanAuth(
      pluginState,
      async () =>
        new Response(
          JSON.stringify({
            models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT 6.1 Sol', visibility: 'list' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      () => now,
    );
    const models = await firstAuth.listModels(true);

    const restartedAuth = new ChatGptPlanAuth(
      pluginState,
      (async () => {
        throw new Error('fetch failed');
      }) as typeof fetch,
      () => now + 1,
    );
    await expect(restartedAuth.listModels(true)).resolves.toEqual(models);
    expect(state.get('modelCatalog')).toMatchObject({ models, refreshedAt: now });
  });
});
