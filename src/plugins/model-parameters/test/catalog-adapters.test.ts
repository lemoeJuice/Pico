import { expect, it } from 'vitest';
import { PicoStore } from '../../../core/store.js';
import { ModelCatalog } from '../../../runtime/model-catalog.js';
import type { PluginContext } from '../../host.js';
import type { AdapterContribution } from '../../../contracts/model-catalog.js';
import { modelParametersPlugin } from '../index.js';

it('retains each legacy profile on its documented endpoint while rejecting lookalike endpoints', async () => {
  const { profiles } = await import('../providers/index.js');
  const samples: Array<[string, string, string, string, string]> = [
    [
      'openai.official.reasoning',
      'https://api.openai.com/v1',
      'openai-chat-completions',
      'gpt-6-astra',
      'openai-compatible',
    ],
    [
      'anthropic.messages.adaptive-effort',
      'https://api.anthropic.com/v1',
      'anthropic-messages',
      'claude-opus-4-6',
      'openai-compatible',
    ],
    [
      'google.gemini.openai-compatible-thinking',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'openai-chat-completions',
      'gemini-3-flash-preview',
      'openai-compatible',
    ],
    ['xai.grok.reasoning', 'https://api.x.ai/v1', 'openai-responses', 'grok-4.7', 'openai-compatible'],
    [
      'alibaba.model-studio.deepseek-v41-flash',
      'https://region.maas.aliyuncs.com/compatible-mode/v1',
      'openai-chat-completions',
      'deepseek-v4.1-flash',
      'openai-compatible',
    ],
    [
      'deepseek.official-api',
      'https://api.deepseek.com/v1',
      'openai-chat-completions',
      'deepseek-flash',
      'openai-compatible',
    ],
    [
      'alibaba.model-studio.qwen38',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'openai-chat-completions',
      'qwen3.8-max',
      'openai-compatible',
    ],
    [
      'mistral.official-api',
      'https://api.mistral.ai/v1',
      'openai-chat-completions',
      'mistral-large-4-0',
      'openai-compatible',
    ],
    [
      'asia-new.official-model-parameters',
      'https://api.z.ai/api/paas/v4',
      'openai-chat-completions',
      'glm-5.3',
      'openai-compatible',
    ],
    [
      'asia-new.official-model-parameters',
      'https://api.xiaomimimo.com/v1',
      'openai-responses',
      'mimo-v2.5',
      'openai-compatible',
    ],
    [
      'asia-new.official-model-parameters',
      'https://api.ant-ling.com/v1',
      'anthropic-messages',
      'Ring-2.6-1T',
      'openai-compatible',
    ],
    [
      'asia-new.official-model-parameters',
      'https://api.moonshot.ai/v1',
      'openai-chat-completions',
      'kimi-k3',
      'openai-compatible',
    ],
    [
      'asia-new.official-model-parameters',
      'https://api.stepfun.ai/v1',
      'openai-chat-completions',
      'step-5-preview',
      'openai-compatible',
    ],
    [
      'tencent.tokenhub.hy-reasoning',
      'https://tokenhub.tencentmaas.com/v1',
      'openai-chat-completions',
      'hy3',
      'openai-compatible',
    ],
    [
      'minimax.m31-flash-preview',
      'https://api.minimax.io/v1',
      'openai-chat-completions',
      'MiniMax-M3.1-Flash-Preview',
      'openai-compatible',
    ],
    [
      'tencent.tokenhub.minimax-thinking',
      'https://tokenhub.tencentmaas.com/v1',
      'openai-chat-completions',
      'minimax-m2.5',
      'openai-compatible',
    ],
    [
      'longcat.official-thinking',
      'https://api.longcat.chat/openai/v1',
      'openai-chat-completions',
      'LongCat-2.0',
      'openai-compatible',
    ],
    [
      'volcengine.ark.seed-reasoning',
      'https://ark.region.volces.com/api/v3',
      'openai-responses',
      'doubao-seed-evolving',
      'openai-compatible',
    ],
    [
      'nvidia-meta.official-reasoning',
      'https://integrate.api.nvidia.com/v1',
      'openai-chat-completions',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      'openai-compatible',
    ],
    [
      'nvidia-meta.official-reasoning',
      'http://localhost:8000/v1',
      'openai-chat-completions',
      'meta-models/Muse-Spark-Open-816B-A42B-NVFP4',
      'openai-compatible',
    ],
    [
      'nvidia-meta.official-reasoning',
      'https://api.meta.ai/v1',
      'openai-responses',
      'muse-wonder-1.0',
      'openai-compatible',
    ],
  ];
  const store = new PicoStore(':memory:');
  try {
    const catalog = new ModelCatalog(store);
    catalog.registerProviderType(
      'plugin',
      { id: 'test', label: 'Test', addPage: { pluginId: 'plugin', pageId: 'add' } },
      {
        listModels: async () =>
          samples.flatMap(([, endpoint, protocol, name], index) => [
            { id: String(index), name, label: name, endpoint, protocol, supportsImages: false },
            {
              id: `bad-${index}`,
              name,
              label: name,
              endpoint: 'https://lookalike.test/v1',
              protocol,
              supportsImages: false,
            },
          ]),
        authorize: async () => ({}),
      },
    );
    modelParametersPlugin.activate!({
      models: {
        registerAdapter: (entry: AdapterContribution) => catalog.registerAdapter('pico.model-parameters', entry),
      },
    } as unknown as PluginContext);
    const instance = catalog.addInstance('plugin', 'test', { label: 'Test', config: {} });
    const models = await catalog.refreshInstance(instance.id);
    for (const [index, [id, endpoint, protocol, name, provider]] of samples.entries()) {
      const profile = profiles.find((entry) => entry.id === id)!;
      const target = { endpoint, protocol: protocol as 'openai-chat-completions', model: name, provider };
      expect(profile.matches(target), id).toBe(true);
      const matching = catalog.matchingAdapters(models.find((entry) => entry.id === String(index))!.modelId);
      const selected = matching.find((entry) => entry.id === id);
      expect(selected, id).toBeDefined();
      expect(
        selected!.controls.map((entry) => entry.id),
        id,
      ).toEqual(profile.controls(target).map((entry) => entry.id));
      const defaults = Object.fromEntries(
        profile
          .controls(target)
          .filter((entry) => entry.defaultValue !== undefined)
          .map((entry) => [entry.id, entry.defaultValue!]),
      );
      const resolved = catalog.resolveSelection({
        modelId: models.find((entry) => entry.id === String(index))!.modelId,
        adapterId: id,
        parameters: { options: {} },
      });
      expect(resolved.requestParameters.fields, id).toEqual(profile.serialize(target, defaults, 1));
      const bad = models.find((entry) => entry.id === `bad-${index}`)!;
      expect(
        catalog.matchingAdapters(bad.modelId).some((entry) => entry.id === id),
        id,
      ).toBe(false);
    }
  } finally {
    store.close();
  }
});
