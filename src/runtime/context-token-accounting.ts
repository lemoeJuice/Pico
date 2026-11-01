/** Exact token accounting derived only from provider-reported usage. */

export interface PromptAccountingIdentity {
  model: string;
  connection: string;
  system: string;
  tools: string;
  parameters: string;
  /** Stable identity for all prompt material outside the ordered history segments. */
  fixedPrompt: string;
}

export interface PromptSegment {
  id: string;
  sourceHash: string;
  startSeq: number;
  endSeq: number;
  /** A logical segment may contain several assistant/tool turns, but no user turn. */
  turnKinds: Array<'assistant' | 'tool'>;
}

export interface ObservedPromptSnapshot {
  inputTokens: number;
  identity: PromptAccountingIdentity;
  segments: PromptSegment[];
  /** Every projected turn in order; raw model turns use segment markers. */
  layout: PromptLayoutEntry[];
}

export type PromptLayoutEntry =
  | { kind: 'fixed'; fingerprint: string }
  | {
      kind: 'segment';
      segmentId: string;
      sourceHash: string;
      startSeq: number;
      endSeq: number;
      turnIndex: number;
    };

export interface ExactSegmentRange {
  id: string;
  sourceHash: string;
  startSeq: number;
  endSeq: number;
}

export interface SegmentTokenEntry {
  id: string;
  sourceHash: string;
  startSeq: number;
  endSeq: number;
  tokenCount: number;
}

