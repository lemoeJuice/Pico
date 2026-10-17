import { expect, it } from 'vitest';
import type { CanonicalRecord, Execution } from '../src/core/types.js';
import { modelExecutionGroups, selectedAttemptIndex } from '../src/web/model-execution-groups.js';

function record(seq: number, kind: CanonicalRecord['kind'], id = `record-${seq}`): CanonicalRecord {
  return {
    id,
    threadId: 'thread',
    seq,
    kind,
    payload: kind === 'assistant' ? { content: 'Reply', toolCalls: [] } : {},
    createdAt: `2026-10-17T00:00:${seq.toString().padStart(2, '0')}Z`,
  };
}
function execution(id: string, through: number, status: Execution['status'], order: number): Execution {
  return {
    id,
    threadId: 'thread',
    batchId: null,
    kind: 'model',
    toolName: null,
    arguments: { projectionThrough: through },
    status,
    result: null,
    error: status === 'failed' ? 'fetch failed' : null,
    createdAt: `2026-10-17T00:00:0${order}Z`,
    updatedAt: `2026-10-17T00:00:0${order}Z`,
  };
}

it('groups Continue after plugin records as another attempt and removes its successful record from standalone replies', () => {
  const failed = execution('failed', 1, 'failed', 1);
  const retry = execution('continued', 2, 'completed', 2);
  const result = modelExecutionGroups(
    [record(1, 'message'), record(2, 'plugin'), record(3, 'assistant', 'continued:assistant')],
    [retry, failed],
  );
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]!.projectionThrough).toBe(1);
  expect(result.groups[0]!.variants.map((variant) => variant.execution.id)).toEqual(['failed', 'continued']);
  expect(result.groupedAssistantRecordIds.has('continued:assistant')).toBe(true);
  expect(selectedAttemptIndex(result.groups[0]!, null)).toBe(1);
});

it('preserves distinct steps across new messages, assistant outputs, and tool results', () => {
  for (const kind of ['message', 'assistant', 'tool_result'] as const) {
    const result = modelExecutionGroups(
      [record(1, 'message'), record(2, kind), record(3, 'plugin')],
      [execution('first', 1, 'failed', 1), execution('next', 3, 'running', 2)],
    );
    expect(result.groups).toHaveLength(2);
  }
});

it('shows the newest attempt when Continue supersedes a previously selected failure', () => {
  const records = [record(1, 'message'), record(2, 'plugin')];
  const failed = execution('failed', 1, 'failed', 1);
  const second = execution('second', 1, 'failed', 2);
  const group = modelExecutionGroups(records, [failed, second]).groups[0]!;
  const selection = { id: 'failed', latestId: 'second' };
  expect(selectedAttemptIndex(group, selection)).toBe(0);
  const next = modelExecutionGroups(records, [failed, second, execution('continued', 2, 'running', 3)]).groups[0]!;
  expect(selectedAttemptIndex(next, selection)).toBe(2);
});

it('does not infer attempt membership without a visible message boundary', () => {
  expect(modelExecutionGroups([record(2, 'plugin')], [execution('failed', 2, 'failed', 1)]).groups).toEqual([]);
});
