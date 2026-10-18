import type { ModelParameterControl, ModelParameterProfile, ModelParameterTarget } from '../types.js';

type Protocol = ModelParameterTarget['protocol'];

const CHAT: Protocol = 'openai-chat-completions';
const RESPONSES: Protocol = 'openai-responses';
const NVIDIA_HOSTED = 'integrate.api.nvidia.com';
const META_HOSTED = 'api.meta.ai';
const NIM_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const effortLabels: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

function effortControl(values: readonly string[], defaultValue?: string): ModelParameterControl {
  return {
    id: 'reasoningEffort',
    label: 'Reasoning',
    kind: 'select',
    group: 'primary',
    ...(defaultValue ? { defaultValue } : {}),
    options: values.map((value) => ({ value, label: effortLabels[value] ?? value })),
  };
}

function thinkingControl(defaultValue: boolean, description?: string): ModelParameterControl {
  return {
    id: 'thinking',
    label: 'Thinking',
    kind: 'toggle',
    group: 'others',
    defaultValue,
    ...(description ? { description } : {}),
  };
}

function endpoint(target: ModelParameterTarget): URL | null {
  try {
    return new URL(target.endpoint);
  } catch {
    return null;
  }
}

function isVersionedV1(target: ModelParameterTarget, hosts: ReadonlySet<string>): boolean {
  const url = endpoint(target);
  if (!url || url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase())) return false;
  return /^\/v1(?:\/chat\/completions)?\/?$/i.test(url.pathname);
}

function isLocalNimV1(target: ModelParameterTarget): boolean {
  const url = endpoint(target);
  if (!url || !['http:', 'https:'].includes(url.protocol) || !NIM_LOCAL_HOSTS.has(url.hostname.toLowerCase())) return false;
  return /^\/v1(?:\/chat\/completions)?\/?$/i.test(url.pathname);
}

function modelIs(target: ModelParameterTarget, values: readonly string[]): boolean {
  return values.includes(target.model.trim());
}

const nemotronHostedModels = ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'] as const;
const nemotronNimModels = [
  'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16',
  'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8',
  'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4',
] as const;
const museOpenModel = 'meta-models/Muse-Spark-Open-816B-A42B-NVFP4';

const metaMuseModels = [
  'muse-wonder-1.0',
  'muse-spark-1.3',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2',
  'muse-spark-1.2-contributor',
  'muse-spark-1.1',
] as const;
const metaMuseMaxModels = new Set(['muse-wonder-1.0', 'muse-spark-1.3']);

function isNemotronHosted(target: ModelParameterTarget): boolean {
  return target.provider === 'openai-compatible' && target.protocol === CHAT &&
    isVersionedV1(target, new Set([NVIDIA_HOSTED])) && modelIs(target, nemotronHostedModels);
}

function isNemotronNim(target: ModelParameterTarget): boolean {
  return target.provider === 'openai-compatible' && target.protocol === CHAT &&
    isLocalNimV1(target) && modelIs(target, nemotronNimModels);
}

function isMuseOpenNim(target: ModelParameterTarget): boolean {
  return target.provider === 'openai-compatible' && target.protocol === CHAT &&
    isLocalNimV1(target) &&
    target.model.trim() === museOpenModel;
}

function isMetaMuse(target: ModelParameterTarget): boolean {
  return target.provider === 'openai-compatible' &&
    (target.protocol === CHAT || target.protocol === RESPONSES) &&
    isVersionedV1(target, new Set([META_HOSTED])) && modelIs(target, metaMuseModels);
}

function nemotronControls(nim: boolean): ModelParameterControl[] {
  return [
    ...(nim ? [thinkingControl(true, 'NVIDIA NIM defaults to thinking enabled for this model.')]: []),
    {
      id: 'reasoningBudget',
      label: 'Reasoning budget',
      kind: 'range',
      group: 'primary',
      defaultValue: 16384,
      min: 0,
      max: 32768,
      step: 256,
      description: 'Controls the model reasoning token budget.',
    },
  ];
}

export const nvidiaMetaParameterProfile: ModelParameterProfile = {
  id: 'nvidia-meta.official-reasoning',

  matches(target) {
    return isNemotronHosted(target) || isNemotronNim(target) || isMuseOpenNim(target) || isMetaMuse(target);
  },

  controls(target) {
    if (isNemotronHosted(target)) return nemotronControls(false);
    if (isNemotronNim(target)) return nemotronControls(true);
    if (isMuseOpenNim(target)) {
      return [effortControl(['none', 'low', 'medium', 'high', 'xhigh'], 'xhigh')];
    }
    if (isMetaMuse(target)) {
      const values = ['minimal', 'low', 'medium', 'high', 'xhigh'];
      if (metaMuseMaxModels.has(target.model)) values.push('max');
      return [effortControl(values)];
    }
    return [];
  },

  temperature(target) {
    if (isNemotronHosted(target)) {
      return { mode: 'adjustable', min: 0, max: 2, step: 0.1 };
    }
    return { mode: 'unsupported' };
  },

  serialize(target, selection) {
    if (isNemotronHosted(target)) {
      const value = selection.reasoningBudget;
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 32768
        ? { reasoning_budget: value }
        : {};
    }
    if (isNemotronNim(target)) {
      const result: Record<string, unknown> = {};
      const budget = selection.reasoningBudget;
      if (typeof budget === 'number' && Number.isInteger(budget) && budget >= 0 && budget <= 32768) {
        result.chat_template_kwargs = { reasoning_budget: budget };
      }
      if (typeof selection.thinking === 'boolean') {
        result.chat_template_kwargs = {
          ...(result.chat_template_kwargs as Record<string, unknown> | undefined),
          enable_thinking: selection.thinking,
        };
      }
      return result;
    }
    if (isMuseOpenNim(target)) {
      const effort = selection.reasoningEffort;
      return typeof effort === 'string' && ['none', 'low', 'medium', 'high', 'xhigh'].includes(effort)
        ? { reasoning_effort: effort }
        : {};
    }
    if (isMetaMuse(target)) {
      const effort = selection.reasoningEffort;
      const values = ['minimal', 'low', 'medium', 'high', 'xhigh', ...(metaMuseMaxModels.has(target.model) ? ['max'] : [])];
      if (typeof effort !== 'string' || !values.includes(effort)) return {};
      return target.protocol === RESPONSES
        ? { reasoning: { effort } }
        : { reasoning_effort: effort };
    }
    return {};
  },
};

// Official references:
// NVIDIA hosted Nemotron API schema and model guide:
// https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-content-safety-infer
// https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning
// NVIDIA NIM Muse Spark Open endpoint and reasoning levels:
// https://docs.nvidia.com/nim/large-language-models/2.0.13/get-started/advanced/get-started-muse-spark-open.html
// Meta hosted Muse model IDs and reasoning effort (Chat Completions / Responses):
// https://dev.meta.ai/docs/models
// https://dev.meta.ai/docs/reasoning
