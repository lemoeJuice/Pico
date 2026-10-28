import { describe, expect, it } from 'vitest';
import type { PluginContext } from '../../../plugins/host.js';
import { createChatGptPlanPlugin } from '../../../plugins/chatgpt-plan.js';

describe('ChatGPT provider plugin', () => {
  it('registers the account provider and routes without a model pipeline or composer control', async () => {
    const types: unknown[] = [];
    const pages: unknown[] = [];
    const routes: string[] = [];
    const contributions: unknown[] = [];
    const context = {
      providers: {
        registerType: (type: unknown, driver: unknown) => types.push({ type, driver }),
        list: () => [],
        get: () => undefined,
        refresh: async () => undefined,
      },
      state: { get: <T>(_key: string, fallback: T) => fallback },
      cache: { get: <T>(_key: string, fallback: T) => fallback },
      secrets: { get: <T>(_key: string, fallback: T) => fallback },
      commands: { register() {} },
      ui: {
        contribute: (item: unknown) => contributions.push(item),
        registerPage: (item: unknown) => pages.push(item),
      },
      http: { register: (method: string, path: string) => routes.push(`${method} ${path}`) },
    };
    const plugin = createChatGptPlanPlugin();
    await plugin.activate?.(context as unknown as PluginContext);
    expect(types).toContainEqual({
      type: expect.objectContaining({
        id: 'chatgpt-plan',
        addPage: { pluginId: 'pico.chatgpt-plan', pageId: 'account' },
      }),
      driver: expect.objectContaining({ listModels: expect.any(Function), authorize: expect.any(Function) }),
    });
    expect(pages).toContainEqual(expect.objectContaining({ id: 'account', entry: 'webui' }));
    expect(contributions).toEqual([]);
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /instances',
        'POST /instances',
        'GET /status',
        'GET /models',
        'POST /models/refresh',
        'POST /sign-in',
        'POST /sign-in/complete',
        'POST /sign-in/retry',
        'DELETE /account',
      ]),
    );
    await plugin.deactivate?.();
  });
});
