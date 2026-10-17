import { expect, it } from 'vitest';
import { conversationTimeline } from '../src/web/conversation-timeline.js';
import type { CanonicalRecord } from '../src/core/types.js';

it('puts retry branches between their projection and the next record using canonical sequence, not timestamps', () => {
  const records = [
    { id: 'reply', seq: 4, createdAt: '2000-01-01' },
    { id: 'user', seq: 1, createdAt: '2020-01-01' },
    { id: 'tool-step', seq: 2, createdAt: '2030-01-01' },
  ] as CanonicalRecord[];
  expect(
    conversationTimeline(records, [{ projectionThrough: 3 }]).map((item) =>
      item.type === 'record' ? item.record.id : 'branch',
    ),
  ).toEqual(['user', 'tool-step', 'branch', 'reply']);
});
