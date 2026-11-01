import { describe, expect, it } from 'vitest';
import {
  countObservedAppendDelta,
  replaceSegmentTokenLedger,
  type ObservedPromptSnapshot,
  type PromptSegment,
} from '../src/runtime/context-token-accounting.js';

const identity = {
  model: 'provider/model-v1',
  connection: 'connection-1',
  system: 'system-hash',
  tools: 'tools-hash',
  parameters: 'parameters-hash',
  fixedPrompt: 'fixed-prompt-hash',
};

const round1: PromptSegment = {
  id: 'round-1',
  sourceHash: 'a',
  startSeq: 1,
  endSeq: 3,
  turnKinds: ['assistant', 'tool'],
};
const userLayout = { kind: 'fixed' as const, fingerprint: 'user-prompt-hash' };
function segmentLayout(segment: PromptSegment, turnIndex: number) {
  return {
    kind: 'segment' as const,
    segmentId: segment.id,
    sourceHash: segment.sourceHash,
    startSeq: segment.startSeq,
    endSeq: segment.endSeq,
    turnIndex,
  };
}
function appendRound2Layout() {
  const segment: PromptSegment = {
    id: 'round-2',
    sourceHash: 'b',
    startSeq: 4,
    endSeq: 8,
    turnKinds: ['assistant', 'tool', 'assistant'],
  };
  return [segmentLayout(segment, 0), segmentLayout(segment, 1), segmentLayout(segment, 2)];
}

const base: ObservedPromptSnapshot = {
  inputTokens: 100,
  identity,
  segments: [round1],
  layout: [userLayout, segmentLayout(round1, 0), segmentLayout(round1, 1)],
};

