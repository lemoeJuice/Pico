import { describe, expect, it } from 'vitest';
import { ModelDraftBuffer } from '../src/runtime/model-draft-buffer.js';

describe('ModelDraftBuffer', () => {
  it('uses UTF-16 offsets and reports when the retained suffix has a gap', () => {
    const drafts = new ModelDraftBuffer({ maxStreamCodeUnits: 4, maxTotalCodeUnits: 8 });
    drafts.begin('thread-a', 'execution-a');
    drafts.append('thread-a', 'execution-a', 0, 'A😀B');

    expect(drafts.read('thread-a', 'execution-a', 1)).toMatchObject({
      status: 'available',
      text: '😀B',
      fromOffset: 1,
      nextOffset: 4,
      latestOffset: 4,
    });

    drafts.append('thread-a', 'execution-a', 4, 'CDE');
    expect(drafts.read('thread-a', 'execution-a', 2)).toMatchObject({
      status: 'gap',
      requestedOffset: 2,
      availableFromOffset: 3,
      availableThroughOffset: 7,
    });
    expect(drafts.read('thread-a', 'execution-a', 3)).toMatchObject({
      status: 'available',
      text: 'BCDE',
      nextOffset: 7,
    });
  });

  it('bounds aggregate retained text and reports an evicted stream as a gap', () => {
    const drafts = new ModelDraftBuffer({ maxStreamCodeUnits: 4, maxTotalCodeUnits: 4, maxStreams: 2 });
    drafts.begin('thread-a', 'execution-a');
    drafts.append('thread-a', 'execution-a', 0, '1234');
    drafts.begin('thread-b', 'execution-b');
    drafts.append('thread-b', 'execution-b', 0, 'ABCD');

    expect(drafts.read('thread-a', 'execution-a', 0)).toMatchObject({
      status: 'gap',
      availableFromOffset: null,
      availableThroughOffset: null,
    });
    expect(drafts.read('thread-b', 'execution-b', 0)).toMatchObject({ status: 'available', text: 'ABCD' });
  });

  it('releases a stream on end and rejects invalid offsets', () => {
    const drafts = new ModelDraftBuffer();
    drafts.begin('thread-a', 'execution-a');
    drafts.append('thread-a', 'execution-a', 0, 'draft');
    drafts.end('thread-a', 'execution-a');

    expect(drafts.read('thread-a', 'execution-a', 0).status).toBe('gap');
    expect(() => drafts.read('thread-a', 'execution-a', -1)).toThrow(RangeError);
  });
});
