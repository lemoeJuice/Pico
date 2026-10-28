import type { RawData, WebSocket } from 'ws';
import type { ModelDraftReadResult } from '../runtime/model-draft-buffer.js';

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_THREAD_ID_LENGTH = 256;
const MAX_EXECUTION_ID_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 128;

export type ModelDraftResumeRuntime = {
  readModelDraft(threadId: string, executionId: string, offset: number): ModelDraftReadResult;
};

export function attachModelDraftResume(socket: WebSocket, runtime: ModelDraftResumeRuntime): void {
  let closed = socket.readyState !== 1;
  socket.on('close', () => {
    closed = true;
  });
  socket.on('message', (data, isBinary) => {
    if (closed || socket.readyState !== 1 || isBinary) return;
    const text = messageText(data);
    if (text === null) return;

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isResumeRequest(message)) return;

    let result: ModelDraftReadResult;
    try {
      result = runtime.readModelDraft(message.threadId, message.executionId, message.offset);
    } catch {
      // Keep malformed or stale requests local to this connection and never let
      // an event-listener exception interfere with runtime event broadcasting.
      result = { status: 'unavailable' };
    }

    if (closed || socket.readyState !== 1) return;
    try {
      socket.send(
        JSON.stringify({
          type: 'model.resume.result',
          threadId: message.threadId,
          executionId: message.executionId,
          requestId: message.requestId,
          ...result,
        }),
      );
    } catch {
      // A socket can close between readyState inspection and send().
    }
  });
}

function isResumeRequest(
  value: unknown,
): value is { type: 'model.resume'; threadId: string; executionId: string; offset: number; requestId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'model.resume' &&
    isBoundedString(message.threadId, MAX_THREAD_ID_LENGTH) &&
    isBoundedString(message.executionId, MAX_EXECUTION_ID_LENGTH) &&
    Number.isSafeInteger(message.offset) &&
    (message.offset as number) >= 0 &&
    isBoundedString(message.requestId, MAX_REQUEST_ID_LENGTH)
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function messageText(data: RawData | string): string | null {
  if (typeof data === 'string') return byteLength(data) <= MAX_MESSAGE_BYTES ? data : null;
  if (Buffer.isBuffer(data)) return data.length <= MAX_MESSAGE_BYTES ? data.toString('utf8') : null;
  if (data instanceof ArrayBuffer)
    return data.byteLength <= MAX_MESSAGE_BYTES ? Buffer.from(data).toString('utf8') : null;
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    let size = 0;
    for (const part of data) {
      size += part.length;
      if (size > MAX_MESSAGE_BYTES) return null;
    }
    return Buffer.concat(data).toString('utf8');
  }
  return null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
