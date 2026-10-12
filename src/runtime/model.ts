import type { ModelSettings, TokenUsage, ToolCall, ToolDefinition } from '../core/types.js';

export type PromptTurn =
  | { kind: 'message'; role: 'user' | 'assistant'; content: string }
  | { kind: 'assistant_tools'; content: string; calls: ToolCall[] }
  | { kind: 'tool_result'; callId: string; toolName: string; content: string };

export interface ModelPrompt {
  system: string;
  turns: PromptTurn[];
  tools: ToolDefinition[];
  model: string;
  temperature: number;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage | null;
  model: string;
  finishReason: string | null;
}

export interface ModelAdapter {
  complete(
    prompt: ModelPrompt,
    settings: ModelSettings,
    signal: AbortSignal,
    onText: (delta: string) => void,
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
  for (const turn of prompt.turns) {
    if (turn.kind === 'message') messages.push({ role: turn.role, content: turn.content });
    else if (turn.kind === 'assistant_tools') {
      messages.push({
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
    } else {
      messages.push({ role: 'tool', tool_call_id: turn.callId, name: turn.toolName, content: turn.content });
    }
  }
  return messages;
}

function usageFrom(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
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
  ): Promise<ModelResponse> {
    if (!prompt.model.trim()) throw new Error('Choose a model in Settings before sending a message.');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
    };
    if (settings.apiKey.trim()) headers.authorization = `Bearer ${settings.apiKey.trim()}`;
    const response = await fetch(endpointFor(settings.baseUrl), {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: prompt.model,
        temperature: prompt.temperature,
        stream: true,
        messages: toWireMessages(prompt),
        tools: prompt.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        parallel_tool_calls: true,
      }),
    });
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
      const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
      return {
        content,
        toolCalls: calls.map((item, index) => {
          const fn = item.function as Record<string, unknown> | undefined;
          const name = typeof fn?.name === 'string' ? fn.name : '';
          return {
            id: typeof item.id === 'string' ? item.id : `tool-${index}`,
            name,
            arguments: parseToolArguments(typeof fn?.arguments === 'string' ? fn.arguments : '{}', name),
          };
        }),
        usage: usageFrom(value.usage),
        model: typeof value.model === 'string' ? value.model : prompt.model,
        finishReason: typeof choices?.[0]?.finish_reason === 'string' ? (choices[0]!.finish_reason as string) : null,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
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
      usage = usageFrom(chunk.usage) ?? usage;
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
      const chunks = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
      for (const item of chunks) {
        const index = typeof item.index === 'number' ? item.index : calls.size;
        const current = calls.get(index) ?? { index, name: '', arguments: '' };
        if (typeof item.id === 'string') current.id = item.id;
        const fn = item.function as Record<string, unknown> | undefined;
        if (typeof fn?.name === 'string') current.name += fn.name;
        if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
        calls.set(index, current);
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
    if (!finishReason && !done) throw new Error('Model stream ended before the step completed');
    const toolCalls = [...calls.values()]
      .sort((a, b) => a.index - b.index)
      .map((call, index) => ({
        id: call.id ?? `tool-${index}`,
        name: call.name,
        arguments: parseToolArguments(call.arguments, call.name),
      }));
    return { content, toolCalls, usage, model: actualModel, finishReason };
  }
}
