import type { ProjectionInput } from '../contracts/plugin-pipeline.js';
import type { PromptTurn } from '../contracts/model.js';
import type { CanonicalRecord } from '../core/types.js';
import { canonicalConversationRecords } from '../contracts/canonical-projection.js';

/** Resolve an indivisible projected prefix without inferring turn counts from plugin identities. */
export function projectedCompactionPrefix(
  records: readonly CanonicalRecord[],
  projection: ProjectionInput,
  candidateThroughSeq: number,
): { throughSeq: number; turns: PromptTurn[] } | null {
  const sources = (projection.provenance ?? []).filter((item) => item.kind !== 'plugin');
  const conversation = canonicalConversationRecords(records);
  const containsConversationRecord = (start: number, end: number): boolean => {
    let low = 0;
    let high = conversation.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (conversation[middle]!.seq < start) low = middle + 1;
      else high = middle;
    }
    return low < conversation.length && conversation[low]!.seq <= end;
  };
  const occupied = new Set<number>();
  const mapping: Array<{ start: number; end: number; first: number; last: number }> = [];
  for (const source of sources) {
    const { canonicalStartSeq: start, canonicalEndSeq: end, turnStartIndex: first, turnEndIndex: last } = source;
    if (
      first === undefined &&
      last === undefined &&
      source.disposition === 'omitted' &&
      !containsConversationRecord(start!, end!)
    )
      continue;
    if (![start, end, first, last].every(Number.isSafeInteger)) return null;
    if (start! <= 0 || end! < start! || first! < 0 || last! < first! || last! > projection.turns.length) return null;
    if (source.disposition === 'omitted' && first !== last) return null;
    for (let i = first!; i < last!; i++) {
      if (occupied.has(i)) return null;
      occupied.add(i);
    }
    mapping.push({ start: start!, end: end!, first: first!, last: last! });
  }
  mapping.sort((a, b) => a.start - b.start);
  for (let i = 1; i < mapping.length; i++) {
    if (mapping[i]!.start <= mapping[i - 1]!.end || mapping[i]!.first < mapping[i - 1]!.last) return null;
  }
  let mappingIndex = 0;
  for (const record of conversation) {
    while (mappingIndex < mapping.length && mapping[mappingIndex]!.end < record.seq) mappingIndex++;
    if (mappingIndex === mapping.length || mapping[mappingIndex]!.start > record.seq) return null;
  }
  const pluginIndexes = new Set<number>();
  for (const item of projection.provenance ?? []) {
    if (item.kind !== 'plugin') continue;
    const first = item.turnStartIndex ?? item.turnIndex;
    const last = item.turnEndIndex ?? (item.turnIndex === undefined ? undefined : item.turnIndex + 1);
    if (first === undefined && last === undefined) continue; // System prompt contribution.
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first! < 0 ||
      last! < first! ||
      last! > projection.turns.length
    )
      return null;
    if (item.turnIndex !== undefined && item.turnIndex !== first) return null;
    for (let index = first!; index < last!; index++) {
      if (occupied.has(index)) return null;
      pluginIndexes.add(index);
    }
  }
  for (const index of pluginIndexes) occupied.add(index);
  if (occupied.size !== projection.turns.length) return null;
  let throughSeq = 0;
  const turns: PromptTurn[] = [];
  for (const entry of mapping) {
    if (entry.end > candidateThroughSeq) break;
    throughSeq = entry.end;
    turns.push(...projection.turns.slice(entry.first, entry.last));
  }
  return throughSeq > 0 && turns.length > 0 ? { throughSeq, turns } : null;
}
