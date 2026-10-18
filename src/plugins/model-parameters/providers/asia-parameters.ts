import type {
  ModelParameterControl,
  ModelParameterProfile,
  ModelParameterSelection,
  ModelParameterTarget,
} from '../types.js';

/**
 * Official parameter references:
 * MiniMax through Tencent TokenHub:
 * https://intl-sg.tencent-cloud.com/document/product/1300/80636
 * LongCat:
 * https://longcat.chat/platform/docs/api/chat.html
 * https://longcat.chat/platform/docs/zh/api/model-params
 * Tencent Hunyuan through TokenHub:
 * https://intl.cloud.tencent.com/zh/document/product/1300/80637
 * Volcengine Ark:
 * https://docs.volcengine.com/docs/ark/model-parameter-support?lang=en
 * https://docs.volcengine.com/docs/ark/deep-thinking?lang=en
 */

const effortOptions = (values: readonly string[]) =>
  values.map((value) => ({ value, label: value === 'none' ? 'None' : value.toUpperCase() }));

function selectControl(
  id: string,
  label: string,
  values: readonly string[],
  defaultValue: string,
  description?: string,
): ModelParameterControl {
  return {
    id,
    label,
    kind: 'select',
    group: 'primary',
    defaultValue,
    options: effortOptions(values),
    ...(description ? { description } : {}),
  };
}

const thinkingControl: ModelParameterControl = {
  id: 'thinking',
  label: 'Thinking mode',
  kind: 'toggle',
  group: 'others',
  defaultValue: true,
};

function endpointMatches(target: ModelParameterTarget, host: string, path: RegExp): boolean {
  try {
    const endpoint = new URL(target.endpoint);
    return endpoint.protocol === 'https:' && endpoint.hostname.toLowerCase() === host && path.test(endpoint.pathname);
  } catch {
    return false;
  }
}

function arkEndpointMatches(target: ModelParameterTarget): boolean {
  try {
    const endpoint = new URL(target.endpoint);
    return endpoint.protocol === 'https:' && /^ark\.[a-z0-9-]+\.volces\.com$/i.test(endpoint.hostname) &&
      /^\/api\/v3(?:\/chat\/completions)?\/?$/i.test(endpoint.pathname);
  } catch {
    return false;
  }
}

function validEffort(selection: ModelParameterSelection, allowed: readonly string[], fallback: string): string {
  const value = selection.reasoningEffort;
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function thinkingEnabled(selection: ModelParameterSelection): boolean {
  return selection.thinking !== false;
}

const tokenHubHosts = [
  'tokenhub.tencentmaas.com',
  'tokenhub-intl.tencentmaas.com',
  'tokenhub.tencentmaas.cn',
  'tokenhub-intl.tencentmaas.cn',
] as const;
const tokenHubChatPath = /^\/v1(?:\/chat\/completions)?\/?$/i;
const tokenHubEffortOptions = ['none', 'low', 'high'] as const;

const tokenHubHunyuanProfile: ModelParameterProfile = {
  id: 'tencent.tokenhub.hy-reasoning',
  matches(target) {
    if (target.provider !== 'openai-compatible' || target.protocol !== 'openai-chat-completions' ||
      (target.model !== 'hy3' && target.model !== 'hy4-preview')) return false;
    try {
      const endpoint = new URL(target.endpoint);
      return tokenHubHosts.includes(endpoint.hostname.toLowerCase() as (typeof tokenHubHosts)[number]) &&
        tokenHubChatPath.test(endpoint.pathname);
    } catch {
      return false;
    }
  },
  controls(target) {
    return target.model === 'hy3'
      ? [selectControl('reasoningEffort', 'Reasoning', tokenHubEffortOptions, 'high', 'Hy3 supports low, high, and none.')]
      : [selectControl('reasoningEffort', 'Reasoning', ['none', 'high'], 'high', 'Hy4 preview supports high and none.')];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 2, step: 0.1 };
  },
  serialize(target, selection) {
    const values = target.model === 'hy3' ? tokenHubEffortOptions : ['none', 'high'];
    return { reasoning_effort: validEffort(selection, values, 'high') };
  },
};

// MiniMax's current OpenAI-compatible API exposes effort only on M3.1 Flash Preview.
// https://platform.minimax.io/docs/guides/text-generation
const miniMaxM31Profile: ModelParameterProfile = {
  id: 'minimax.m31-flash-preview',
  matches(target) {
    if (target.provider !== 'openai-compatible' || target.protocol !== 'openai-chat-completions' ||
      target.model !== 'MiniMax-M3.1-Flash-Preview') return false;
    try {
      const endpoint = new URL(target.endpoint);
      return endpoint.protocol === 'https:' && endpoint.hostname.toLowerCase() === 'api.minimax.io' &&
        /^\/v1(?:\/chat\/completions)?\/?$/i.test(endpoint.pathname);
    } catch {
      return false;
    }
  },
  controls() {
    return [selectControl('reasoningEffort', 'Reasoning', ['low', 'medium', 'high', 'xhigh', 'max'], 'max')];
  },
  temperature() {
    return { mode: 'unsupported', description: 'Temperature is not listed as an adjustable control for this model profile.' };
  },
  serialize(_target, selection) {
    const values = ['low', 'medium', 'high', 'xhigh', 'max'];
    return { reasoning_effort: validEffort(selection, values, 'max') };
  },
};

