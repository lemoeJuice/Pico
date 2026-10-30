import type { AdapterContribution, AdapterControl, AdapterTemperature } from '../../contracts/model-catalog.js';
import type { PluginContext } from '../host.js';
import type { ModelParameterControl, ModelParameterTarget } from '../model-parameters/types.js';
import { chatGptParameterProfile } from './parameters.js';

const target = (model: Parameters<NonNullable<AdapterContribution['controlsForModel']>>[0]): ModelParameterTarget => ({
  provider: 'chatgpt-plan',
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

function temperature(): AdapterTemperature {
  return { supported: false, description: 'ChatGPT Responses does not expose temperature for this model control.' };
}

export function registerChatGptPlanAdapter(context: Pick<PluginContext, 'models'>): void {
  context.models.registerAdapter({
    id: chatGptParameterProfile.id,
    label: chatGptParameterProfile.id,
    replayFormat: 'openai-responses',
    match: { providerTypeIds: ['chatgpt-plan'], protocols: ['openai-responses'] },
    controls: [],
    temperature: temperature(),
    controlsForModel(model) {
      return chatGptParameterProfile.controls(target(model)).map(control);
    },
    temperatureForModel: temperature,
    normalize(model, parameters) {
      const defaults = Object.fromEntries(
        chatGptParameterProfile
          .controls(target(model))
          .filter((item) => item.defaultValue !== undefined)
          .map((item) => [item.id, item.defaultValue!]),
      );
      return { ...parameters, options: { ...defaults, ...parameters.options } };
    },
    serialize(model, parameters) {
      const fields = chatGptParameterProfile.serialize(target(model), parameters.options, 1);
      return { fields, temperature: null };
    },
  });
}
