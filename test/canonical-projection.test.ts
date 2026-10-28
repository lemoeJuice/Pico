import { expect, it } from 'vitest';
import type { CanonicalRecord } from '../src/core/types.js';
import {
  completedCanonicalModelInvocationBlocks,
  omitConsumedThreadHistoryResults,
  projectThreadHistoryIo,
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

it('keeps a history result for its first response and hides it after the consuming response', () => {
  const source = record(2, 'tool_result', {
    batchId: 'batch-1',
    toolCallId: 'call-a',
    toolName: 'read_thread_history',
    status: 'completed',
    result: { records: [{ seq: 1, output: 'large history' }] },
  });
  const firstProjection = omitConsumedThreadHistoryResults([source]);
  expect(firstProjection[0]?.payload).toMatchObject({ result: { records: [{ output: 'large history' }] } });

  const laterProjection = omitConsumedThreadHistoryResults([
    source,
    record(3, 'assistant', { projectionThrough: 2, toolCalls: [], content: 'I reviewed it.' }),
  ]);
  expect(laterProjection[0]?.payload).toMatchObject({
    result: { omitted: expect.stringContaining('already provided') },
  });
  expect(source.payload).toMatchObject({ result: { records: [{ output: 'large history' }] } });
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
