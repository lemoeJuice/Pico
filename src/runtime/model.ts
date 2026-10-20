import type { ModelSettings, TokenUsage } from '../core/types.js';
import type {
  ModelPrompt,
  ModelRequestParameters,
  ModelRequestTrace,
  ModelResponse,
  ModelStreamEvent,
} from '../contracts/model.js';
import { isDeepSeekModelId } from './model-compat.js';

export type {
  ModelPrompt,
  ModelRequestParameters,
  ModelRequestTrace,
  ModelResponse,
  ModelStreamEvent,
  PromptTurn,
  ProviderRequestOutcome,
  ProviderRequestResponse,
  ProviderRequestStart,
  ProviderRequestSummary,
} from '../contracts/model.js';

export interface ModelAdapter {
  complete(
    prompt: ModelPrompt,
    settings: ModelSettings,
    signal: AbortSignal,
    onText: (delta: string) => void,
    requestTrace?: ModelRequestTrace,
    onEvent?: (event: ModelStreamEvent) => void,
    requestParameters?: ModelRequestParameters,
  ): Promise<ModelResponse>;
}

interface OpenAiToolCall {
  index: number;
  id?: string;
  name: string;
  arguments: string;
}

function endpointFor(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Model API base URL is required');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function toWireMessages(prompt: ModelPrompt): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: prompt.system }];
  for (let index = 0; index < prompt.turns.length; index += 1) {
    const turn = prompt.turns[index]!;
    if (turn.kind === 'message') {
      messages.push({
        role: turn.role,
        content: turn.content,
        ...(turn.role === 'assistant' && isDeepSeekModelId(prompt.model) && typeof turn.reasoningContent === 'string'
          ? { reasoning_content: turn.reasoningContent }
          : {}),
      });
    } else if (turn.kind === 'assistant_tools') {
      messages.push({
        role: 'assistant',
        content: turn.content || null,
        ...(isDeepSeekModelId(prompt.model) && typeof turn.reasoningContent === 'string'
          ? { reasoning_content: turn.reasoningContent }
          : {}),
        tool_calls: turn.calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
    } else {
      const batchId = turn.batchId;
      const group = [turn];
      while (index + 1 < prompt.turns.length) {
        const next = prompt.turns[index + 1]!;
        if (next.kind !== 'tool_result') break;
        if (batchId ? next.batchId !== batchId : Boolean(next.batchId)) break;
        group.push(next);
        index += 1;
      }
      for (const result of group) {
        messages.push({ role: 'tool', tool_call_id: result.callId, name: result.toolName, content: result.content });
      }
      for (const result of group) {
        if (!result.images?.length) continue;
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `Images returned by tool ${result.toolName} (call id ${result.callId}).` },
            ...result.images.map((image) => ({
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.data}` },
            })),
          ],
        });
      }
    }
  }
  return messages;
}

function usageFrom(value: unknown, models: string[]): TokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  const rawPromptDetails = usage.prompt_tokens_details;
  const promptDetails =
    rawPromptDetails && typeof rawPromptDetails === 'object' && !Array.isArray(rawPromptDetails)
      ? (rawPromptDetails as Record<string, unknown>)
      : null;
  const cachedInputTokens =
    typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined;
  const cacheWriteTokens =
    typeof promptDetails?.cache_write_tokens === 'number' ? promptDetails.cache_write_tokens : undefined;
  const deepSeekUsage = models.some(isDeepSeekModelId);
  const deepSeekCacheHits =
    deepSeekUsage && typeof usage.prompt_cache_hit_tokens === 'number'
      ? usage.prompt_cache_hit_tokens
      : undefined;
  // DeepSeek misses are ordinary input tokens; the API does not report them as cache writes.
  const deepSeekCacheMisses =
    deepSeekUsage && typeof usage.prompt_cache_miss_tokens === 'number'
      ? usage.prompt_cache_miss_tokens
      : undefined;
  const resolvedInputTokens =
    inputTokens ??
    (deepSeekCacheHits !== undefined && deepSeekCacheMisses !== undefined
      ? deepSeekCacheHits + deepSeekCacheMisses
      : undefined);
  const resolvedCachedInputTokens = cachedInputTokens ?? deepSeekCacheHits;
  if (
    resolvedInputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    resolvedCachedInputTokens === undefined &&
    cacheWriteTokens === undefined
  )
    return null;
  return {
    ...(resolvedInputTokens === undefined ? {} : { inputTokens: resolvedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(resolvedCachedInputTokens === undefined ? {} : { cachedInputTokens: resolvedCachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function parseToolArguments(value: string, name: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Tool arguments for ${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export class OpenAiCompatibleAdapter implements ModelAdapter {
  async complete(
    prompt: ModelPrompt,
    settings: ModelSettings,
    signal: AbortSignal,
    onText: (delta: string) => void,
    requestTrace?: ModelRequestTrace,
    onEvent?: (event: ModelStreamEvent) => void,
    requestParameters?: ModelRequestParameters,
  ): Promise<ModelResponse> {
    if (!prompt.model.trim()) throw new Error('Choose a model in Settings before sending a message.');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
    };
    if (settings.apiKey.trim()) headers.authorization = `Bearer ${settings.apiKey.trim()}`;
    const endpoint = endpointFor(settings.baseUrl);
    const startedAt = Date.now();
    const providerAttemptId = requestTrace?.started({
      provider: settings.provider,
      protocol: 'chat-completions',
      endpoint,
      attempt: 1,
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: prompt.model,
        ...(requestParameters?.temperature === null
          ? {}
          : { temperature: requestParameters?.temperature ?? prompt.temperature }),
        stream: true,
        stream_options: { include_usage: true },
        messages: toWireMessages(prompt),
        tools: prompt.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        parallel_tool_calls: true,
        ...requestParameters?.fields,
      }),
    });
    if (providerAttemptId) {
      requestTrace?.response(providerAttemptId, {
        status: response.status,
        contentType: response.headers.get('content-type'),
        ...(response.headers.get('x-request-id') ? { providerRequestId: response.headers.get('x-request-id')! } : {}),
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const excerpt = body ? `: ${body.slice(0, 1200)}` : '';
      throw new Error(`Model provider returned HTTP ${response.status} ${response.statusText}${excerpt}`);
    }
    if (!response.body) throw new Error('Model provider returned an empty response stream');
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const value = (await response.json()) as Record<string, unknown>;
      const choices = value.choices as Array<Record<string, unknown>> | undefined;
      const message = choices?.[0]?.message as Record<string, unknown> | undefined;
      if (!message) throw new Error('Model provider response did not include a choice');
      const content = typeof message.content === 'string' ? message.content : '';
      if (content) onText(content);
      const responseModel = typeof value.model === 'string' ? value.model : prompt.model;
      const reasoningContent =
        (isDeepSeekModelId(prompt.model) || isDeepSeekModelId(responseModel)) &&
        typeof message.reasoning_content === 'string'
          ? (message.reasoning_content as string)
          : undefined;
      const reasoningSummary =
        typeof message.reasoning_summary === 'string'
          ? message.reasoning_summary
          : typeof message.reasoning_summary_text === 'string'
            ? message.reasoning_summary_text
            : undefined;
      const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
      const result: ModelResponse = {
        content,
        ...(reasoningSummary ? { reasoningSummary } : {}),
        ...(reasoningContent ? { reasoningContent } : {}),
        toolCalls: calls.map((item, index) => {
          const fn = item.function as Record<string, unknown> | undefined;
          const name = typeof fn?.name === 'string' ? fn.name : '';
          return {
            id: typeof item.id === 'string' ? item.id : `tool-${index}`,
            name,
            arguments: parseToolArguments(typeof fn?.arguments === 'string' ? fn.arguments : '{}', name),
          };
        }),
        usage: usageFrom(value.usage, [prompt.model, responseModel]),
        model: responseModel,
        finishReason: typeof choices?.[0]?.finish_reason === 'string' ? (choices[0]!.finish_reason as string) : null,
      };
      if (providerAttemptId) {
        requestTrace?.settled(providerAttemptId, {
          outcome: 'completed',
          durationMs: Date.now() - startedAt,
          toolCallCount: result.toolCalls.length,
          finishReason: result.finishReason,
          usage: result.usage,
        });
      }
      return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningSummary = '';
    let reasoningContent = '';
    let usage: TokenUsage | null = null;
    let actualModel = prompt.model;
    let finishReason: string | null = null;
    let done = false;
    const calls = new Map<number, OpenAiToolCall>();
    const consume = (line: string): void => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new Error('Model provider sent invalid streaming JSON');
      }
      if (typeof chunk.model === 'string') actualModel = chunk.model;
      usage = usageFrom(chunk.usage, [prompt.model, actualModel]) ?? usage;
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (!choice) return;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      const deepSeekReasoningDelta =
        (isDeepSeekModelId(prompt.model) || isDeepSeekModelId(actualModel)) &&
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : undefined;
      if (deepSeekReasoningDelta !== undefined) reasoningContent += deepSeekReasoningDelta;
      const reasoningDelta =
        deepSeekReasoningDelta !== undefined
          ? deepSeekReasoningDelta
          : typeof delta.reasoning_summary_text === 'string'
            ? delta.reasoning_summary_text
            : typeof delta.reasoning_summary === 'string'
              ? delta.reasoning_summary
              : undefined;
      if (reasoningDelta) {
        if (deepSeekReasoningDelta === undefined) reasoningSummary += reasoningDelta;
        onEvent?.({ type: 'reasoning_summary.delta', delta: reasoningDelta });
      }
      const chunks = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
      for (const item of chunks) {
        const index = typeof item.index === 'number' ? item.index : calls.size;
        const current = calls.get(index) ?? { index, name: '', arguments: '' };
        if (typeof item.id === 'string') current.id = item.id;
        const fn = item.function as Record<string, unknown> | undefined;
        if (typeof fn?.name === 'string') current.name += fn.name;
        if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
        calls.set(index, current);
        onEvent?.({
          type: 'tool_call.preview',
          index,
          ...(current.id ? { id: current.id } : {}),
          ...(current.name ? { name: current.name } : {}),
          argumentsText: current.arguments,
        });
      }
    };
    const processBuffer = (final = false): void => {
      const lines = buffer.split(/\r?\n/);
      buffer = final ? '' : (lines.pop() ?? '');
      for (const line of lines) consume(line);
      if (final && buffer) consume(buffer);
    };

    try {
      while (!done) {
        const { value, done: streamEnded } = await reader.read();
        if (streamEnded) {
          buffer += decoder.decode();
          processBuffer(true);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        processBuffer();
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    await reader.cancel().catch(() => undefined);
    if (!finishReason && !done) throw new Error('Model stream ended before the step completed');
    const toolCalls = [...calls.values()]
      .sort((a, b) => a.index - b.index)
      .map((call, index) => ({
        id: call.id ?? `tool-${index}`,
        name: call.name,
        arguments: parseToolArguments(call.arguments, call.name),
      }));
    const result = {
      content,
      ...(reasoningSummary ? { reasoningSummary } : {}),
      ...(reasoningContent ? { reasoningContent } : {}),
      toolCalls,
      usage,
      model: actualModel,
      finishReason,
    };
    if (providerAttemptId) {
      requestTrace?.settled(providerAttemptId, {
        outcome: 'completed',
        durationMs: Date.now() - startedAt,
        toolCallCount: result.toolCalls.length,
        finishReason: result.finishReason,
        usage: result.usage,
      });
    }
    return result;
  }
}
