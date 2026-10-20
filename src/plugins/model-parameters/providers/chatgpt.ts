import type { ModelParameterControl, ModelParameterProfile, ModelParameterTarget } from '../types.js';

const basicEfforts = ['auto', 'low', 'medium', 'high'] as const;
const fullEfforts = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const flagshipEfforts = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function reasoningOptions(model: string): NonNullable<ModelParameterControl['options']> {
  const slug = model.toLowerCase();
  let values: readonly string[] = basicEfforts;
  if (/^gpt-6-astra(?:-|$)/.test(slug) || /^gpt-6\.1-sol(?:-|$)/.test(slug)) values = flagshipEfforts;
  else if (/^gpt-6-(?:sol|luna)(?:-|$)/.test(slug) || /^gpt-5\.6-(?:sol|terra|luna)(?:-|$)/.test(slug)) {
    values = fullEfforts;
  }
  return values.map((value) => ({ value, label: value === 'auto' ? 'Auto' : value.replace(/^./, (letter) => letter.toUpperCase()) }));
}

const reasoningControl = (target: ModelParameterTarget): ModelParameterControl => ({
  id: 'reasoningEffort',
  label: 'Reasoning',
  kind: 'select',
  group: 'primary',
  defaultValue: 'auto',
  options: reasoningOptions(target.model),
});

export const chatGptParameterProfile: ModelParameterProfile = {
  id: 'openai.chatgpt-plan.responses',
  matches(target) {
    return target.provider === 'chatgpt-plan' && target.protocol === 'openai-responses';
  },
  controls(target) {
    return [
      reasoningControl(target),
      {
        id: 'fastMode',
        label: 'Fast mode',
        kind: 'toggle',
        group: 'primary',
        defaultValue: false,
      },
    ];
  },
  temperature() {
    return { mode: 'unsupported', description: 'ChatGPT Responses does not expose temperature for this model control.' };
  },
  serialize(_target, selection) {
    const effort = selection.reasoningEffort;
    const fastMode = selection.fastMode === true;
    return {
      reasoning: {
        summary: 'auto',
        ...(typeof effort === 'string' && effort !== 'auto' ? { effort } : {}),
      },
      ...(fastMode ? { service_tier: 'priority' } : {}),
    };
  },
};
