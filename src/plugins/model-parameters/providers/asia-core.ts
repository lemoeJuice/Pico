import type { ModelParameterControl, ModelParameterProfile, ModelParameterSelection, ModelParameterTarget } from '../types.js';

/** Official references:
 * DeepSeek: https://api-docs.deepseek.com/guides/thinking_mode/ and
 * https://api-docs.deepseek.com/api/list-models/
 * Alibaba Cloud Model Studio: https://help.aliyun.com/en/model-studio/qwen-api-via-dashscope
 * Mistral: https://docs.mistral.ai/studio/conversations/reasoning and https://docs.mistral.ai/api
 */

const reasoningControl = (
  options: readonly string[],
  defaultValue: string,
  description?: string,
): ModelParameterControl => ({
  id: 'reasoningEffort',
  label: 'Reasoning',
  kind: 'select',
  group: 'primary',
  defaultValue,
  options: options.map((value) => ({ value, label: value === 'none' ? 'None' : value.toUpperCase() })),
  ...(description ? { description } : {}),
});

const thinkingToggle: ModelParameterControl = {
  id: 'thinking',
  label: 'Thinking mode',
  kind: 'toggle',
  group: 'others',
  defaultValue: true,
};

function hostIs(target: ModelParameterTarget, hosts: readonly string[]): boolean {
  try {
    const endpoint = new URL(target.endpoint);
    const path = endpoint.pathname.toLowerCase();
    return (
      hosts.includes(endpoint.hostname.toLowerCase()) &&
      !path.endsWith('/responses') &&
      !path.endsWith('/messages') &&
      !path.includes('/anthropic')
    );
  } catch {
    return false;
  }
}

function isOpenAiProtocol(target: ModelParameterTarget): boolean {
  return target.protocol === 'openai-chat-completions' || target.protocol === 'openai-responses';
}

function selectedEffort(selection: ModelParameterSelection, allowed: readonly string[], fallback: string): string {
  const value = selection.reasoningEffort;
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function selectedThinking(selection: ModelParameterSelection): boolean {
  return selection.thinking !== false;
}

const deepSeekModels = new Set(['deepseek-flash', 'deepseek-v4-pro']);
const deepSeekEfforts = ['none', 'low', 'high', 'max'] as const;
const aliyunDeepSeekEfforts = ['low', 'high', 'max'] as const;

const aliyunDeepSeekProfile: ModelParameterProfile = {
  id: 'alibaba.model-studio.deepseek-v41-flash',
  matches(target) {
    if (target.provider !== 'openai-compatible' || target.protocol !== 'openai-chat-completions' ||
      target.model !== 'deepseek-v4.1-flash') return false;
    try {
      const endpoint = new URL(target.endpoint);
      const hostname = endpoint.hostname.toLowerCase();
      const path = endpoint.pathname.replace(/\/$/, '').toLowerCase();
      return hostname.endsWith('.maas.aliyuncs.com') && path === '/compatible-mode/v1';
    } catch {
      return false;
    }
  },
  controls() {
    return [reasoningControl(aliyunDeepSeekEfforts, 'high')];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 2, step: 0.1, description: 'Supported range and effect can vary by model and provider.' };
  },
  serialize(_target, selection) {
    return { reasoning_effort: selectedEffort(selection, aliyunDeepSeekEfforts, 'high') };
  },
};

const deepSeekProfile: ModelParameterProfile = {
  id: 'deepseek.official-api',
  matches(target) {
    return target.provider === 'openai-compatible' && hostIs(target, ['api.deepseek.com']) &&
      isOpenAiProtocol(target) && deepSeekModels.has(target.model);
  },
  controls(target) {
    return [reasoningControl(deepSeekEfforts, 'high'), ...(target.protocol === 'openai-chat-completions' ? [thinkingToggle] : [])];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 2, step: 0.1, description: 'Ignored in thinking mode.' };
  },
  serialize(target, selection) {
    const effort = selectedEffort(selection, deepSeekEfforts, 'high');
    if (target.protocol === 'openai-responses') {
      return { reasoning: { effort: selectedThinking(selection) ? effort : 'none' } };
    }
    const enabled = selectedThinking(selection) && effort !== 'none';
    return {
      reasoning_effort: effort,
      thinking: { type: enabled ? 'enabled' : 'disabled' },
    };
  },
};

const qwenThinkingModels = new Set(['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash']);
const qwenEfforts = ['low', 'medium', 'xhigh'] as const;

const qwenProfile: ModelParameterProfile = {
  id: 'alibaba.model-studio.qwen38',
  matches(target) {
    return target.provider === 'openai-compatible' &&
      hostIs(target, ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com']) &&
      target.protocol === 'openai-chat-completions' && qwenThinkingModels.has(target.model);
  },
  controls() {
    return [reasoningControl(qwenEfforts, 'xhigh'), thinkingToggle];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 2, step: 0.1, description: 'Supported range and effect can vary by model and thinking mode.' };
  },
  serialize(_target, selection) {
    const enabled = selectedThinking(selection);
    return {
      enable_thinking: enabled,
      ...(enabled ? { reasoning_effort: selectedEffort(selection, qwenEfforts, 'xhigh') } : {}),
    };
  },
};

const mistralModels = new Set(['mistral-small-latest', 'mistral-medium-3-5', 'mistral-large-4-0']);
const mistralEfforts = ['none', 'high'] as const;
const glmEfforts = ['low', 'high', 'max'] as const;

const mistralProfile: ModelParameterProfile = {
  id: 'mistral.official-api',
  matches(target) {
    return target.provider === 'openai-compatible' && hostIs(target, ['api.mistral.ai']) &&
      target.protocol === 'openai-chat-completions' && (mistralModels.has(target.model) || target.model === 'zai-glm-5-3');
  },
  controls(target) {
    return [reasoningControl(target.model === 'zai-glm-5-3' ? glmEfforts : mistralEfforts, target.model === 'zai-glm-5-3' ? 'max' : 'none')];
  },
  temperature() {
    return { mode: 'adjustable', min: 0, max: 0.7, step: 0.1, description: 'Mistral recommends 0.0–0.7; defaults vary by model.' };
  },
  serialize(target, selection) {
    const options = target.model === 'zai-glm-5-3' ? glmEfforts : mistralEfforts;
    return { reasoning_effort: selectedEffort(selection, options, target.model === 'zai-glm-5-3' ? 'max' : 'none') };
  },
};

/** Exact model IDs and documented first-party hosts only; unknown variants return no profile. */
export const asiaCoreParameterProfiles: ModelParameterProfile[] = [aliyunDeepSeekProfile, deepSeekProfile, qwenProfile, mistralProfile];
