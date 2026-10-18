import type { TokenUsage, ToolCall, ToolDefinition } from '../../core/types.js';
import type { ChatGptPlanAuth } from './auth.js';
import type {
  ModelPrompt,
  ModelRequestParameters,
  ModelRequestTrace,
  ModelResponse,
  ModelStreamEvent,
  ProviderRequestSummary,
} from '../../contracts/model.js';

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
  const inputDetails = object(usage.input_tokens_details);
  const cached = typeof inputDetails?.cached_tokens === 'number' ? inputDetails.cached_tokens : undefined;
  const cacheWrite =
    typeof inputDetails?.cache_write_tokens === 'number' ? inputDetails.cache_write_tokens : undefined;
  if (
    input === undefined &&
    output === undefined &&
    total === undefined &&
    cached === undefined &&
    cacheWrite === undefined
  )
    return null;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
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
  const reasoningSummaryParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const rawItem of output) {
    const item = object(rawItem);
    if (!item) continue;
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const rawPart of item.summary) {
        const text = object(rawPart)?.text;
        if (typeof text === 'string' && text.length > 0) reasoningSummaryParts.push(text);
      }
    } else if (item.type === 'message' && Array.isArray(item.content)) {
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
  const reasoningSummary = reasoningSummaryParts.join('\n\n');
  return {
    content,
    ...(reasoningSummary ? { reasoningSummary } : {}),
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

interface StreamedFunctionCall {
  itemId?: string;
  outputIndex?: number;
  callId?: string;
  name?: string;
  argumentsText: string;
  argumentsComplete: boolean;
  order: number;
}

interface FinalFunctionCall {
  itemId?: string;
  outputIndex: number;
  callId?: string;
  argumentsText?: string;
  toolCallIndex: number;
}

function finalFunctionCalls(response: Record<string, unknown>): FinalFunctionCall[] {
  if (!Array.isArray(response.output)) return [];
  const calls: FinalFunctionCall[] = [];
  for (const [outputIndex, rawItem] of response.output.entries()) {
    const item = object(rawItem);
    if (item?.type !== 'function_call' || typeof item.name !== 'string') continue;
    calls.push({
      ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
      outputIndex,
      ...(typeof item.call_id === 'string' ? { callId: item.call_id } : {}),
      ...(typeof item.arguments === 'string' ? { argumentsText: item.arguments } : {}),
      toolCallIndex: calls.length,
    });
  }
  return calls;
}

function errorCodeFrom(error: unknown): string | undefined {
  let current: unknown = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function withProviderErrorCode(error: unknown, code: string | undefined): unknown {
  if (error instanceof Error && error.name === 'AbortError') return error;
  const resolvedCode = errorCodeFrom(error) ?? (code && /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : undefined);
  if (!resolvedCode) return error;
  if (object(error)?.code === resolvedCode) return error;
  const message = error instanceof Error ? error.message : 'ChatGPT model request failed.';
  const tagged = Object.assign(new Error(message), { cause: error, code: resolvedCode });
  if (error instanceof Error) tagged.name = error.name;
  return tagged;
}

function providerError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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
    signal: AbortSignal,
    onText: (delta: string) => void,
    requestTrace?: ModelRequestTrace,
    onEvent?: (event: ModelStreamEvent) => void,
    requestParameters?: ModelRequestParameters,
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
      reasoning: { summary: 'auto' },
      ...requestParameters?.fields,
    };
    let accessToken: string;
    try {
      accessToken = await this.auth.accessToken(false, requestTrace);
    } catch (error) {
      throw withProviderErrorCode(error, 'auth');
    }
    let tracedRequest = await this.requestTraced(body, accessToken, signal, requestTrace, 1);
    // A token may be revoked between the proactive refresh check and this request.
    if (tracedRequest.response.status === 401) {
      await tracedRequest.response.body?.cancel().catch(() => undefined);
      try {
        accessToken = await this.auth.accessToken(true, requestTrace);
      } catch (error) {
        tracedRequest.settle({
          outcome: 'failed',
          durationMs: Date.now() - tracedRequest.startedAt,
          terminalEvent: 'http_response',
          errorCategory: 'http',
          errorCode: 'http_401',
        });
        throw withProviderErrorCode(error, 'http_401');
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
      throw providerError(`ChatGPT model request returned HTTP ${response.status}.`, `http_${response.status}`);
    }
    if (!response.body) {
      tracedRequest.settle({
        outcome: 'failed',
        durationMs: Date.now() - tracedRequest.startedAt,
        terminalEvent: 'http_response',
        errorCategory: 'protocol',
        errorCode: 'empty_stream',
      });
      throw providerError('ChatGPT returned an empty Responses stream.', 'empty_stream');
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
      throw withProviderErrorCode(error, interrupted ? undefined : 'invalid_stream');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData: string[] = [];
    let finalResponse: Record<string, unknown> | null = null;
    let streamedReasoningSummary = '';
    let previousReasoningSummaryKey: string | null = null;
    let streamFailure: string | null = null;
    let streamFailureCode: string | undefined;
    let failureCategory: ProviderRequestSummary['errorCategory'];
    let failureCode: string | undefined;
    let terminalEvent: string | undefined;
    const eventCounts: Record<string, number> = {};
    let firstTextMs: number | undefined;
    let deltaTextCharacters = 0;
    let ended = false;
    const streamedTextParts = new Map<
      string,
      { outputIndex: number; contentIndex: number; order: number; text: string }
    >();
    const streamedFunctionCalls: StreamedFunctionCall[] = [];
    const callsByItemId = new Map<string, StreamedFunctionCall>();
    const callsByOutputIndex = new Map<number, StreamedFunctionCall>();
    const getStreamedCall = (itemId?: string, outputIndex?: number): StreamedFunctionCall => {
      const byItemId = itemId ? callsByItemId.get(itemId) : undefined;
      const byOutputIndex = outputIndex === undefined ? undefined : callsByOutputIndex.get(outputIndex);
      let call = byItemId ?? byOutputIndex;
      if (byItemId && byOutputIndex && byItemId !== byOutputIndex) {
        call = byItemId.order <= byOutputIndex.order ? byItemId : byOutputIndex;
        const duplicate = call === byItemId ? byOutputIndex : byItemId;
        if (call.itemId === undefined && duplicate.itemId !== undefined) call.itemId = duplicate.itemId;
        if (call.outputIndex === undefined && duplicate.outputIndex !== undefined) call.outputIndex = duplicate.outputIndex;
        if (call.callId === undefined && duplicate.callId !== undefined) call.callId = duplicate.callId;
        if (call.name === undefined && duplicate.name !== undefined) call.name = duplicate.name;
        if (duplicate.argumentsComplete && !call.argumentsComplete) {
          call.argumentsText = duplicate.argumentsText;
        } else if (!call.argumentsText) {
          call.argumentsText = duplicate.argumentsText;
        }
        call.argumentsComplete ||= duplicate.argumentsComplete;
        call.order = Math.min(call.order, duplicate.order);
        for (const [id, candidate] of callsByItemId) {
          if (candidate === duplicate) callsByItemId.set(id, call);
        }
        for (const [index, candidate] of callsByOutputIndex) {
          if (candidate === duplicate) callsByOutputIndex.set(index, call);
        }
        const duplicateIndex = streamedFunctionCalls.indexOf(duplicate);
        if (duplicateIndex >= 0) streamedFunctionCalls.splice(duplicateIndex, 1);
      }
      if (!call) {
        call = { argumentsText: '', argumentsComplete: false, order: streamedFunctionCalls.length };
        streamedFunctionCalls.push(call);
      }
      if (itemId) {
        call.itemId = itemId;
        callsByItemId.set(itemId, call);
      }
      if (outputIndex !== undefined) {
        call.outputIndex = outputIndex;
        callsByOutputIndex.set(outputIndex, call);
      }
      return call;
    };
    const recordStreamedCall = (
      event: Record<string, unknown>,
      item?: Record<string, unknown>,
      completeArguments = false,
    ): StreamedFunctionCall => {
      const itemId = typeof event.item_id === 'string'
        ? event.item_id
        : typeof item?.id === 'string'
          ? item.id
          : undefined;
      const outputIndex = typeof event.output_index === 'number' && Number.isInteger(event.output_index)
        ? event.output_index
        : undefined;
      const call = getStreamedCall(itemId, outputIndex);
      if (typeof item?.call_id === 'string') call.callId = item.call_id;
      if (typeof item?.name === 'string') call.name = item.name;
      if (completeArguments && typeof event.arguments === 'string') {
        call.argumentsText = event.arguments;
        call.argumentsComplete = true;
      } else if (completeArguments && typeof item?.arguments === 'string') {
        call.argumentsText = item.arguments;
        call.argumentsComplete = true;
      }
      return call;
    };
    const recordStreamedText = (event: Record<string, unknown>, text: string, append: boolean): void => {
      const outputIndex = typeof event.output_index === 'number' && Number.isInteger(event.output_index)
        ? event.output_index
        : Number.MAX_SAFE_INTEGER;
      const contentIndex = typeof event.content_index === 'number' && Number.isInteger(event.content_index)
        ? event.content_index
        : Number.MAX_SAFE_INTEGER;
      const key = `${outputIndex}:${contentIndex}`;
      const existing = streamedTextParts.get(key);
      streamedTextParts.set(key, {
        outputIndex,
        contentIndex,
        order: existing?.order ?? streamedTextParts.size,
        text: append ? `${existing?.text ?? ''}${text}` : text,
      });
    };
    const streamedText = (): string => [...streamedTextParts.values()]
      .sort((left, right) =>
        left.outputIndex - right.outputIndex
        || left.contentIndex - right.contentIndex
        || left.order - right.order)
      .map((part) => part.text)
      .join('');
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
        recordStreamedText(value, value.delta, true);
        onText(value.delta);
      } else if (value.type === 'response.reasoning_summary_text.delta' && typeof value.delta === 'string') {
        const outputIndex = typeof value.output_index === 'number' ? value.output_index : 0;
        const summaryIndex = typeof value.summary_index === 'number' ? value.summary_index : 0;
        const summaryKey = `${outputIndex}:${summaryIndex}`;
        if (value.delta && previousReasoningSummaryKey !== null && previousReasoningSummaryKey !== summaryKey) {
          streamedReasoningSummary += '\n\n';
          onEvent?.({ type: 'reasoning_summary.delta', delta: '\n\n' });
        }
        if (value.delta) previousReasoningSummaryKey = summaryKey;
        streamedReasoningSummary += value.delta;
        onEvent?.({ type: 'reasoning_summary.delta', delta: value.delta });
      } else if (value.type === 'response.output_text.done' && typeof value.text === 'string') {
        // The completed response is authoritative, but some provider streams omit its output array.
        // Retain the finalized text event as a fallback for that case.
        recordStreamedText(value, value.text, false);
      } else if (value.type === 'response.output_item.added') {
        const item = object(value.item);
        if (item?.type === 'function_call') {
          const call = recordStreamedCall(value, item);
          onEvent?.({ type: 'tool_call.preview', index: call.outputIndex ?? call.order, ...(call.callId ? { id: call.callId } : {}), ...(call.name ? { name: call.name } : {}), argumentsText: call.argumentsText });
        }
      } else if (value.type === 'response.function_call_arguments.delta' && typeof value.delta === 'string') {
        const call = recordStreamedCall(value);
        call.argumentsText += value.delta;
        onEvent?.({ type: 'tool_call.preview', index: call.outputIndex ?? call.order, ...(call.callId ? { id: call.callId } : {}), ...(call.name ? { name: call.name } : {}), argumentsText: call.argumentsText });
      } else if (value.type === 'response.function_call_arguments.done') {
        recordStreamedCall(value, undefined, true);
      } else if (value.type === 'response.output_item.done') {
        const item = object(value.item);
        if (item?.type === 'function_call') recordStreamedCall(value, item, true);
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
      throw withProviderErrorCode(error, interrupted ? undefined : (failureCode ?? errorCodeFrom(error) ?? 'transport'));
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
          throw new Error(`ChatGPT response was incomplete (${failureCode}).`);
        }
      }
      const result = outputFrom(completedResponse, prompt);
      if (!result.reasoningSummary && streamedReasoningSummary) result.reasoningSummary = streamedReasoningSummary;
      if (!result.content) result.content = streamedText();

      // The completed response is the canonical source. Responses API streams also emit
      // finalized function-call events, so use those when the final output array omitted a call.
      const finalCalls = finalFunctionCalls(completedResponse);
      for (const streamedCall of streamedFunctionCalls.sort((left, right) => left.order - right.order)) {
        const finalCall = finalCalls.find((call) =>
          (streamedCall.callId !== undefined && call.callId === streamedCall.callId)
          || (streamedCall.itemId !== undefined && call.itemId === streamedCall.itemId)
          || (streamedCall.outputIndex !== undefined && call.outputIndex === streamedCall.outputIndex));
        if (finalCall) {
          const finalArguments = finalCall.argumentsText;
          if ((!finalArguments || !finalArguments.trim()) && streamedCall.argumentsComplete) {
            const name = streamedCall.name;
            if (!name) {
              failureCategory = 'protocol';
              failureCode = 'missing_function_name';
              throw new Error('ChatGPT completed a function call without a tool name.');
            }
            result.toolCalls[finalCall.toolCallIndex] = {
              id:
                finalCall.callId
                ?? result.toolCalls[finalCall.toolCallIndex]?.id
                ?? streamedCall.callId
                ?? `call-${finalCall.toolCallIndex}`,
              name,
              arguments: parseArguments(streamedCall.argumentsText, name),
            };
          }
          continue;
        }
        if (!streamedCall.argumentsComplete) {
          failureCategory = 'protocol';
          failureCode = 'incomplete_function_call';
          throw new Error('ChatGPT streamed a function call without completing its arguments.');
        }
        if (!streamedCall.name) {
          failureCategory = 'protocol';
          failureCode = 'missing_function_name';
          throw new Error('ChatGPT completed a function call without a tool name.');
        }
        result.toolCalls.push({
          id: streamedCall.callId ?? `call-${result.toolCalls.length}`,
          name: streamedCall.name,
          arguments: parseArguments(streamedCall.argumentsText, streamedCall.name),
        });
      }
      if (completedResponse.status !== 'incomplete' && result.toolCalls.length > 0) {
        result.finishReason = 'tool_calls';
      }
      if (!result.content.trim() && result.toolCalls.length === 0) {
        failureCategory = 'protocol';
        failureCode = 'empty_output';
        throw new Error('ChatGPT completed a response without text or tool calls.');
      }
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
      throw withProviderErrorCode(error, interrupted ? undefined : (failureCode ?? errorCodeFrom(error) ?? 'response_failed'));
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
      throw withProviderErrorCode(error, interrupted ? undefined : (errorCodeFrom(error) ?? 'transport'));
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
