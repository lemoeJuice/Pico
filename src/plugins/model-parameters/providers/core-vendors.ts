import type { ModelParameterControl, ModelParameterProfile, ModelParameterTarget } from '../types.js';

const OFFICIAL_ENDPOINTS = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  xai: ['https://api.x.ai', 'https://us.api.x.ai'],
} as const;

function endpointUrl(target: ModelParameterTarget): URL | null {
  try {
    return new URL(target.endpoint);
  } catch {
    return null;
  }
}

function onHost(target: ModelParameterTarget, hosts: readonly string[]): boolean {
  const url = endpointUrl(target);
  return Boolean(url && url.protocol === 'https:' && hosts.includes(url.origin));
}

function hasVersionedApiPath(target: ModelParameterTarget): boolean {
  const path = endpointUrl(target)?.pathname.replace(/\/+$/, '') ?? '';
  return /^\/v\d+(?:beta)?(?:\/openai)?(?:\/chat\/completions)?$/i.test(path);
}

function exactModels(target: ModelParameterTarget, models: readonly string[]): boolean {
  return models.includes(target.model.trim());
}

function selectControl(
  id: string,
  label: string,
  values: readonly string[],
  description?: string,
): ModelParameterControl {
  return {
    id,
    label,
    kind: 'select',
    group: 'primary',
    defaultValue: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      ...values.map((value) => ({ value, label: value.replace(/^./, (letter) => letter.toUpperCase()) })),
    ],
    ...(description ? { description } : {}),
  };
}

function reasoningProfile(args: {
  id: string;
  matches: (target: ModelParameterTarget) => boolean;
  options: (target: ModelParameterTarget) => readonly string[] | null;
  serialize: (target: ModelParameterTarget, effort: string) => Record<string, unknown>;
  label?: string;
  description?: string;
  temperature?: (target: ModelParameterTarget) => ReturnType<ModelParameterProfile['temperature']>;
}): ModelParameterProfile {
  return {
    id: args.id,
    matches: args.matches,
    controls(target) {
      const options = args.options(target);
      return options ? [selectControl('reasoningEffort', args.label ?? 'Reasoning', options, args.description)] : [];
    },
    temperature(target) {
      return args.temperature?.(target) ?? { mode: 'adjustable', min: 0, max: 2, step: 0.1 };
    },
    serialize(target, selection) {
      const options = args.options(target);
      const effort = selection.reasoningEffort;
      if (!options || typeof effort !== 'string' || !options.includes(effort)) return {};
      if (effort === 'auto') return {};
      return args.serialize(target, effort);
    },
  };
}

