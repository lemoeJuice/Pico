import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

describe('ChatGPT Plan Runtime integration', () => {
  it('keeps model selections separate across provider switches, including existing saved settings', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')), {
      pluginDirectory: resolve(process.cwd(), 'plugins'),
    });
    try {
      // Simulate a pre-existing connection before provider model history was introduced.
      const legacy = { ...env.runtime.getModelSettings(), model: 'custom-api-model', apiKey: 'saved-api-key' };
      env.store.setSetting('model', legacy);
      expect(env.runtime.updateModelSettings({ provider: 'chatgpt-plan' }).model).toBe('');
      env.runtime.updateModelSettings({ model: 'account-model' });
      expect(env.runtime.updateModelSettings({ provider: 'openai-compatible' }).model).toBe('custom-api-model');
      expect(env.runtime.getModelSettings().apiKey).toBe('saved-api-key');
      env.runtime.updateModelSettings({ model: 'other-api-model' });
      expect(env.runtime.updateModelSettings({ provider: 'chatgpt-plan' }).model).toBe('account-model');
      expect(env.runtime.publicModelSettings().modelsByProvider).toEqual({
        'openai-compatible': 'other-api-model',
        'chatgpt-plan': 'account-model',
      });
      expect(() => env.runtime.updateModelSettings({ provider: 'unknown' })).toThrow('not registered');
      expect(env.runtime.publicModelSettings().model).toBe('account-model');
      expect(
        env.runtime.updateModelSettings({ provider: 'openai-compatible', model: 'explicit-api-model' }).model,
      ).toBe('explicit-api-model');
      expect(env.runtime.updateModelSettings({ provider: 'chatgpt-plan' }).model).toBe('account-model');
      expect(env.runtime.updateModelSettings({ provider: 'openai-compatible' }).model).toBe('explicit-api-model');
    } finally {
      await env.cleanup();
    }
  });

  it('loads the ChatGPT provider as a first-party plugin and keeps OAuth secrets private', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')), {
      pluginDirectory: resolve(process.cwd(), 'plugins'),
    });
    try {
      const info = env.runtime.pluginInfo();
      expect(info.plugins.some((plugin) => plugin.id === 'pico.chatgpt-plan')).toBe(true);
      expect(
        info.pipelines.some((pipeline) => pipeline.stage === 'model' && pipeline.pluginId === 'pico.chatgpt-plan'),
      ).toBe(false);
      expect(info.pages).toContainEqual(
        expect.objectContaining({ id: 'account', pluginId: 'pico.chatgpt-plan', entry: 'webui' }),
      );
      expect(info.providers).toContainEqual(expect.objectContaining({ id: 'chatgpt-plan' }));
      expect(env.runtime.availableCommands()).toContainEqual(expect.objectContaining({ name: 'chatgpt-provider' }));

      env.store.setPluginState('pico.chatgpt-plan', 'oauth', {
        hostId: 'urn:uuid:pico-test',
        clientId: 'oaiapp_pico_test',
        subject: 'chatgpt-user-1',
        email: 'pico-user@example.test',
        idToken: 'id-token-secret',
        accessToken: 'access-token-secret',
        refreshToken: 'refresh-token-secret',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      });
      const publicSettings = env.runtime.publicModelSettings();
      expect(JSON.stringify(publicSettings)).not.toContain('token-secret');
      expect(publicSettings.provider).toBe('openai-compatible');
    } finally {
      await env.cleanup();
    }
  });
});
