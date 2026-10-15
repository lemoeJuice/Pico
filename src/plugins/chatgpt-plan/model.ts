import type { TokenUsage, ToolCall, ToolDefinition } from '../../core/types.js';
import type { ChatGptPlanAuth } from './auth.js';
import type { ModelPrompt, ModelRequestTrace, ModelResponse, ProviderRequestSummary } from '../../runtime/model.js';
import type { ChatGptPlanPreferences } from './types.js';

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

function errorCodeFrom(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : undefined;
}

function outputItemCounts(response: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(response.output)) return counts;
  for (const rawItem of response.output) {
    const item = object(rawItem);
    const type = typeof item?.type === 'string' ? item.type : 'unknown';
    if (/^[a-z0-9_.:-]{1,80}$/i.test(type)) counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

interface TracedRequest {
  response: Response;
  startedAt: number;
  settle(summary: ProviderRequestSummary): void;
}

export class ChatGptResponsesAdapter {
  constructor(
    private readonly auth: ChatGptPlanAuth,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async complete(
    prompt: ModelPrompt,
    preferences: ChatGptPlanPreferences,
    signal: AbortSignal,
    onText: (delta: string) => void,
    requestTrace?: ModelRequestTrace,
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
      ...(preferences.reasoningEffort === 'auto' ? {} : { reasoning: { effort: preferences.reasoningEffort } }),
      ...(preferences.fastMode ? { service_tier: 'fast' } : {}),
    };
    let accessToken = await this.auth.accessToken();
    let tracedRequest = await this.requestTraced(body, accessToken, signal, requestTrace, 1);
    // A token may be revoked between the proactive refresh check and this request.
    if (tracedRequest.response.status === 401) {
      await tracedRequest.response.body?.cancel().catch(() => undefined);
      try {
        accessToken = await this.auth.accessToken(true);
      } catch (error) {
        tracedRequest.settle({
          outcome: 'failed',
          durationMs: Date.now() - tracedRequest.startedAt,
          terminalEvent: 'http_response',
          errorCategory: 'http',
          errorCode: 'http_401',
        });
        throw error;
      }
      tracedRequest.settle({
        outcome: 'retrying',
        durationMs: Date.now() - tracedRequest.startedAt,
        terminalEvent: 'http_response',
        errorCategory: 'http',
        errorCode: 'http_401',
      });
      tracedRequest = await this.requestTraced(body, accessToken, signal, requestTrace, 2);
    }
    const response = tracedRequest.response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      tracedRequest.settle({
        outcome: 'failed',
        durationMs: Date.now() - tracedRequest.startedAt,
        terminalEvent: 'http_response',
        errorCategory: 'http',
        errorCode: `http_${response.status}`,
      });
      throw new Error(`ChatGPT model request returned HTTP ${response.status}.`);
    }
    if (!response.body) {
      tracedRequest.settle({
        outcome: 'failed',
        durationMs: Date.now() - tracedRequest.startedAt,
        terminalEvent: 'http_response',
        errorCategory: 'protocol',
        errorCode: 'empty_stream',
      });
      throw new Error('ChatGPT returned an empty Responses stream.');
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch (error) {
      const interrupted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      tracedRequest.settle({
        outcome: interrupted ? 'interrupted' : 'failed',
        durationMs: Date.now() - tracedRequest.startedAt,
        errorCategory: interrupted ? 'aborted' : 'protocol',
        errorCode: interrupted ? 'aborted' : 'invalid_stream',
      });
      throw error;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData: string[] = [];
    let finalResponse: Record<string, unknown> | null = null;
    let streamFailure: string | null = null;
    let streamFailureCode: string | undefined;
    let failureCategory: ProviderRequestSummary['errorCategory'];
    let failureCode: string | undefined;
    let terminalEvent: string | undefined;
    const eventCounts: Record<string, number> = {};
    let firstTextMs: number | undefined;
    let deltaTextCharacters = 0;
    let ended = false;
    const countEvent = (name: string): void => {
      if (/^[a-z0-9_.:-]{1,80}$/i.test(name)) eventCounts[name] = (eventCounts[name] ?? 0) + 1;
    };
    const consumeEvent = (): void => {
      if (eventData.length === 0) return;
      const data = eventData.join('\n');
      eventData = [];
      if (data === '[DONE]') {
        countEvent('done');
        terminalEvent = 'done';
        ended = true;
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        failureCategory = 'protocol';
        failureCode = 'invalid_json';
        throw new Error('ChatGPT returned invalid streaming JSON.');
      }
      const value = object(event);
      if (!value || typeof value.type !== 'string') return;
      countEvent(value.type);
      if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') {
        if (value.delta.length > 0 && firstTextMs === undefined) firstTextMs = Date.now() - tracedRequest.startedAt;
        deltaTextCharacters += value.delta.length;
        onText(value.delta);
      } else if (value.type === 'response.completed') {
        terminalEvent = value.type;
        finalResponse = object(value.response);
        ended = true;
      } else if (value.type === 'response.failed' || value.type === 'error') {
        const responseError = object(object(value.response)?.error);
        const error = object(value.error) ?? responseError;
        const code = typeof error?.code === 'string' ? error.code : null;
        streamFailureCode = code && /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : undefined;
        streamFailure = streamFailureCode
          ? `ChatGPT model request failed (${streamFailureCode}).`
          : 'ChatGPT model request failed.';
        terminalEvent = value.type;
        ended = true;
      } else if (value.type === 'response.incomplete') {
        terminalEvent = value.type;
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
      const interrupted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      tracedRequest.settle({
        outcome: interrupted ? 'interrupted' : 'failed',
        durationMs: Date.now() - tracedRequest.startedAt,
        ...(terminalEvent ? { terminalEvent } : {}),
        errorCategory: interrupted ? 'aborted' : (failureCategory ?? 'transport'),
        ...((interrupted ? 'aborted' : (failureCode ?? errorCodeFrom(error)))
          ? { errorCode: interrupted ? 'aborted' : (failureCode ?? errorCodeFrom(error))! }
          : {}),
        eventCounts,
        ...(firstTextMs === undefined ? {} : { firstTextMs }),
        deltaTextCharacters,
      });
      throw error;
    }
    await reader.cancel().catch(() => undefined);
    try {
      if (streamFailure) {
        failureCategory = 'protocol';
        failureCode = streamFailureCode ?? 'response_failed';
        throw new Error(streamFailure);
      }
      const completedResponse = finalResponse as Record<string, unknown> | null;
      if (!completedResponse) {
        failureCategory = 'protocol';
        failureCode = 'missing_completion';
        throw new Error('ChatGPT stream ended before the model step completed.');
      }
      if (completedResponse.status === 'incomplete') {
        const incomplete = object(completedResponse.incomplete_details);
        if (incomplete?.reason !== 'max_output_tokens') {
          failureCategory = 'protocol';
          failureCode = typeof incomplete?.reason === 'string' ? incomplete.reason : 'incomplete';
          throw new Error('ChatGPT response was incomplete.');
        }
      }
      const result = outputFrom(completedResponse, prompt);
      // Deltas are transient until this complete result is returned to the Runtime.
      tracedRequest.settle({
        outcome: 'completed',
        durationMs: Date.now() - tracedRequest.startedAt,
        ...(terminalEvent ? { terminalEvent } : {}),
        eventCounts,
        ...(firstTextMs === undefined ? {} : { firstTextMs }),
        deltaTextCharacters,
        outputTextCharacters: result.content.length,
        outputItemCounts: outputItemCounts(completedResponse),
        toolCallCount: result.toolCalls.length,
        finishReason: result.finishReason,
        ...(typeof completedResponse.id === 'string' ? { responseId: completedResponse.id } : {}),
        usage: result.usage,
      });
      return result;
    } catch (error) {
      const interrupted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      tracedRequest.settle({
        outcome: interrupted ? 'interrupted' : 'failed',
        durationMs: Date.now() - tracedRequest.startedAt,
        ...(terminalEvent ? { terminalEvent } : {}),
        errorCategory: interrupted ? 'aborted' : (failureCategory ?? 'protocol'),
        ...((interrupted ? 'aborted' : (failureCode ?? errorCodeFrom(error)))
          ? { errorCode: interrupted ? 'aborted' : (failureCode ?? errorCodeFrom(error))! }
          : {}),
        eventCounts,
        ...(firstTextMs === undefined ? {} : { firstTextMs }),
        deltaTextCharacters,
      });
      throw error;
    }
  }

  private async requestTraced(
    body: Record<string, unknown>,
    accessToken: string,
    signal: AbortSignal,
    trace: ModelRequestTrace | undefined,
    attempt: number,
  ): Promise<TracedRequest> {
    const startedAt = Date.now();
    const providerAttemptId =
      trace?.started({
        provider: 'chatgpt-plan',
        protocol: 'https+sse',
        endpoint: responsesUrl,
        attempt,
      }) ?? '';
    let settled = false;
    const settle = (summary: ProviderRequestSummary): void => {
      if (settled) return;
      settled = true;
      if (providerAttemptId) trace?.settled(providerAttemptId, summary);
    };
    try {
      const response = await this.request(body, accessToken, signal);
      if (providerAttemptId) {
        const providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('openai-request-id');
        trace?.response(providerAttemptId, {
          status: response.status,
          contentType: response.headers.get('content-type'),
          ...(providerRequestId ? { providerRequestId } : {}),
        });
      }
      return { response, startedAt, settle };
    } catch (error) {
      const interrupted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      settle({
        outcome: interrupted ? 'interrupted' : 'failed',
        durationMs: Date.now() - startedAt,
        errorCategory: interrupted ? 'aborted' : 'transport',
        ...((interrupted ? 'aborted' : errorCodeFrom(error))
          ? { errorCode: interrupted ? 'aborted' : errorCodeFrom(error)! }
          : {}),
      });
      throw error;
    }
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
