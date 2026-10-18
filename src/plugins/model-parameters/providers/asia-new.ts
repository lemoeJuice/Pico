import type { ModelParameterControl, ModelParameterProfile, ModelParameterTarget } from '../types.js';

type Protocol = ModelParameterTarget['protocol'];

const effortOptions = (values: readonly string[]) => values.map((value) => ({
  value,
  label: value === 'xhigh' ? 'Extra high' : value.slice(0, 1).toUpperCase() + value.slice(1),
}));

const reasoningControl = (values: readonly string[], defaultValue: string): ModelParameterControl => ({
  id: 'reasoningEffort',
  label: 'Reasoning',
  kind: 'select',
  group: 'primary',
  defaultValue,
  options: effortOptions(values),
});

const thinkingControl = (defaultValue: boolean, description?: string): ModelParameterControl => ({
  id: 'thinking',
  label: 'Thinking',
  kind: 'toggle',
  group: 'others',
  defaultValue,
  ...(description ? { description } : {}),
});

function isOpenAiCompatible(target: ModelParameterTarget, hosts: readonly string[], protocols: readonly Protocol[], paths: readonly string[] = ['/v1']): boolean {
  if (target.provider !== 'openai-compatible' || !protocols.includes(target.protocol)) return false;
  try {
    const url = new URL(target.endpoint);
    if (!hosts.includes(url.hostname.toLowerCase())) return false;
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    if (path.endsWith('/responses') || path.endsWith('/messages') || path.includes('/anthropic')) return false;
    return paths.includes(path);
  } catch {
    return false;
  }
}

function isModel(target: ModelParameterTarget, ids: readonly string[]): boolean {
  return ids.includes(target.model);
}

const ZAI_HOSTS = ['api.z.ai'] as const;
const MIMO_HOSTS = ['api.xiaomimimo.com'] as const;
const LING_HOSTS = ['api.ant-ling.com'] as const;
const KIMI_HOSTS = ['api.moonshot.ai', 'api.moonshot.cn'] as const;
const STEPFUN_HOSTS = ['api.stepfun.ai', 'api.stepfun.com'] as const;

const CHAT: Protocol = 'openai-chat-completions';
const RESPONSES: Protocol = 'openai-responses';
const ANTHROPIC: Protocol = 'anthropic-messages';

// Official model IDs and parameter contracts:
// Z.AI GLM: https://docs.z.ai/api-reference/llm/chat-completion
// MiMo: https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking
// Ant Ling/Ring: https://developer.ant-ling.com/zh-CN/docs/api-reference/openai/
// Kimi: https://platform.kimi.ai/docs/models and https://platform.kimi.ai/docs/guide/use-reasoning-effort
// StepFun: https://platform.stepfun.com/cookbook/step-5-reasoning
const zaiReasoningModels = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2'] as const;
const zaiSwitchableModels = ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6'] as const;
const zaiKnownModels = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6'] as const;

const mimoModels = [
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'mimo-v2.6-pro-ultraspeed',
  'mimo-v2.5-pro',
  'mimo-v2.5',
] as const;

const lingThinkingModels = ['Ling-3.1-flash', 'Ling-3.0-flash-VL', 'Ling-3.0-flash', 'Ling-3.0-tiny'] as const;
const lingRingModels = ['Ling-3.1-flash', 'Ling-3.0-flash-VL', 'Ling-3.0-flash', 'Ling-3.0-tiny', 'Ling-2.6-1T', 'Ring-2.6-1T', 'Ling-2.6-flash', 'AntAngelMed'] as const;

const kimiThinkingModel = 'kimi-k2.6';
const kimiForcedThinkingModels = ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'] as const;
const kimiEffortModel = 'kimi-k3';
const kimiKnownModels = [kimiEffortModel, kimiThinkingModel, ...kimiForcedThinkingModels] as const;

const stepModel = 'step-5-preview';

