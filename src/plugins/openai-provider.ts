import { ServiceError } from '../contracts/service-error.js';
import type { ProviderInstance, ProviderModel } from '../contracts/model-catalog.js';
import type { PicoPlugin, PluginHttpRequest } from './host.js';

const owner = 'pico.openai-provider';
const providerType = 'openai-compatible';
type Protocol = 'openai-chat-completions' | 'openai-responses';
interface Configuration {
  baseUrl: string;
  protocol: Protocol;
  models: string[];
}
function invalid(message: string): never {
  throw new ServiceError(400, message);
}
function configuration(value: unknown): { label: string; config: Configuration; apiKey: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Invalid provider configuration.');
  const input = value as Record<string, unknown>;
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 120) return invalid('Enter a provider name.');
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048) return invalid('Enter a valid API base URL.');
  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl.trim());
  } catch {
    return invalid('Enter a valid API base URL.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    /[?#]/.test(input.baseUrl) ||
    parsed.search ||
    parsed.hash
  )
    return invalid('API base URL must use HTTP or HTTPS and cannot contain credentials, a query, or a fragment.');
  if (input.protocol !== 'openai-chat-completions' && input.protocol !== 'openai-responses')
    return invalid('Choose a supported protocol.');
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 500)
    return invalid('Enter at least one model.');
  if (
    input.models.some(
      (model) =>
        typeof model !== 'string' ||
        !model.trim() ||
        model.length > 256 ||
        Array.from(model).some((character) => character.charCodeAt(0) < 32),
    )
  )
    return invalid('Invalid model name.');
  const models = [...new Set((input.models as string[]).map((model) => model.trim()))];
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey))
  )
    return invalid('Invalid API key.');
  return {
    label,
    config: { baseUrl: parsed.toString().replace(/\/+$/, ''), protocol: input.protocol, models },
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
  };
}
function modelEndpoint(config: Configuration): string {
  const suffix = config.protocol === 'openai-responses' ? '/responses' : '/chat/completions';
  return config.baseUrl.toLowerCase().endsWith(suffix) ? config.baseUrl : `${config.baseUrl}${suffix}`;
}
function modelsFor(instance: ProviderInstance): ProviderModel[] {
  const config = instance.config as unknown as Configuration;
  if (!config.baseUrl || !Array.isArray(config.models) || !config.protocol) return [];
  return config.models.map((model) => ({
    id: model,
    name: model,
    label: model,
    protocol: config.protocol,
    endpoint: modelEndpoint(config),
    supportsImages: true,
  }));
}
export const openAiProviderPlugin: PicoPlugin = {
  id: owner,
  name: 'OpenAI-compatible provider',
  version: '0.1.0',
  activate(context) {
    context.providers.registerType(
      {
        id: providerType,
        label: 'OpenAI-compatible',
        description: 'Connect an OpenAI-compatible API.',
        addPage: { pluginId: owner, pageId: 'add' },
        editPage: { pluginId: owner, pageId: 'add' },
      },
      {
        listModels: async (instance) => modelsFor(instance),
        authorize: async (instance, _refresh, signal) => {
          if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
          const key = context.providers.secrets(instance.id).get('apiKey', '');
          return key ? { authorization: `Bearer ${key}` } : {};
        },
      },
    );
    context.ui.registerPage({
      id: 'add',
      label: 'OpenAI-compatible',
      description: 'Add an API provider.',
      entry: 'webui',
    });
    context.http.register('GET', '/instances', () =>
      context.providers.list().filter((instance) => instance.typeId === providerType),
    );
    context.http.register('POST', '/instances', async (request) => {
      const { label, config, apiKey } = configuration(request.body);
      const instance = context.state.transaction(() => {
        const created = context.providers.add(providerType, { label, config: { ...config } });
        if (apiKey) context.providers.secrets(created.id).set('apiKey', apiKey);
        return created;
      });
      try {
        await context.providers.refresh(instance.id);
      } catch (error) {
        await context.providers.remove(instance.id);
        throw error;
      }
      return instance;
    });
    context.http.register('PUT', '/instances', async (request: PluginHttpRequest) => {
      const values = request.query.getAll('instanceId');
      const instance = values.length === 1 && values[0] ? context.providers.get(values[0]) : null;
      if (!instance || instance.typeId !== providerType) throw new ServiceError(404, 'Provider instance unavailable.');
      const { config, apiKey } = configuration({ ...(request.body as Record<string, unknown>), label: instance.label });
      const updated = context.state.transaction(() => {
        const result = context.providers.update(instance.id, { config: { ...config } });
        if (apiKey) context.providers.secrets(instance.id).set('apiKey', apiKey);
        return result;
      });
      try {
        await context.providers.refresh(instance.id);
        return { ...updated, refreshFailed: false };
      } catch {
        return { ...updated, refreshFailed: true };
      }
    });
    context.http.register('DELETE', '/instances', async (request: PluginHttpRequest) => {
      const values = request.query.getAll('instanceId');
      const instance = values.length === 1 && values[0] ? context.providers.get(values[0]) : null;
      if (!instance || instance.typeId !== providerType) throw new ServiceError(404, 'Provider instance unavailable.');
      await context.providers.remove(instance.id);
      return { removed: true };
    });
  },
};