const tokenHubMiniMaxModels = new Set(['minimax-m2.5', 'minimax-m2.7']);
const tokenHubMiniMaxProfile: ModelParameterProfile = {
  id: 'tencent.tokenhub.minimax-thinking',
  matches(target) {
    if (target.provider !== 'openai-compatible' || target.protocol !== 'openai-chat-completions' || !tokenHubMiniMaxModels.has(target.model)) return false;
    try {
      return tokenHubHosts.includes(new URL(target.endpoint).hostname.toLowerCase() as (typeof tokenHubHosts)[number]) &&
        tokenHubChatPath.test(new URL(target.endpoint).pathname);
    } catch {
      return false;
    }
  },
  controls() {
    return [thinkingControl];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 2, step: 0.1 };
  },
  serialize(_target, selection) {
    return { thinking: { type: thinkingEnabled(selection) ? 'enabled' : 'disabled' } };
  },
};

const longCatProfile: ModelParameterProfile = {
  id: 'longcat.official-thinking',
  matches(target) {
    if (target.provider !== 'openai-compatible' || target.model !== 'LongCat-2.0') return false;
    return target.protocol === 'openai-chat-completions' &&
      endpointMatches(target, 'api.longcat.chat', /^\/openai\/v1(?:\/chat\/completions)?\/?$/i);
  },
  controls() {
    return [thinkingControl];
  },
  temperature() {
    return { mode: 'unsupported', description: 'Temperature is fixed by the LongCat thinking mode.' };
  },
  serialize(_target, selection) {
    return { thinking: { type: thinkingEnabled(selection) ? 'enabled' : 'disabled' } };
  },
};

const seedEfforts = ['minimal', 'low', 'medium', 'high'] as const;
const seedModels: Record<string, { defaultEffort: string; serviceTiers: readonly string[] }> = {
  'doubao-seed-evolving': { defaultEffort: 'high', serviceTiers: ['auto', 'default'] },
  'doubao-seed-2-1-pro-260915': { defaultEffort: 'high', serviceTiers: ['auto', 'default'] },
  'doubao-seed-2-1-lite-260915': { defaultEffort: 'high', serviceTiers: ['auto', 'default'] },
  'doubao-seed-2-1-pro-260628': { defaultEffort: 'high', serviceTiers: ['auto', 'default'] },
  'doubao-seed-2-1-turbo-260628': { defaultEffort: 'high', serviceTiers: ['auto', 'default', 'fast'] },
  'doubao-seed-2-0-lite-260428': { defaultEffort: 'medium', serviceTiers: ['auto', 'default', 'fast'] },
};

const seedProfile: ModelParameterProfile = {
  id: 'volcengine.ark.seed-reasoning',
  matches(target) {
    return target.provider === 'openai-compatible' &&
      (target.protocol === 'openai-chat-completions' || target.protocol === 'openai-responses') &&
      Object.hasOwn(seedModels, target.model) &&
      arkEndpointMatches(target);
  },
  controls(target) {
    const model = seedModels[target.model];
    if (!model) return [];
    return [
      selectControl('reasoningEffort', 'Reasoning', seedEfforts, model.defaultEffort),
      thinkingControl,
      selectControl('serviceTier', 'Service speed', model.serviceTiers, 'default'),
    ];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 2, step: 0.1 };
  },
  serialize(target, selection) {
    const model = seedModels[target.model];
    if (!model) return {};
    const effort = validEffort(selection, seedEfforts, model.defaultEffort);
    const enabled = thinkingEnabled(selection);
    const tier = selection.serviceTier;
    const serviceTier = typeof tier === 'string' && model.serviceTiers.includes(tier) ? tier : 'default';
    return {
      ...(target.protocol === 'openai-responses'
        ? { reasoning: { effort: enabled ? effort : 'minimal' } }
        : { reasoning_effort: enabled ? effort : 'minimal' }),
      thinking: { type: enabled ? 'enabled' : 'disabled' },
      service_tier: serviceTier,
    };
  },
};

/** Exact model IDs and official first-party endpoint/protocol combinations only. */
export const asiaParameterProfiles: ModelParameterProfile[] = [
  tokenHubHunyuanProfile,
  miniMaxM31Profile,
  tokenHubMiniMaxProfile,
  longCatProfile,
  seedProfile,
];
