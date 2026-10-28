import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { attachModelDraftResume, type ModelDraftResumeRuntime } from '../src/server/model-draft-resume.js';

class MockSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }
}

function attach(runtime: ModelDraftResumeRuntime) {
  const socket = new MockSocket();
  attachModelDraftResume(socket as unknown as WebSocket, runtime);
  return socket;
}

function send(socket: MockSocket, message: unknown): void {
  socket.emit('message', Buffer.from(JSON.stringify(message)), false);
}

describe('model draft resume WebSocket helper', () => {
  it('replies on the requesting socket with a gap result and request identity', () => {
    const runtime = {
      readModelDraft: vi.fn(() => ({
        status: 'gap' as const,
        requestedOffset: 4,
        availableFromOffset: 8,
        availableThroughOffset: 12,
      })),
    };
    const socket = attach(runtime);
    send(socket, {
      type: 'model.resume',
      threadId: 'thread-a',
      executionId: 'execution-a',
      offset: 4,
      requestId: 'request-a',
    });

    expect(runtime.readModelDraft).toHaveBeenCalledWith('thread-a', 'execution-a', 4);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: 'model.resume.result',
        threadId: 'thread-a',
        executionId: 'execution-a',
        requestId: 'request-a',
        status: 'gap',
        requestedOffset: 4,
        availableFromOffset: 8,
        availableThroughOffset: 12,
      },
    ]);
  });

  it('returns unavailable results without leaking runtime exceptions', () => {
    const socket = attach({ readModelDraft: () => ({ status: 'unavailable' }) });
    send(socket, {
      type: 'model.resume',
      threadId: 'thread-a',
      executionId: 'execution-a',
      offset: 0,
      requestId: 'request-a',
    });
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'model.resume.result', status: 'unavailable' });

    const throwingSocket = attach({
      readModelDraft: () => {
        throw new Error('private failure');
      },
    });
    send(throwingSocket, {
      type: 'model.resume',
      threadId: 'thread-a',
      executionId: 'execution-a',
      offset: 0,
      requestId: 'request-b',
    });
    expect(JSON.parse(throwingSocket.sent[0]!)).toMatchObject({ type: 'model.resume.result', status: 'unavailable' });
    expect(throwingSocket.sent[0]).not.toContain('private failure');
  });

  it('ignores malformed, non-protocol, oversized, and invalidly typed messages', () => {
    const readModelDraft = vi.fn(() => ({ status: 'unavailable' as const }));
    const socket = attach({ readModelDraft });
    socket.emit('message', Buffer.from('{bad json'), false);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'record' })), false);
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'model.resume',
          threadId: 'thread-a',
          executionId: 'execution-a',
          offset: -1,
          requestId: 'request-a',
        }),
      ),
      false,
    );
    send(socket, {
      type: 'model.resume',
      threadId: 'thread-a',
      executionId: 'execution-a',
      offset: 1.5,
      requestId: 'request-a',
    });
    send(socket, {
      type: 'model.resume',
      threadId: 'thread-a',
      executionId: 'execution-a',
      offset: Number.MAX_SAFE_INTEGER + 1,
      requestId: 'request-a',
    });
    send(socket, {
      type: 'model.resume',
      threadId: '',
      executionId: 'execution-a',
      offset: 0,
      requestId: 'request-a',
    });
    socket.emit('message', Buffer.alloc(8 * 1024 + 1, 0x61), false);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'model.resume' })), true);

    expect(readModelDraft).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
  });

  it('does not send after close and keeps request handling isolated per socket', () => {
    const runtime = { readModelDraft: vi.fn(() => ({ status: 'unavailable' as const })) };
    const first = attach(runtime);
    const second = attach(runtime);

    first.readyState = 3;
    first.emit('close');
    send(first, {
      type: 'model.resume',
      threadId: 'thread-a',
      executionId: 'execution-a',
      offset: 0,
      requestId: 'request-a',
    });
    send(second, {
      type: 'model.resume',
      threadId: 'thread-b',
      executionId: 'execution-b',
      offset: 2,
      requestId: 'request-b',
    });

    expect(first.sent).toEqual([]);
    expect(second.sent).toHaveLength(1);
    expect(runtime.readModelDraft).toHaveBeenCalledTimes(1);
    expect(runtime.readModelDraft).toHaveBeenCalledWith('thread-b', 'execution-b', 2);
  });
});
