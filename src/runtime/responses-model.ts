import type { ModelSettings, TokenUsage, ToolCall, ToolDefinition } from '../core/types.js';
import type { ChatGptPlanAuth } from './chatgpt-auth.js';
import type { ModelAdapter, ModelPrompt, ModelResponse } from './model.js';

const responsesUrl = 'https://api.openai.com/v1/responses';

function responseInput(prompt: ModelPrompt): Array<Record<string, unknown>> {
  return prompt.turns.flatMap((turn): Array<Record<string, unknown>> => {
    if (turn.kind === 'message') return [{ role: turn.role, content: turn.content }];
    if (turn.kind === 'assistant_tools') {
      return [
        ...(turn.content ? [{ role: 'assistant', content: turn.content }] : []),
        ...turn.calls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        })),
      ];
    }
    return [{ type: 'function_call_output', call_id: turn.callId, output: turn.content }];
  });
}

function responseTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readUsage(value: unknown): TokenUsage | null {
  const usage = object(value);
  if (!usage) return null;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (input === undefined && output === undefined && total === undefined) return null;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
  };
}

function parseArguments(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Model returned invalid arguments for tool ${name}.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Tool arguments for ${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function outputFrom(response: Record<string, unknown>, prompt: ModelPrompt): ModelResponse {
  const output = Array.isArray(response.output) ? response.output : [];
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const rawItem of output) {
    const item = object(rawItem);
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const rawContent of item.content) {
        const part = object(rawContent);
        if (part?.type === 'output_text' && typeof part.text === 'string') content += part.text;
        if (part?.type === 'refusal' && typeof part.refusal === 'string') content += part.refusal;
      }
    } else if (item.type === 'function_call' && typeof item.name === 'string') {
      toolCalls.push({
        id: typeof item.call_id === 'string' ? item.call_id : `call-${toolCalls.length}`,
        name: item.name,
        arguments: parseArguments(item.arguments, item.name),
      });
    }
  }
  const incomplete = object(response.incomplete_details);
  return {
    content,
    toolCalls,
    usage: readUsage(response.usage),
    model: typeof response.model === 'string' ? response.model : prompt.model,
    finishReason:
      response.status === 'incomplete'
        ? incomplete?.reason === 'max_output_tokens'
          ? 'length'
          : 'incomplete'
        : toolCalls.length > 0
          ? 'tool_calls'
          : 'stop',
  };
}

export class ChatGptResponsesAdapter implements ModelAdapter {
  constructor(
    private readonly auth: ChatGptPlanAuth,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async complete(
    prompt: ModelPrompt,
    settings: ModelSettings,
    signal: AbortSignal,
    onText: (delta: string) => void,
  ): Promise<ModelResponse> {
    if (!prompt.model.trim()) throw new Error('Choose a ChatGPT model in Settings before sending a message.');
    const body: Record<string, unknown> = {
      model: prompt.model,
      instructions: prompt.system,
      input: responseInput(prompt),
      store: false,
      stream: true,
      parallel_tool_calls: true,
      tools: responseTools(prompt.tools),
      ...((prompt.reasoningEffort ?? settings.reasoningEffort) === 'auto'
        ? {}
        : { reasoning: { effort: prompt.reasoningEffort ?? settings.reasoningEffort } }),
      ...((prompt.fastMode ?? settings.fastMode) ? { service_tier: 'fast' } : {}),
    };
    let accessToken = await this.auth.accessToken();
    let response = await this.request(body, accessToken, signal);
    // A token may be revoked between the proactive refresh check and this request.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      accessToken = await this.auth.accessToken(true);
      response = await this.request(body, accessToken, signal);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `ChatGPT model request returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 1200)}` : ''}`,
      );
    }
    if (!response.body) throw new Error('ChatGPT returned an empty Responses stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData: string[] = [];
    let finalResponse: Record<string, unknown> | null = null;
    let streamFailure: string | null = null;
    let ended = false;
    const consumeEvent = (): void => {
      if (eventData.length === 0) return;
      const data = eventData.join('\n');
      eventData = [];
      if (data === '[DONE]') {
        ended = true;
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error('ChatGPT returned invalid streaming JSON.');
      }
      const value = object(event);
      if (!value || typeof value.type !== 'string') return;
      if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') {
        onText(value.delta);
      } else if (value.type === 'response.completed') {
        finalResponse = object(value.response);
        ended = true;
      } else if (value.type === 'response.failed' || value.type === 'error') {
        const responseError = object(object(value.response)?.error);
        const error = object(value.error) ?? responseError;
        const code = typeof error?.code === 'string' ? error.code : null;
        const message = typeof error?.message === 'string' ? error.message : null;
        streamFailure = code
          ? `ChatGPT model request failed (${code})${message ? `: ${message}` : ''}`
          : (message ?? 'ChatGPT model request failed.');
        ended = true;
      } else if (value.type === 'response.incomplete') {
        finalResponse = object(value.response);
        ended = true;
      }
    };
    const processLines = (final = false): void => {
      const lines = buffer.split(/\r?\n/);
      buffer = final ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (!line) consumeEvent();
        else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
      }
      if (final) consumeEvent();
    };

    try {
      while (!ended) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          processLines(true);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        processLines();
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    await reader.cancel().catch(() => undefined);
    if (streamFailure) throw new Error(streamFailure);
    const completedResponse = finalResponse as Record<string, unknown> | null;
    if (!completedResponse) throw new Error('ChatGPT stream ended before the model step completed.');
    if (completedResponse.status === 'incomplete') {
      const incomplete = object(completedResponse.incomplete_details);
      if (incomplete?.reason !== 'max_output_tokens') {
        const reason = typeof incomplete?.reason === 'string' ? ` (${incomplete.reason})` : '';
        throw new Error(`ChatGPT response was incomplete${reason}.`);
      }
    }
    const result = outputFrom(completedResponse, prompt);
    // Deltas are transient until this complete result is returned to the Runtime.
    return result;
  }

  private request(body: Record<string, unknown>, accessToken: string, signal: AbortSignal): Promise<Response> {
    return this.fetcher(responsesUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}
