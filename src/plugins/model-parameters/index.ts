import type { ModelParameterSelection, ModelParameterTarget } from './types.js';
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
  activate({ pipelines, http, ui, threads, models, state }) {
    for (const provider of ['openai-compatible', 'chatgpt-plan']) {
      const targetFromSelection = (selectionTarget: Parameters<typeof modelParameterTargetFromSettings>[0]) =>
        modelParameterTargetFromSettings(selectionTarget);
      const initialSelection = (
        selectionTarget: Parameters<typeof modelParameterTargetFromSettings>[0],
      ): ModelParameterSelection => {
        const target = targetFromSelection(selectionTarget);
        const stored: unknown = state.get('selections', {});
        if (isRecord(stored)) {
          const saved = stored[modelParameterTargetKey(target)];
          if (isRecord(saved)) return sanitizeSelection(target, saved);
        }
        if (target.provider === 'chatgpt-plan' && profileForTarget(target)?.id === 'openai.chatgpt-plan.responses') {
          const legacy: unknown = state.get('legacyChatGptPreferences', null);
          if (isRecord(legacy)) {
            return sanitizeSelection(target, {
              ...(typeof legacy.reasoningEffort === 'string' ? { reasoningEffort: legacy.reasoningEffort } : {}),
              ...(typeof legacy.fastMode === 'boolean' ? { fastMode: legacy.fastMode } : {}),
            });
          }
        }
        return {};
      };
      models.registerSelectionNormalizer(
        provider,
        (selectionTarget, options) => {
          const target = modelParameterTargetFromSettings(selectionTarget);
          const validated = validateSelection(target, options);
          if (validated) return validated;
          if (Object.keys(options).length > 0) {
            throw new Error(`The selected model does not support option(s): ${Object.keys(options).join(', ')}.`);
          }
          return {};
        },
        initialSelection,
      );
    }

    const profileView = (target: ModelParameterTarget, values: ModelParameterSelection = {}) => ({
      profileId: profileForTarget(target)?.id ?? null,
      controls: controlsForTarget(target),
      temperature: temperatureForTarget(target),
      values: sanitizeSelection(target, values),
    });

    http.register('GET', '/profile', ({ query }) => {
      const target = targetFromQuery(query);
      if (!target) throw new Error('A valid model provider, endpoint, protocol, and model are required.');
      const threadId = query.get('threadId') ?? '';
      if (!threadId) throw new Error('threadId is required.');
      const selection = threads.modelSelection(threadId);
      if (selection.provider !== target.provider || selection.model !== target.model)
        throw new Error('Thread model selection changed.');
      return {
        ...profileView(target, selection.parameters.options),
        temperatureValue: selection.parameters.temperature,
      };
    });

    http.register('PUT', '/selection', ({ body }) => {
      if (!isRecord(body)) throw new Error('Model parameter selection must be an object.');
      const target = modelParameterTargetFromRecord(body.target);
      if (!target) throw new Error('A valid model parameter target is required.');
      const threadId = typeof body.threadId === 'string' ? body.threadId : '';
      if (!threadId) throw new Error('threadId is required.');
      const selection = validateSelection(target, body.selection);
      if (!selection) throw new Error('The selected values are not available for this model.');
      const current = threads.modelSelection(threadId);
      if (current.provider !== target.provider || current.model !== target.model)
        throw new Error('Thread model selection changed.');
      const saved = threads.validateModelSelection({
        ...current,
        parameters: { ...current.parameters, options: selection },
      });
      const updated = threads.updateModelSelection(threadId, saved);
      return { ...profileView(target, updated.parameters.options), temperatureValue: updated.parameters.temperature };
    });

    pipelines.use('model', async (input, next) => {
      if (!input.modelTarget) return next();
      const target = modelParameterTargetFromSettings(input.modelTarget);
      if (!target.endpoint) return next();
      const semantic = input.selectionParameters?.options ?? {};
      const normalized = validateSelection(target, semantic);
      if (
        (Object.keys(semantic).length > 0 && !normalized) ||
        (!profileForTarget(target) && Object.keys(semantic).length > 0)
      ) {
        throw new Error('Thread model options are not supported by the selected provider and model.');
      }
      const capability = temperatureForTarget(target);
      const selectionTemperature = input.selectionParameters?.temperature ?? input.prompt.temperature;
      const requestedTemperature = input.requestParameters?.temperature;
      const temperature =
        requestedTemperature !== undefined
          ? requestedTemperature
          : capability.mode === 'adjustable'
            ? Math.max(capability.min, Math.min(capability.max, selectionTemperature))
            : capability.mode === 'fixed'
              ? capability.value
              : null;
      const serializedSelection = profileForTarget(target)
        ? serializeSelection(target, normalized ?? {}, selectionTemperature)
        : undefined;
      return next({
        ...input,
        requestParameters: {
          fields: {
            ...input.requestParameters?.fields,
            ...(serializedSelection ?? {}),
          },
          temperature: requestedTemperature ?? temperature,
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
