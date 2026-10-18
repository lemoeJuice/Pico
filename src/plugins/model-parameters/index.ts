import type { ModelParameterSelection, ModelParameterTarget } from './types.js';
import type { ModelStageInput } from '../../runtime/stages.js';
import type { ModelResponse } from '../../contracts/model.js';
import type { PicoPlugin } from '../host.js';
import {
  controlsForTarget,
  profileForTarget,
  sanitizeSelection,
  serializeSelection,
  temperatureForTarget,
  validateSelection,
} from './registry.js';
import { modelParameterTargetFromRecord, modelParameterTargetFromSettings, modelParameterTargetKey } from './target.js';

const PLUGIN_ID = 'pico.model-parameters';
const selectionsKey = 'selections';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function targetFromQuery(query: URLSearchParams): ModelParameterTarget | null {
  return modelParameterTargetFromRecord({
    provider: query.get('provider'),
    endpoint: query.get('endpoint'),
    protocol: query.get('protocol'),
    model: query.get('model'),
  });
}

export const modelParametersPlugin: PicoPlugin = {
  id: PLUGIN_ID,
  name: 'Model parameters',
  version: '0.1.0',
  pipelinePriority: { model: -100 },
  activate({ pipelines, state, http, ui }) {
    const savedSelection = (target: ModelParameterTarget): ModelParameterSelection | undefined => {
      const stored: unknown = state.get(selectionsKey, {});
      if (!isRecord(stored)) return undefined;
      const value = stored[modelParameterTargetKey(target)];
      return isRecord(value) ? (value as ModelParameterSelection) : undefined;
    };

    const legacyChatGptSelection = (target: ModelParameterTarget): ModelParameterSelection | undefined => {
      if (target.provider !== 'chatgpt-plan' || profileForTarget(target)?.id !== 'openai.chatgpt-plan.responses') {
        return undefined;
      }
      const legacy: unknown = state.get('legacyChatGptPreferences', null);
      if (!isRecord(legacy)) return undefined;
      return {
        ...(typeof legacy.reasoningEffort === 'string' ? { reasoningEffort: legacy.reasoningEffort } : {}),
        ...(typeof legacy.fastMode === 'boolean' ? { fastMode: legacy.fastMode } : {}),
      };
    };

    const selectionFor = (target: ModelParameterTarget): ModelParameterSelection => {
      const saved = savedSelection(target);
      return sanitizeSelection(target, saved ?? legacyChatGptSelection(target) ?? {});
    };

    const profileView = (target: ModelParameterTarget) => ({
      profileId: profileForTarget(target)?.id ?? null,
      controls: controlsForTarget(target),
      temperature: temperatureForTarget(target),
      values: selectionFor(target),
    });

    http.register('GET', '/profile', ({ query }) => {
      const target = targetFromQuery(query);
      if (!target) throw new Error('A valid model provider, endpoint, protocol, and model are required.');
      return profileView(target);
    });

    http.register('PUT', '/selection', ({ body }) => {
      if (!isRecord(body)) throw new Error('Model parameter selection must be an object.');
      const target = modelParameterTargetFromRecord(body.target);
      if (!target) throw new Error('A valid model parameter target is required.');
      const selection = validateSelection(target, body.selection);
      if (!selection) throw new Error('The selected values are not available for this model.');
      const stored: unknown = state.get(selectionsKey, {});
      const next = isRecord(stored) ? { ...stored } : {};
      next[modelParameterTargetKey(target)] = selection;
      state.set(selectionsKey, next);
      return profileView(target);
    });

    pipelines.use<ModelStageInput, ModelResponse>('model', async (input, next) => {
      if (!input.modelTarget) return next();
      const target = modelParameterTargetFromSettings(input.modelTarget);
      if (!target.endpoint) return next();
      const capability = temperatureForTarget(target);
      const temperature =
        capability.mode === 'adjustable'
          ? Math.max(capability.min, Math.min(capability.max, input.prompt.temperature))
          : capability.mode === 'fixed'
            ? capability.value
            : null;
      return next({
        ...input,
        requestParameters: {
          fields: serializeSelection(target, selectionFor(target), input.prompt.temperature) ?? {},
          temperature,
        },
      });
    });

    ui.contribute({
      slot: 'composer.model',
      id: 'model-parameters',
      label: 'Model controls',
      description: 'Model-specific reasoning controls.',
      entry: 'webui',
      component: 'ModelParameterComposer',
    });
    ui.contribute({
      slot: 'composer.model',
      id: 'model-parameters-others',
      label: 'Others',
      description: 'Additional model settings, including temperature when supported.',
      entry: 'webui',
      component: 'ModelParameterOthers',
      supportsPopover: true,
      providers: ['openai-compatible'],
    });
  },
};
