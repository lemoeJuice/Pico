import type { ModelSettings, PublicSettings } from '../../core/types.js';
import type { ModelParameterTarget } from './types.js';

export const CHATGPT_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

export function normalizeModelEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function protocolFor(provider: string): ModelParameterTarget['protocol'] {
  if (provider === 'chatgpt-plan') return 'openai-responses';
  if (provider !== 'openai-compatible') return 'provider-native';
  // The Runtime's OpenAI-compatible adapter currently sends Chat Completions requests.
  return 'openai-chat-completions';
}

export function modelParameterTargetFromSettings(
  settings: Pick<ModelSettings, 'provider' | 'baseUrl' | 'model'> | Pick<PublicSettings, 'provider' | 'baseUrl' | 'model'>,
): ModelParameterTarget {
  const provider = settings.provider;
  const endpoint = normalizeModelEndpoint(provider === 'chatgpt-plan' ? CHATGPT_RESPONSES_ENDPOINT : settings.baseUrl);
  return {
    provider,
    endpoint,
    protocol: endpoint ? protocolFor(provider) : 'provider-native',
    model: settings.model.trim(),
  };
}

export function modelParameterTargetFromRecord(value: unknown): ModelParameterTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (
    typeof target.provider !== 'string' ||
    typeof target.endpoint !== 'string' ||
    typeof target.protocol !== 'string' ||
    typeof target.model !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(target.provider) ||
    !['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'provider-native'].includes(target.protocol) ||
    target.model.length > 300
  ) {
    return null;
  }
  const endpoint = normalizeModelEndpoint(target.endpoint);
  if (!endpoint) return null;
  return {
    provider: target.provider,
    endpoint,
    protocol: target.protocol as ModelParameterTarget['protocol'],
    model: target.model.trim(),
  };
}

export function modelParameterTargetKey(target: ModelParameterTarget): string {
  return JSON.stringify([target.provider, normalizeModelEndpoint(target.endpoint), target.protocol, target.model]);
}
