import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';
import type { ProviderInstance } from '../../../contracts/model-catalog.js';

describe('ChatGPT Plan Runtime integration', () => {
  it('keeps each Thread selection independent across ChatGPT Provider instances and keeps OAuth private', async () => {
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
      expect(env.runtime.modelCatalogView().providerTypes).toContainEqual(
        expect.objectContaining({ id: 'chatgpt-plan' }),
      );
      expect(env.runtime.availableCommands()).toContainEqual(expect.objectContaining({ name: 'chatgpt-provider' }));
      const create = env.runtime.pluginHttpRoute('pico.chatgpt-plan', 'POST', '/instances')!;
      const first = (await create.handler({
        body: { label: 'First' },
        query: new URLSearchParams(),
        origin: null,
      })) as ProviderInstance;
      const second = (await create.handler({
        body: { label: 'Second' },
        query: new URLSearchParams(),
        origin: null,
      })) as ProviderInstance;
      for (const [index, instance] of [first, second].entries()) {
        env.runtime.modelCatalog.getInstanceSecrets('pico.chatgpt-plan', instance.id).set('oauth', {
          hostId: 'urn:uuid:fake',
          clientId: 'fake-client',
          subject: 'fake-user',
          email: 'fake@example.test',
          idToken: 'fake-id-secret',
          accessToken: 'fake-access-secret',
          refreshToken: 'fake-refresh-secret',
          expiresAt: Date.now() + 3600000,
          scopes: ['chatgpt.tokens.use.direct'],
        });
        env.store.setPluginCache('pico.chatgpt-plan', `instance:${instance.id}:modelCatalog`, {
          models: [{ slug: index === 0 ? 'gpt-6-astra' : 'gpt-6-luna', displayName: 'Same model' }],
          refreshedAt: Date.now(),
        });
        await env.runtime.modelCatalog.refreshInstance(instance.id);
      }
      const models = env.runtime.modelCatalog
        .listModels()
        .filter((model) => model.instanceId === first.id || model.instanceId === second.id);
      expect(models).toHaveLength(2);
      const firstModel = models.find((model) => model.instanceId === first.id)!;
      const secondModel = models.find((model) => model.instanceId === second.id)!;
      const adapter = env.runtime.modelCatalog
        .matchingAdapters(firstModel.modelId)
        .find((entry) => entry.id === 'openai.chatgpt-plan.responses')!;
      expect(adapter.owner).toBe('pico.chatgpt-plan');
      expect(adapter.controls.map((control) => control.id)).toEqual(['reasoningEffort', 'fastMode']);
      expect(adapter.controls[0]!.choices).not.toContain('none');
      const secondAdapter = env.runtime.modelCatalog
        .matchingAdapters(secondModel.modelId)
        .find((entry) => entry.id === 'openai.chatgpt-plan.responses')!;
      expect(secondAdapter.controls[0]!.choices).toContain('none');
      expect(() =>
        env.runtime.modelCatalog.resolveSelection({
          modelId: firstModel.modelId,
          adapterId: adapter.id,
          parameters: { options: { reasoningEffort: 'none' } },
        }),
      ).toThrow();
      expect(
        env.runtime.modelCatalog.resolveSelection({
          modelId: secondModel.modelId,
          adapterId: secondAdapter.id,
          parameters: { options: { reasoningEffort: 'none' } },
        }).requestParameters,
      ).toEqual({ fields: { reasoning: { summary: 'auto', effort: 'none' } }, temperature: null });
      expect(
        env.runtime.modelCatalog.resolveSelection({
          modelId: firstModel.modelId,
          adapterId: adapter.id,
          parameters: { options: { reasoningEffort: 'high', fastMode: true } },
        }).requestParameters,
      ).toEqual({
        fields: { reasoning: { summary: 'auto', effort: 'high' }, service_tier: 'priority' },
        temperature: null,
      });
      await env.runtime.plugins.setEnabled('pico.model-parameters', false);
      const chatGptAdapterAfterDisable = env.runtime.modelCatalog
        .matchingAdapters(firstModel.modelId)
        .find((entry) => entry.id === 'openai.chatgpt-plan.responses')!;
      expect(chatGptAdapterAfterDisable.owner).toBe('pico.chatgpt-plan');
      expect(
        env.runtime.modelCatalog.resolveSelection({
          modelId: firstModel.modelId,
          adapterId: chatGptAdapterAfterDisable.id,
          parameters: { options: { reasoningEffort: 'high', fastMode: true } },
        }).requestParameters,
      ).toEqual({
        fields: { reasoning: { summary: 'auto', effort: 'high' }, service_tier: 'priority' },
        temperature: null,
      });
      expect(firstModel.modelId).not.toBe(secondModel.modelId);
      const threadA = env.createThread('runtime', 'A');
      const threadB = env.createThread('runtime', 'B');
      env.runtime.updateThreadModelSelection(threadA.id, {
        modelId: firstModel.modelId,
        adapterId: 'openai.chatgpt-plan.responses',
        parameters: { options: {} },
      });
      env.runtime.updateThreadModelSelection(threadB.id, {
        modelId: secondModel.modelId,
        adapterId: 'openai.chatgpt-plan.responses',
        parameters: { options: {} },
      });
      expect(env.runtime.threadModelSelection(threadA.id)).toMatchObject({
        modelId: firstModel.modelId,
        connectionId: first.id,
      });
      expect(env.runtime.threadModelSelection(threadB.id)).toMatchObject({
        modelId: secondModel.modelId,
        connectionId: second.id,
      });
      const publicView = JSON.stringify({
        catalog: env.runtime.modelCatalogView(),
        first: env.runtime.threadModelSelection(threadA.id),
        settings: env.runtime.publicModelSettings(),
      });
      expect(publicView).not.toContain('fake-access-secret');
      expect(publicView).not.toContain('fake-refresh-secret');
      expect(publicView).not.toContain('fake-id-secret');
    } finally {
      await env.cleanup();
    }
  });
});
