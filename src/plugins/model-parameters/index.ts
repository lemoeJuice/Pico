import type {
  AdapterContribution,
  AdapterControl,
  AdapterTemperature,
  CatalogModel,
} from '../../contracts/model-catalog.js';
import type { PicoPlugin } from '../host.js';
import type {
  ModelParameterControl,
  ModelParameterProfile,
  ModelParameterTarget,
  TemperatureCapability,
} from './types.js';
import { chatGptParameterProfile } from './providers/chatgpt.js';
import { coreVendorProfiles } from './providers/core-vendors.js';
import { asiaNewParameterProfile } from './providers/asia-new.js';
import { asiaParameterProfiles } from './providers/asia-parameters.js';
import { nvidiaMetaParameterProfile } from './providers/nvidia-meta.js';
import { asiaCoreParameterProfiles } from './providers/asia-core.js';

const CHAT = 'openai-chat-completions';
const RESPONSES = 'openai-responses';
const target = (model: CatalogModel, provider = 'openai-compatible'): ModelParameterTarget => ({
  provider,
  endpoint: model.endpoint,
  protocol: model.protocol as ModelParameterTarget['protocol'],
  model: model.name,
});
function control(value: ModelParameterControl): AdapterControl {
  return {
    id: value.id,
    label: value.label,
    type: value.kind === 'toggle' ? 'boolean' : value.kind === 'range' ? 'number' : 'string',
    ...(value.options
      ? {
          choices: value.options.map((option) => option.value),
          choiceLabels: Object.fromEntries(value.options.map((option) => [option.value, option.label])),
        }
      : {}),
    ...(value.defaultValue !== undefined ? { defaultValue: value.defaultValue } : {}),
    ...(value.min !== undefined ? { min: value.min } : {}),
    ...(value.max !== undefined ? { max: value.max } : {}),
    ...(value.step !== undefined ? { step: value.step } : {}),
    group: value.group,
    ...(value.description ? { description: value.description } : {}),
  };
}
function temperature(value: TemperatureCapability): AdapterTemperature {
  if (value.mode === 'adjustable')
    return {
      supported: true,
      min: value.min,
      max: value.max,
      step: value.step,
      ...(value.description ? { description: value.description } : {}),
    };
  return {
    supported: false,
    ...(value.mode === 'fixed' ? { fixedValue: value.value } : {}),
    ...(value.description ? { description: value.description } : {}),
  };
}
function adapter(
  profile: ModelParameterProfile,
  match: AdapterContribution['match'],
  provider = 'openai-compatible',
  protocolTraits?: AdapterContribution['protocolTraits'],
): AdapterContribution {
  return {
    id: profile.id,
    label: profile.id,
    replayFormat: 'openai-responses',
    match,
    controls: [],
    temperature: { supported: false },
    ...(protocolTraits ? { protocolTraits } : {}),
    controlsForModel: (model) => profile.controls(target(model, provider)).map(control),
    temperatureForModel: (model) => temperature(profile.temperature(target(model, provider))),
    normalize(model, parameters) {
      const defaults = Object.fromEntries(
        profile
          .controls(target(model, provider))
          .filter((item) => item.defaultValue !== undefined)
          .map((item) => [item.id, item.defaultValue!]),
      );
      return { ...parameters, options: { ...defaults, ...parameters.options } };
    },
    serialize(model, parameters) {
      const capability = profile.temperature(target(model, provider));
      const temp =
        capability.mode === 'adjustable'
          ? parameters.temperature
          : capability.mode === 'fixed'
            ? capability.value
            : null;
      return {
        fields: profile.serialize(target(model, provider), parameters.options, temp ?? 1),
        ...(temp !== undefined ? { temperature: temp } : {}),
      };
    },
  };
}
const byId = (profiles: ModelParameterProfile[], id: string): ModelParameterProfile => {
  const found = profiles.find((profile) => profile.id === id);
  if (!found) throw new Error('Missing built-in model profile');
  return found;
};
const standardAdapters: AdapterContribution[] = [
  {
    id: 'pico.chat-completions',
    label: 'Generic Chat Completions',
    match: { protocols: [CHAT] },
    controls: [],
    temperature: { supported: true, min: 0, max: 2, step: 0.1 },
  },
  {
    id: 'pico.responses',
    label: 'Generic Responses',
    match: { protocols: [RESPONSES] },
    controls: [],
    temperature: { supported: true, min: 0, max: 2, step: 0.1 },
    replayFormat: 'openai-responses',
  },
  adapter(chatGptParameterProfile, { providerTypeIds: ['chatgpt-plan'], protocols: [RESPONSES] }, 'chatgpt-plan'),
  adapter(byId(coreVendorProfiles, 'openai.official.reasoning'), {
    endpointOrigins: ['https://api.openai.com'],
    endpointVersionedApiPath: true,
    protocols: [CHAT, RESPONSES],
    names: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  }),
  adapter(byId(coreVendorProfiles, 'anthropic.messages.adaptive-effort'), {
    endpointOrigins: ['https://api.anthropic.com'],
    endpointPaths: ['/v1'],
    protocols: ['anthropic-messages'],
    names: [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-haiku-5-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ],
  }),
  adapter(byId(coreVendorProfiles, 'google.gemini.openai-compatible-thinking'), {
    endpointOrigins: ['https://generativelanguage.googleapis.com'],
    endpointVersionedApiPath: true,
    protocols: [CHAT],
    names: [
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3-flash-preview',
      'gemini-3.8-flash',
      'gemini-3.5-flash',
    ],
  }),
  adapter(byId(coreVendorProfiles, 'xai.grok.reasoning'), {
    endpointOrigins: ['https://api.x.ai', 'https://us.api.x.ai'],
    endpointVersionedApiPath: true,
    protocols: [CHAT, RESPONSES],
    names: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.20-multi-agent'],
  }),
  adapter(
    byId(asiaCoreParameterProfiles, 'deepseek.official-api'),
    {
      endpointHosts: ['api.deepseek.com'],
      endpointPathExcludedSuffixes: ['/responses', '/messages'],
      endpointPathExcludes: ['/anthropic'],
      protocols: [CHAT, RESPONSES],
      names: ['deepseek-flash', 'deepseek-v4-pro'],
    },
    'openai-compatible',
    { reasoningContent: true, cacheHitMissUsage: true },
  ),
  adapter(byId(asiaCoreParameterProfiles, 'alibaba.model-studio.qwen38'), {
    endpointOrigins: ['https://dashscope.aliyuncs.com', 'https://dashscope-intl.aliyuncs.com'],
    endpointPaths: ['/compatible-mode/v1', '/compatible-mode/v1/chat/completions'],
    protocols: [CHAT],
    names: ['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash'],
  }),
  adapter(byId(asiaCoreParameterProfiles, 'mistral.official-api'), {
    endpointOrigins: ['https://api.mistral.ai'],
    endpointPaths: ['/v1', '/v1/chat/completions'],
    protocols: [CHAT],
    names: ['mistral-small-latest', 'mistral-medium-3-5', 'mistral-large-4-0', 'zai-glm-5-3'],
  }),
  adapter(byId(asiaCoreParameterProfiles, 'alibaba.model-studio.deepseek-v41-flash'), {
    endpointHostPatterns: [{ prefix: '', suffix: '.maas.aliyuncs.com' }],
    endpointPaths: ['/compatible-mode/v1'],
    protocols: [CHAT],
    names: ['deepseek-v4.1-flash'],
  }),
  ...(() => {
    const special = adapter(asiaNewParameterProfile, {});
    const paths = ['/v1', '/v1/chat/completions'];
    special.matchAny = [
      {
        endpointHosts: ['api.z.ai'],
        endpointPaths: ['/api/paas/v4', '/api/paas/v4/chat/completions'],
        protocols: [CHAT],
        names: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6'],
      },
      {
        endpointHosts: ['api.xiaomimimo.com'],
        endpointPaths: paths,
        protocols: [CHAT, RESPONSES],
        names: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'],
      },
      {
        endpointHosts: ['api.ant-ling.com'],
        endpointPaths: paths,
        protocols: [CHAT, RESPONSES, 'anthropic-messages'],
        names: [
          'Ling-3.1-flash',
          'Ling-3.0-flash-VL',
          'Ling-3.0-flash',
          'Ling-3.0-tiny',
          'Ling-2.6-1T',
          'Ring-2.6-1T',
          'Ling-2.6-flash',
          'AntAngelMed',
        ],
      },
      {
        endpointHosts: ['api.moonshot.ai', 'api.moonshot.cn'],
        endpointPaths: paths,
        protocols: [CHAT, RESPONSES, 'anthropic-messages'],
        names: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'],
      },
      {
        endpointHosts: ['api.stepfun.ai', 'api.stepfun.com'],
        endpointPaths: paths,
        protocols: [CHAT],
        names: ['step-5-preview'],
      },
    ];
    return [special];
  })(),
  ...(() => {
    const tokenHosts = [
      'tokenhub.tencentmaas.com',
      'tokenhub-intl.tencentmaas.com',
      'tokenhub.tencentmaas.cn',
      'tokenhub-intl.tencentmaas.cn',
    ];
    const paths = ['/v1', '/v1/chat/completions'];
    return [
      adapter(byId(asiaParameterProfiles, 'tencent.tokenhub.hy-reasoning'), {
        endpointHosts: tokenHosts,
        endpointPaths: paths,
        protocols: [CHAT],
        names: ['hy3', 'hy4-preview'],
      }),
      adapter(byId(asiaParameterProfiles, 'minimax.m31-flash-preview'), {
        endpointHosts: ['api.minimax.io'],
        endpointSchemes: ['https:'],
        endpointPaths: paths,
        protocols: [CHAT],
        names: ['MiniMax-M3.1-Flash-Preview'],
      }),
      adapter(byId(asiaParameterProfiles, 'tencent.tokenhub.minimax-thinking'), {
        endpointHosts: tokenHosts,
        endpointPaths: paths,
        protocols: [CHAT],
        names: ['minimax-m2.5', 'minimax-m2.7'],
      }),
      adapter(byId(asiaParameterProfiles, 'longcat.official-thinking'), {
        endpointHosts: ['api.longcat.chat'],
        endpointSchemes: ['https:'],
        endpointPaths: ['/openai/v1', '/openai/v1/chat/completions'],
        protocols: [CHAT],
        names: ['LongCat-2.0'],
      }),
      adapter(byId(asiaParameterProfiles, 'volcengine.ark.seed-reasoning'), {
        endpointHostPatterns: [{ prefix: 'ark.', suffix: '.volces.com', singleLabel: true }],
        endpointSchemes: ['https:'],
        endpointPaths: ['/api/v3', '/api/v3/chat/completions'],
        protocols: [CHAT, RESPONSES],
        names: [
          'doubao-seed-evolving',
          'doubao-seed-2-1-pro-260915',
          'doubao-seed-2-1-lite-260915',
          'doubao-seed-2-1-pro-260628',
          'doubao-seed-2-1-turbo-260628',
          'doubao-seed-2-0-lite-260428',
        ],
      }),
    ];
  })(),
  ...(() => {
    const special = adapter(nvidiaMetaParameterProfile, {});
    special.matchAny = [
      {
        endpointHosts: ['integrate.api.nvidia.com'],
        endpointSchemes: ['https:'],
        endpointPaths: ['/v1', '/v1/chat/completions'],
        protocols: [CHAT],
        names: ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'],
      },
      {
        endpointHosts: ['localhost', '127.0.0.1', '[::1]'],
        endpointPaths: ['/v1', '/v1/chat/completions'],
        protocols: [CHAT],
        names: [
          'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16',
          'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8',
          'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4',
          'meta-models/Muse-Spark-Open-816B-A42B-NVFP4',
        ],
      },
      {
        endpointHosts: ['api.meta.ai'],
        endpointSchemes: ['https:'],
        endpointPaths: ['/v1', '/v1/chat/completions'],
        protocols: [CHAT, RESPONSES],
        names: [
          'muse-wonder-1.0',
          'muse-spark-1.3',
          'muse-spark-1.3-contributor',
          'muse-spark-1.2',
          'muse-spark-1.2-contributor',
          'muse-spark-1.1',
        ],
      },
    ];
    return [special];
  })(),
];
export const modelParametersPlugin: PicoPlugin = {
  id: 'pico.model-parameters',
  name: 'Model parameters',
  version: '0.2.0',
  activate({ models }) {
    for (const contribution of standardAdapters) models.registerAdapter(contribution);
  },
};