export interface CapsuleTokenEntry {
  id: string;
  sourceHash: string;
  visibleTokenCount: number;
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validIdentity(identity: PromptAccountingIdentity): boolean {
  return ['model', 'connection', 'system', 'tools', 'parameters', 'fixedPrompt'].every(
    (key) =>
      typeof identity[key as keyof PromptAccountingIdentity] === 'string' &&
      identity[key as keyof PromptAccountingIdentity].length > 0,
  );
}

function validSegment(segment: PromptSegment): boolean {
  return (
    Boolean(segment.id && segment.sourceHash) &&
    validSeq(segment.startSeq) &&
    validSeq(segment.endSeq) &&
    segment.startSeq <= segment.endSeq &&
    segment.turnKinds.length > 0 &&
    segment.turnKinds.includes('assistant') &&
    segment.turnKinds.every((kind) => kind === 'assistant' || kind === 'tool')
  );
}

function sameSegment(left: PromptSegment, right: ExactSegmentRange): boolean {
  return (
    left.id === right.id &&
    left.sourceHash === right.sourceHash &&
    left.startSeq === right.startSeq &&
    left.endSeq === right.endSeq
  );
}

function validLayout(layout: PromptLayoutEntry[], segments: PromptSegment[]): boolean {
  if (!Array.isArray(layout)) return false;
  const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  if (segmentsById.size !== segments.length) return false;
  const indexesById = new Map<string, number[]>();
  for (const entry of layout) {
    if (entry.kind === 'fixed') {
      if (typeof entry.fingerprint !== 'string' || !entry.fingerprint) return false;
      continue;
    }
    const segment = segmentsById.get(entry.segmentId);
    if (
      entry.kind !== 'segment' ||
      !segment ||
      entry.sourceHash !== segment.sourceHash ||
      entry.startSeq !== segment.startSeq ||
      entry.endSeq !== segment.endSeq ||
      !validSeq(entry.turnIndex)
    )
      return false;
    const indexes = indexesById.get(entry.segmentId) ?? [];
    indexes.push(entry.turnIndex);
    indexesById.set(entry.segmentId, indexes);
  }
  if (indexesById.size !== segmentsById.size) return false;
  for (const segment of segments) {
    const indexes = indexesById.get(segment.id);
    if (
      !indexes ||
      indexes.length !== segment.turnKinds.length ||
      indexes.some((turnIndex, index) => turnIndex !== index)
    )
      return false;
  }
  return true;
}

/**
 * Returns the exact provider-observed input-token delta only when the current
 * prompt is the previous prompt plus exactly the supplied assistant/tool segment(s).
 */
export function countObservedAppendDelta(
  previous: ObservedPromptSnapshot,
  current: ObservedPromptSnapshot,
  appended: ExactSegmentRange[],
): number | null {
  if (
    !validCount(previous.inputTokens) ||
    !validCount(current.inputTokens) ||
    !validIdentity(previous.identity) ||
    !validIdentity(current.identity) ||
    !validLayout(previous.layout, previous.segments) ||
    !validLayout(current.layout, current.segments) ||
    JSON.stringify(previous.identity) !== JSON.stringify(current.identity) ||
    appended.length === 0
  )
    return null;

  if (!previous.segments.every(validSegment) || !current.segments.every(validSegment)) return null;
  if (previous.segments.length + appended.length !== current.segments.length) return null;
  for (let index = 0; index < previous.segments.length; index += 1) {
    if (JSON.stringify(previous.segments[index]) !== JSON.stringify(current.segments[index])) return null;
  }

  const seen = new Set<string>();
  let previousEnd = previous.segments.at(-1)?.endSeq;
  for (let index = 0; index < appended.length; index += 1) {
    const expected = appended[index];
    const actual = current.segments[previous.segments.length + index];
    if (
      !expected ||
      !actual ||
      !expected.id ||
      !expected.sourceHash ||
      seen.has(expected.id) ||
      !validSeq(expected.startSeq) ||
      !validSeq(expected.endSeq) ||
      expected.startSeq > expected.endSeq ||
      !sameSegment(actual, expected) ||
      actual.turnKinds.length === 0 ||
      !actual.turnKinds.includes('assistant') ||
      actual.turnKinds.some((kind) => kind !== 'assistant' && kind !== 'tool') ||
      (previousEnd !== undefined && expected.startSeq <= previousEnd)
    )
      return null;
    seen.add(expected.id);
    previousEnd = expected.endSeq;
  }

  // Prove that the whole projected-turn sequence is unchanged and only the
  // supplied model segment turns were appended. A fixed user/plugin turn that
  // moves across a raw segment changes this signature and makes the delta unknown.
  const appendedLayout = appended.flatMap((range) => {
    const segment = current.segments.find((item) => sameSegment(item, range));
    return segment
      ? segment.turnKinds.map((_, turnIndex): PromptLayoutEntry => ({
          kind: 'segment',
          segmentId: segment.id,
          sourceHash: segment.sourceHash,
          startSeq: segment.startSeq,
          endSeq: segment.endSeq,
          turnIndex,
        }))
      : [];
  });
  if (
    current.layout.length !== previous.layout.length + appendedLayout.length ||
    !previous.layout.every((entry, index) => JSON.stringify(entry) === JSON.stringify(current.layout[index])) ||
    !appendedLayout.every(
      (entry, index) => JSON.stringify(entry) === JSON.stringify(current.layout[previous.layout.length + index]),
    )
  )
    return null;

  const delta = current.inputTokens - previous.inputTokens;
  return validCount(delta) ? delta : null;
}

/** Replace measured segment contributions in a provider-observed prompt baseline. */
export function replaceSegmentTokenLedger(
  baselineInputTokens: number,
  ledger: SegmentTokenEntry[],
  removed: ExactSegmentRange[],
  capsules: CapsuleTokenEntry[],
): number | null {
  if (!validCount(baselineInputTokens) || !Array.isArray(ledger) || !Array.isArray(removed) || !Array.isArray(capsules))
    return null;

  const byId = new Map<string, SegmentTokenEntry>();
  for (const entry of ledger) {
    if (!entry.id || !entry.sourceHash || !validCount(entry.tokenCount) || byId.has(entry.id)) return null;
    byId.set(entry.id, entry);
  }

  const removedIds = new Set<string>();
  const removedRanges: ExactSegmentRange[] = [];
  let removedTokens = 0;
  for (const range of removed) {
    const entry = byId.get(range.id);
    if (
      !entry ||
      removedIds.has(range.id) ||
      entry.sourceHash !== range.sourceHash ||
      entry.startSeq !== range.startSeq ||
      entry.endSeq !== range.endSeq ||
      !validSeq(range.startSeq) ||
      !validSeq(range.endSeq) ||
      range.startSeq > range.endSeq ||
      removedRanges.some((prior) => range.startSeq <= prior.endSeq && prior.startSeq <= range.endSeq)
    )
      return null;
    removedIds.add(range.id);
    removedRanges.push(range);
    removedTokens += entry.tokenCount;
    if (!Number.isSafeInteger(removedTokens)) return null;
  }

  const capsuleIds = new Set<string>();
  let capsuleTokens = 0;
  for (const capsule of capsules) {
    if (
      !capsule.id ||
      !capsule.sourceHash ||
      capsuleIds.has(capsule.id) ||
      removedIds.has(capsule.id) ||
      !validCount(capsule.visibleTokenCount)
    )
      return null;
    capsuleIds.add(capsule.id);
    capsuleTokens += capsule.visibleTokenCount;
    if (!Number.isSafeInteger(capsuleTokens)) return null;
  }

  const result = baselineInputTokens - removedTokens + capsuleTokens;
  return validCount(result) ? result : null;
}
