import { expect, it } from 'vitest';
import type { CanonicalRecord } from '../src/core/types.js';
import {
  canonicalBlockToPromptTurns,
  completedCanonicalModelInvocationBlocks,
  omitConsumedThreadHistoryResults,
  projectThreadHistoryIo,
  runtimeConversationProjection,
} from '../src/contracts/canonical-projection.js';

function record(seq: number, kind: CanonicalRecord['kind'], payload: Record<string, unknown>): CanonicalRecord {
  return {
    id: `record-${seq}`,
    threadId: 'thread-test',
    seq,
    kind,
    payload,
    createdAt: '2026-10-22T00:00:00.000Z',
  };
}

it('keeps complete assistant and tool-result invocation batches together', () => {
  const blocks = completedCanonicalModelInvocationBlocks([
    record(1, 'message', { role: 'user', content: 'first request' }),
    record(2, 'assistant', { toolCalls: [], batchId: null, content: 'first response' }),
    record(3, 'plugin', { pluginId: 'test', action: 'diagnostic' }),
    record(4, 'message', { role: 'user', content: 'second request' }),
    record(5, 'assistant', {
      batchId: 'batch-1',
      toolCalls: [
        { id: 'call-a', name: 'read_file', arguments: {} },
        { id: 'call-b', name: 'search_files', arguments: {} },
      ],
      content: '',
    }),
    record(6, 'tool_result', { batchId: 'batch-1', toolCallId: 'call-b' }),
    record(7, 'tool_result', { batchId: 'batch-1', toolCallId: 'call-a' }),
    record(8, 'message', { role: 'user', content: 'third request' }),
    record(9, 'assistant', { toolCalls: [], batchId: null, content: 'third response' }),
  ]);

  expect(blocks.map((block) => block.map((item) => item.seq))).toEqual([
    [1, 2],
    [4, 5, 6, 7],
    [8, 9],
  ]);
});

it('does not expose an incomplete or mismatched tool batch as a compaction boundary', () => {
  const records = [
    record(1, 'message', { role: 'user', content: 'complete request' }),
    record(2, 'assistant', { toolCalls: [], batchId: null, content: 'complete response' }),
    record(3, 'message', { role: 'user', content: 'unfinished request' }),
    record(4, 'assistant', {
      batchId: 'batch-2',
      toolCalls: [{ id: 'call-a', name: 'read_file', arguments: {} }],
      content: '',
    }),
    record(5, 'tool_result', { batchId: 'batch-2', toolCallId: 'unexpected-call' }),
  ];

  expect(completedCanonicalModelInvocationBlocks(records).map((block) => block.map((item) => item.seq))).toEqual([
    [1, 2],
  ]);
  expect(
    completedCanonicalModelInvocationBlocks(records.slice(0, 4)).map((block) => block.map((item) => item.seq)),
  ).toEqual([[1, 2]]);
});

it('keeps completed tool results when rewinding to their assistant call', () => {
  const projected = runtimeConversationProjection([
    record(1, 'message', { role: 'user', content: 'inspect history' }),
    record(2, 'assistant', {
      batchId: 'batch-history',
      toolCalls: [
        { id: 'call-a', name: 'read_thread_history', arguments: { thread_id: 'child-a' } },
        { id: 'call-b', name: 'read_thread_history', arguments: { thread_id: 'child-b' } },
      ],
      content: '',
    }),
    record(3, 'tool_result', {
      batchId: 'batch-history',
      toolCallId: 'call-a',
      toolName: 'read_thread_history',
      status: 'completed',
      result: { records: [{ seq: 1, output: 'result a' }] },
    }),
    record(4, 'tool_result', {
      batchId: 'batch-history',
      toolCallId: 'call-b',
      toolName: 'read_thread_history',
      status: 'completed',
      result: { records: [{ seq: 1, output: 'result b' }] },
    }),
    record(5, 'plugin', {
      pluginId: 'pico.runtime',
      action: 'context-rewound',
      version: 1,
      targetRecordId: 'record-2',
      targetSeq: 4,
      parentProjectionId: null,
    }),
  ]);

  expect(projected.records.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(
    completedCanonicalModelInvocationBlocks(projected.records).map((block) => block.map((item) => item.seq)),
  ).toEqual([[1, 2, 3, 4]]);
});

it('keeps a history result for its first response and hides it after the consuming response', () => {
  const invocation = record(1, 'assistant', {
    batchId: 'batch-1',
    toolCalls: [{ id: 'call-a', name: 'read_thread_history', arguments: {} }],
    content: '',
  });
  const source = record(2, 'tool_result', {
    batchId: 'batch-1',
    toolCallId: 'call-a',
    toolName: 'read_thread_history',
    status: 'completed',
    result: { records: [{ seq: 1, output: 'large history' }] },
  });
  const firstProjection = omitConsumedThreadHistoryResults([invocation, source]);
  expect(firstProjection[1]?.payload).toMatchObject({ result: { records: [{ output: 'large history' }] } });

  const laterProjection = omitConsumedThreadHistoryResults([
    invocation,
    source,
    record(3, 'assistant', { projectionThrough: 2, toolCalls: [], content: 'I reviewed it.' }),
  ]);
  expect(laterProjection[1]?.payload).toMatchObject({
    result: { omitted: expect.stringContaining('already provided') },
  });
  expect(source.payload).toMatchObject({ result: { records: [{ output: 'large history' }] } });

  const laterTurns = canonicalBlockToPromptTurns(laterProjection.slice(0, 2), {
    threadId: 'thread-test',
    parentThreadId: null,
  });
  expect(laterTurns[1]).toMatchObject({
    kind: 'tool_result',
    content: expect.stringContaining('already provided'),
  });
  expect(laterTurns[1]?.kind === 'tool_result' ? laterTurns[1].content : '').not.toBe('{"records":[]}');
});

it('does not recursively expand history results read from another Thread', () => {
  const nested = record(2, 'tool_result', {
    batchId: 'batch-1',
    toolCallId: 'call-a',
    toolName: 'read_thread_history',
    status: 'completed',
    result: { records: [{ seq: 1, output: 'nested bulk data' }] },
  });
  expect(projectThreadHistoryIo([nested]).records).toEqual([
    {
      seq: 2,
      output: {
        tool: 'read_thread_history',
        status: 'completed',
        result: { omitted: expect.stringContaining('Nested read_thread_history') },
      },
    },
  ]);
});