describe('provider observed context token accounting', () => {
  it('counts an exact appended assistant/tool segment from adjacent input usage', () => {
    const current: ObservedPromptSnapshot = {
      inputTokens: 143,
      identity,
      segments: [
        ...base.segments,
        { id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8, turnKinds: ['assistant', 'tool', 'assistant'] },
      ],
      layout: [...base.layout, ...appendRound2Layout()],
    };
    expect(countObservedAppendDelta(base, current, [{ id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8 }])).toBe(
      43,
    );
  });

  it('allows intervening canonical plugin records between projected segments', () => {
    const current: ObservedPromptSnapshot = {
      inputTokens: 143,
      identity,
      segments: [
        ...base.segments,
        { id: 'round-2', sourceHash: 'b', startSeq: 7, endSeq: 11, turnKinds: ['assistant', 'tool'] },
      ],
      layout: [
        ...base.layout,
        ...[0, 1].map((turnIndex) => ({
          kind: 'segment' as const,
          segmentId: 'round-2',
          sourceHash: 'b',
          startSeq: 7,
          endSeq: 11,
          turnIndex,
        })),
      ],
    };
    expect(countObservedAppendDelta(base, current, [{ id: 'round-2', sourceHash: 'b', startSeq: 7, endSeq: 11 }])).toBe(
      43,
    );
  });

  it('returns null when model, connection, system, tools, parameters, or fixed prompt changed', () => {
    const current = { ...base, inputTokens: 110, identity: { ...identity, tools: 'changed-tools' } };
    expect(
      countObservedAppendDelta(base, current, [{ id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8 }]),
    ).toBeNull();
  });

  it('returns null when the current prompt is not an exact append', () => {
    const extra: ObservedPromptSnapshot = {
      inputTokens: 110,
      identity,
      segments: [
        ...base.segments,
        { id: 'user-message', sourceHash: 'u', startSeq: 4, endSeq: 4, turnKinds: ['assistant'] },
        { id: 'round-2', sourceHash: 'b', startSeq: 5, endSeq: 8, turnKinds: ['assistant'] },
      ],
      layout: [
        ...base.layout,
        { kind: 'fixed', fingerprint: 'new-user-hash' },
        {
          kind: 'segment',
          segmentId: 'round-2',
          sourceHash: 'b',
          startSeq: 5,
          endSeq: 8,
          turnIndex: 0,
        },
      ],
    };
    expect(
      countObservedAppendDelta(base, extra, [{ id: 'round-2', sourceHash: 'b', startSeq: 5, endSeq: 8 }]),
    ).toBeNull();
  });

  it('returns null when an unchanged fixed turn or prior segment is reordered around history', () => {
    const round2: PromptSegment = {
      id: 'round-2',
      sourceHash: 'b',
      startSeq: 4,
      endSeq: 8,
      turnKinds: ['assistant'],
    };
    const current: ObservedPromptSnapshot = {
      inputTokens: 130,
      identity,
      segments: [...base.segments, round2],
      // The same user and raw history turns are present, but their ordered layout
      // changed, so the provider input delta cannot be attributed to round 2.
      layout: [segmentLayout(round1, 0), userLayout, segmentLayout(round1, 1), segmentLayout(round2, 0)],
    };
    expect(
      countObservedAppendDelta(base, current, [{ id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8 }]),
    ).toBeNull();
  });

  it('returns null for a non-assistant-only logical segment or a mismatched source range', () => {
    const current: ObservedPromptSnapshot = {
      inputTokens: 110,
      identity,
      segments: [...base.segments, { id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8, turnKinds: ['tool'] }],
      layout: [
        ...base.layout,
        { kind: 'segment', segmentId: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8, turnIndex: 0 },
      ],
    };
    expect(
      countObservedAppendDelta(base, current, [{ id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8 }]),
    ).toBeNull();
    expect(
      countObservedAppendDelta(
        base,
        {
          ...current,
          segments: [
            base.segments[0]!,
            { id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8, turnKinds: ['assistant'] },
          ],
          layout: [
            ...base.layout,
            { kind: 'segment', segmentId: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8, turnIndex: 0 },
          ],
        },
        [{ id: 'round-2', sourceHash: 'stale', startSeq: 4, endSeq: 8 }],
      ),
    ).toBeNull();
  });

  it('rejects negative, unsafe, or malformed usage deltas', () => {
    expect(
      countObservedAppendDelta(
        base,
        {
          ...base,
          inputTokens: 99,
          segments: [
            ...base.segments,
            { id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8, turnKinds: ['assistant'] },
          ],
          layout: [
            ...base.layout,
            { kind: 'segment', segmentId: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8, turnIndex: 0 },
          ],
        },
        [{ id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8 }],
      ),
    ).toBeNull();
    expect(
      countObservedAppendDelta(base, { ...base, inputTokens: Number.MAX_SAFE_INTEGER + 1 }, [
        { id: 'round-2', sourceHash: 'b', startSeq: 4, endSeq: 8 },
      ]),
    ).toBeNull();
  });

  it('replaces removed measured segment contributions with visible capsule usage', () => {
    expect(
      replaceSegmentTokenLedger(
        300,
        [
          { id: 'a', sourceHash: 'ha', startSeq: 1, endSeq: 2, tokenCount: 40 },
          { id: 'b', sourceHash: 'hb', startSeq: 3, endSeq: 4, tokenCount: 60 },
        ],
        [{ id: 'a', sourceHash: 'ha', startSeq: 1, endSeq: 2 }],
        [{ id: 'capsule-a', sourceHash: 'ha', visibleTokenCount: 12 }],
      ),
    ).toBe(272);
  });

  it('returns null for missing, stale, overlapping, negative, or underflowing replacements', () => {
    const ledger = [
      { id: 'a', sourceHash: 'ha', startSeq: 1, endSeq: 2, tokenCount: 40 },
      { id: 'b', sourceHash: 'hb', startSeq: 3, endSeq: 4, tokenCount: 60 },
    ];
    const a = { id: 'a', sourceHash: 'ha', startSeq: 1, endSeq: 2 };
    expect(replaceSegmentTokenLedger(300, ledger, [{ ...a, sourceHash: 'stale' }], [])).toBeNull();
    expect(replaceSegmentTokenLedger(300, ledger, [{ ...a, startSeq: 2, endSeq: 3 }], [])).toBeNull();
    expect(replaceSegmentTokenLedger(300, ledger, [a, a], [])).toBeNull();
    expect(
      replaceSegmentTokenLedger(300, ledger, [a, { id: 'b', sourceHash: 'hb', startSeq: 2, endSeq: 3 }], []),
    ).toBeNull();
    expect(replaceSegmentTokenLedger(20, ledger, [a], [])).toBeNull();
    expect(
      replaceSegmentTokenLedger(300, ledger, [], [{ id: 'capsule-a', sourceHash: 'ha', visibleTokenCount: -1 }]),
    ).toBeNull();
    expect(replaceSegmentTokenLedger(300, ledger, [{ ...a, id: 'missing' }], [])).toBeNull();
  });
});
