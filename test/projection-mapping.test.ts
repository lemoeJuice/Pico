import { describe, expect, it } from 'vitest';
import { projectedCompactionPrefix } from '../src/runtime/projection-mapping.js';
import type { ProjectionInput } from '../src/contracts/plugin-pipeline.js';
import type { CanonicalRecord } from '../src/core/types.js';

const records = [1, 2, 3, 4].map((seq) => ({
  seq,
  id: String(seq),
  kind: 'message',
  payload: {},
})) as CanonicalRecord[];
const turn = (content: string) => ({ kind: 'message' as const, role: 'user' as const, content });
const source = (
  start: number,
  end: number,
  first: number,
  last: number,
  disposition: 'raw' | 'summary' | 'omitted',
) => ({
  id: String(start),
  sourcePluginId: 'some.unrecognised.plugin',
  label: '',
  kind: 'rolling_segment' as const,
  disposition,
  canonicalStartSeq: start,
  canonicalEndSeq: end,
  turnStartIndex: first,
  turnEndIndex: last,
});
function input(): ProjectionInput {
  return {
    turns: [turn('summary a'), turn('summary b'), turn('plugin'), turn('raw')],
    provenance: [
      source(1, 2, 0, 2, 'summary'),
      source(3, 3, 2, 2, 'omitted'),
      source(4, 4, 3, 4, 'raw'),
      { id: 'p', sourcePluginId: 'other', label: '', kind: 'plugin', disposition: 'raw', turnIndex: 2 },
    ],
  } as ProjectionInput;
}
describe('projection compaction mapping', () => {
  it('accepts arbitrary sources and excludes plugin context, including omitted spans', () => {
    expect(projectedCompactionPrefix(records, input(), 3)).toEqual({
      throughSeq: 3,
      turns: [turn('summary a'), turn('summary b')],
    });
  });
  it('never cuts a multi-turn summary', () => {
    expect(projectedCompactionPrefix(records, input(), 1)).toBeNull();
  });
  it('excludes a prepended plugin turn when all source indexes are shifted', () => {
    const value = input();
    value.turns.unshift(turn('prepended'));
    for (const item of value.provenance!) {
      if (item.turnStartIndex !== undefined) item.turnStartIndex++;
      if (item.turnEndIndex !== undefined) item.turnEndIndex++;
      if (item.turnIndex !== undefined) item.turnIndex++;
    }
    value.provenance!.push({
      id: 'prefix',
      sourcePluginId: 'prefix',
      label: '',
      kind: 'plugin',
      disposition: 'raw',
      turnIndex: 0,
    });
    expect(projectedCompactionPrefix(records, value, 3)).toEqual({
      throughSeq: 3,
      turns: [turn('summary a'), turn('summary b')],
    });
  });
  it('fails closed when a plugin inserts an unaccounted turn or changes ordering', () => {
    const value = input();
    value.turns.unshift(turn('unmapped'));
    expect(projectedCompactionPrefix(records, value, 4)).toBeNull();
    const reordered = input();
    reordered.provenance![2]!.turnStartIndex = 0;
    expect(projectedCompactionPrefix(records, reordered, 4)).toBeNull();
  });
  it('keeps an indivisible tool call and result together', () => {
    const value = input();
    value.turns = [
      { kind: 'assistant_tools', content: '', calls: [{ id: 'call', name: 'tool', arguments: {} }] },
      { kind: 'tool_result', callId: 'call', toolName: 'tool', content: 'result' },
    ] as ProjectionInput['turns'];
    value.provenance = [source(1, 2, 0, 2, 'raw'), source(3, 4, 2, 2, 'omitted')];
    expect(projectedCompactionPrefix(records, value, 1)).toBeNull();
    expect(projectedCompactionPrefix(records, value, 2)?.turns).toEqual(value.turns);
  });
  it('maps a long history while rejecting an uncovered record and honoring the final boundary', () => {
    const size = 10_000;
    const history = Array.from({ length: size }, (_, index) => ({
      seq: index + 1,
      id: String(index + 1),
      kind: 'message',
      payload: {},
    })) as CanonicalRecord[];
    const projected = {
      turns: history.map((record) => turn(String(record.seq))),
      provenance: history.map((record, index) => source(record.seq, record.seq, index, index + 1, 'raw')),
    } as ProjectionInput;
    const result = projectedCompactionPrefix(history, projected, size - 1);
    expect(result?.throughSeq).toBe(size - 1);
    expect(result?.turns).toHaveLength(size - 1);
    projected.provenance!.splice(Math.floor(size / 2), 1);
    expect(projectedCompactionPrefix(history, projected, size)).toBeNull();
  });
  it('fails closed on missing ownership or overlapping mappings', () => {
    const value = input();
    value.provenance!.pop();
    expect(projectedCompactionPrefix(records, value, 4)).toBeNull();
    const invalid = input();
    invalid.provenance![1]!.canonicalStartSeq = 2;
    expect(projectedCompactionPrefix(records, invalid, 4)).toBeNull();
  });
});