export const asiaNewParameterProfile: ModelParameterProfile = {
  id: 'asia-new.official-model-parameters',

  matches(target) {
    const protocol = [CHAT, RESPONSES, ANTHROPIC] as const;
    return (
      (isOpenAiCompatible(target, ZAI_HOSTS, [CHAT], ['/api/paas/v4', '/api/paas/v4/chat/completions']) && isModel(target, zaiKnownModels)) ||
      (isOpenAiCompatible(target, MIMO_HOSTS, [CHAT, RESPONSES], ['/v1', '/v1/chat/completions', '/v1/responses']) && isModel(target, mimoModels)) ||
      (isOpenAiCompatible(target, LING_HOSTS, protocol, ['/v1', '/v1/chat/completions', '/anthropic/v1', '/anthropic/v1/messages']) && isModel(target, lingRingModels)) ||
      (isOpenAiCompatible(target, KIMI_HOSTS, [CHAT, RESPONSES, ANTHROPIC], ['/v1', '/v1/chat/completions', '/v1/responses', '/anthropic/v1', '/anthropic/v1/messages']) && isModel(target, kimiKnownModels)) ||
      (isOpenAiCompatible(target, STEPFUN_HOSTS, [CHAT], ['/v1', '/v1/chat/completions']) && target.model === stepModel)
    );
  },

  controls(target) {
    if (isOpenAiCompatible(target, ZAI_HOSTS, [CHAT], ['/api/paas/v4', '/api/paas/v4/chat/completions']) && isModel(target, zaiKnownModels)) {
      const controls: ModelParameterControl[] = [];
      if (isModel(target, zaiReasoningModels)) {
        controls.push(reasoningControl(
          target.model === 'glm-5.3' || target.model === 'glm-5.3-flash' || target.model === 'glm-5.3-flashx'
            ? ['low', 'high', 'max']
            : ['low', 'medium', 'high', 'xhigh', 'max'],
          'max',
        ));
      }
      if (isModel(target, zaiSwitchableModels)) {
        controls.push(thinkingControl(true,
          target.model === 'glm-4.7' ? 'Thinking can be turned off for each request.' : undefined));
      }
      return controls;
    }

    if (isOpenAiCompatible(target, MIMO_HOSTS, [CHAT, RESPONSES], ['/v1', '/v1/chat/completions', '/v1/responses']) && isModel(target, mimoModels)) {
      return [thinkingControl(true, 'Thinking is enabled by default. In Responses, enabled effort levels currently have the same behavior.')];
    }

    if (isOpenAiCompatible(target, LING_HOSTS, [CHAT, RESPONSES, ANTHROPIC], ['/v1', '/v1/chat/completions', '/anthropic/v1', '/anthropic/v1/messages']) && isModel(target, lingRingModels)) {
      if (target.model === 'Ring-2.6-1T') {
        if (target.protocol === CHAT) return [reasoningControl(['high', 'xhigh'], 'high')];
        if (target.protocol === ANTHROPIC) return [reasoningControl(['high', 'xhigh'], 'high')];
        return [];
      }
      if (isModel(target, lingThinkingModels)) {
        if (target.protocol === CHAT) return [thinkingControl(true)];
        if (target.protocol === ANTHROPIC) return [thinkingControl(true)];
      }
      return [];
    }

    if (isOpenAiCompatible(target, KIMI_HOSTS, [CHAT, RESPONSES, ANTHROPIC], ['/v1', '/v1/chat/completions', '/v1/responses', '/anthropic/v1', '/anthropic/v1/messages']) && isModel(target, kimiKnownModels)) {
      if (target.model === kimiEffortModel && target.protocol === CHAT) {
        return [reasoningControl(['low', 'high', 'max'], 'max')];
      }
      if (target.model === kimiThinkingModel && target.protocol === CHAT) return [thinkingControl(true)];
      // K2.7 Code models are documented as always-thinking; highspeed is a fixed model variant, not a request control.
      return [];
    }

    if (isOpenAiCompatible(target, STEPFUN_HOSTS, [CHAT], ['/v1', '/v1/chat/completions']) && target.model === stepModel) {
      return [reasoningControl(['low', 'medium', 'high'], 'medium')];
    }
    return [];
  },

  temperature(target) {
    if (isOpenAiCompatible(target, LING_HOSTS, [CHAT], ['/v1', '/v1/chat/completions']) && isModel(target, lingRingModels)) {
      return { mode: 'adjustable', min: 0, max: 1, step: 0.1 };
    }
    // These model families either fix sampling values or lack a documented, model-specific temperature contract here.
    return { mode: 'unsupported' };
  },

  serialize(target, selection) {
    if (isOpenAiCompatible(target, ZAI_HOSTS, [CHAT], ['/api/paas/v4', '/api/paas/v4/chat/completions']) && isModel(target, zaiKnownModels)) {
      const result: Record<string, unknown> = {};
      const effort = selection.reasoningEffort;
      if (isModel(target, zaiReasoningModels) && typeof effort === 'string' && (['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'].includes(target.model)
        ? ['low', 'high', 'max']
        : ['low', 'medium', 'high', 'xhigh', 'max']).includes(effort)) {
        result.reasoning_effort = effort;
      }
      if (isModel(target, zaiSwitchableModels) && typeof selection.thinking === 'boolean') {
        result.thinking = { type: selection.thinking ? 'enabled' : 'disabled' };
      }
      return result;
    }

    if (isOpenAiCompatible(target, MIMO_HOSTS, [CHAT, RESPONSES], ['/v1', '/v1/chat/completions', '/v1/responses']) && isModel(target, mimoModels)) {
      if (typeof selection.thinking !== 'boolean') return {};
      if (target.protocol === RESPONSES) return { reasoning: { effort: selection.thinking ? 'high' : 'none' } };
      return { thinking: { type: selection.thinking ? 'enabled' : 'disabled' } };
    }

    if (isOpenAiCompatible(target, LING_HOSTS, [CHAT, RESPONSES, ANTHROPIC], ['/v1', '/v1/chat/completions', '/anthropic/v1', '/anthropic/v1/messages']) && isModel(target, lingRingModels)) {
      if (target.model === 'Ring-2.6-1T') {
        const effort = selection.reasoningEffort;
        if (typeof effort !== 'string' || !['high', 'xhigh'].includes(effort)) return {};
        return target.protocol === ANTHROPIC ? { output_config: { effort } } : target.protocol === CHAT ? { reasoning_effort: effort } : {};
      }
      if (isModel(target, lingThinkingModels) && typeof selection.thinking === 'boolean') {
        return { thinking: { type: selection.thinking ? 'enabled' : 'disabled' } };
      }
      return {};
    }

    if (isOpenAiCompatible(target, KIMI_HOSTS, [CHAT, RESPONSES, ANTHROPIC], ['/v1', '/v1/chat/completions', '/v1/responses', '/anthropic/v1', '/anthropic/v1/messages']) && isModel(target, kimiKnownModels)) {
      if (target.model === kimiEffortModel && target.protocol === CHAT) {
        const effort = selection.reasoningEffort;
        return typeof effort === 'string' && ['low', 'high', 'max'].includes(effort) ? { reasoning_effort: effort } : {};
      }
      if (target.model === kimiThinkingModel && target.protocol === CHAT && typeof selection.thinking === 'boolean') {
        return { thinking: { type: selection.thinking ? 'enabled' : 'disabled' } };
      }
      return {};
    }

    if (isOpenAiCompatible(target, STEPFUN_HOSTS, [CHAT], ['/v1', '/v1/chat/completions']) && target.model === stepModel) {
      const effort = selection.reasoningEffort;
      return typeof effort === 'string' && ['low', 'medium', 'high'].includes(effort) ? { reasoning_effort: effort } : {};
    }
    return {};
  },
};