const openAiReasoningModels = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const;
const openAiFullEffortModels = new Set(['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

// OpenAI model-specific support and endpoint parameters:
// https://developers.openai.com/api/docs/guides/reasoning
// https://developers.openai.com/api/reference/resources/responses/methods/create
const openAiProfile = reasoningProfile({
  id: 'openai.official.reasoning',
  matches(target) {
    return (
      target.provider === 'openai-compatible' &&
      onHost(target, [OFFICIAL_ENDPOINTS.openai]) &&
      hasVersionedApiPath(target) &&
      (target.protocol === 'openai-responses' || target.protocol === 'openai-chat-completions') &&
      exactModels(target, openAiReasoningModels)
    );
  },
  options(target) {
    if (!exactModels(target, openAiReasoningModels)) return null;
    return openAiFullEffortModels.has(target.model)
      ? ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['low', 'medium', 'high', 'xhigh', 'max'];
  },
  serialize(target, effort) {
    return target.protocol === 'openai-responses'
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };
  },
  description: 'Supported values vary by model; this control is limited to model IDs listed in OpenAI reasoning documentation.',
});

const claudeModels: Record<string, readonly string[]> = {
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-mythos-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5': ['low', 'medium', 'high', 'max'],
  'claude-mythos-5': ['low', 'medium', 'high', 'max'],
  'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
};

// Anthropic's effort availability table is model-specific; adaptive thinking is the current control.
// https://platform.claude.com/docs/en/build-with-claude/effort
// https://platform.claude.com/docs/en/build-with-claude/extended-thinking
const anthropicProfile = reasoningProfile({
  id: 'anthropic.messages.adaptive-effort',
  matches(target) {
    return (
      target.protocol === 'anthropic-messages' &&
      onHost(target, [OFFICIAL_ENDPOINTS.anthropic]) &&
      hasVersionedApiPath(target) &&
      Object.hasOwn(claudeModels, target.model)
    );
  },
  options(target) {
    return claudeModels[target.model] ?? null;
  },
  serialize(_target, effort) {
    return { thinking: { type: 'adaptive' }, output_config: { effort } };
  },
  temperature(target) {
    if (target.model === 'claude-opus-4-6' || target.model === 'claude-sonnet-4-6') {
      return { mode: 'adjustable', min: 0, max: 1, step: 0.1 };
    }
    return { mode: 'unsupported', description: 'Anthropic models released after Opus 4.6 do not support temperature.' };
  },
  description: 'Uses adaptive thinking; manual budget_tokens is not supported on these model IDs.',
});

const geminiThinkingModels: Record<string, readonly string[]> = {
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3.1-flash-lite-preview': ['minimal', 'low', 'medium', 'high'],
  'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.8-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash': ['minimal', 'low', 'medium', 'high'],
};

// Gemini's official OpenAI-compatible endpoint accepts reasoning_effort, or Google thinking_config
// via extra_body. Use the documented OpenAI-compatible field to avoid inventing wrapper structure.
// https://ai.google.dev/gemini-api/docs/openai
// https://ai.google.dev/gemini-api/docs/gemini-3
const geminiProfile = reasoningProfile({
  id: 'google.gemini.openai-compatible-thinking',
  matches(target) {
    return (
      target.provider === 'openai-compatible' &&
      target.protocol === 'openai-chat-completions' &&
      onHost(target, [OFFICIAL_ENDPOINTS.gemini]) &&
      hasVersionedApiPath(target) &&
      Object.hasOwn(geminiThinkingModels, target.model)
    );
  },
  options(target) {
    return geminiThinkingModels[target.model] ?? null;
  },
  serialize(_target, effort) {
    return { reasoning_effort: effort };
  },
  temperature() {
    return { mode: 'fixed', value: 1, description: 'Google recommends the default temperature of 1.0 for Gemini 3 reasoning models.' };
  },
  description: 'Gemini thinking levels are model-specific; reasoning_effort is the documented OpenAI-compatible spelling.',
});

const xaiModels: Record<string, readonly string[]> = {
  'grok-4.7': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.5': ['low', 'medium', 'high'],
  'grok-4.20-multi-agent': ['low', 'medium', 'high', 'xhigh'],
};

// xAI recommends Responses for reasoning models; Chat Completions is retained where explicitly used.
// https://docs.x.ai/developers/model-capabilities/text/reasoning
// https://docs.x.ai/developers/grok-4-7
const xaiProfile = reasoningProfile({
  id: 'xai.grok.reasoning',
  matches(target) {
    return (
      target.provider === 'openai-compatible' &&
      (target.protocol === 'openai-responses' || target.protocol === 'openai-chat-completions') &&
      onHost(target, OFFICIAL_ENDPOINTS.xai) &&
      hasVersionedApiPath(target) &&
      Object.hasOwn(xaiModels, target.model)
    );
  },
  options(target) {
    return xaiModels[target.model] ?? null;
  },
  serialize(target, effort) {
    return target.protocol === 'openai-responses'
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };
  },
  label: 'Reasoning / agent effort',
  description: 'For grok-4.20-multi-agent, effort controls the number of collaborating agents, not reasoning depth.',
});

export const coreVendorProfiles: ModelParameterProfile[] = [
  openAiProfile,
  anthropicProfile,
  geminiProfile,
  xaiProfile,
];
