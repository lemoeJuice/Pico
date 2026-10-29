import { describe, expect, it, vi } from 'vitest';
import { AssistantDraftStore } from '../src/web/assistant-drafts-store.js';

describe('AssistantDraftStore', () => {
  it('resumes only at the matching offset and keeps unreplayed previews marked incomplete', () => {
    const store = new AssistantDraftStore();
    store.appendText('thread-a', 'execution-a', 'hello');
    store.markDisconnected();
    expect(store.resumeText('thread-a', 'execution-a', 4, '!')).toBe(false);
    expect(store.resumeText('thread-a', 'execution-b', 5, '!')).toBe(false);
    expect(store.resumeText('thread-a', 'execution-a', 5, ' world')).toBe(true);
    expect(store.getContent('thread-a')).toMatchObject({
      text: 'hello world', previewIncomplete: true,
    });
    expect(store.getContent('thread-a')?.unconfirmed).toBeUndefined();
    store.appendPreview('thread-a', 'execution-a', { type: 'reasoning', delta: 'missing earlier part' });
    expect(store.getContent('thread-a')?.reasoningSummary).toBeUndefined();
  });

  it('merges a matching overlap without duplicating text and rejects conflicts', () => {
    const store = new AssistantDraftStore();
    store.appendText('thread-a', 'execution-a', 'hello wor');
    store.markDisconnected();
    expect(store.resumeText('thread-a', 'execution-a', 5, ' wrong')).toBe(false);
    expect(store.resumeText('thread-a', 'execution-a', 5, ' world')).toBe(true);
    expect(store.getContent('thread-a')?.text).toBe('hello world');
  });

  it('retains partial text as unconfirmed on disconnect and clears only the matching execution', () => {
    const store = new AssistantDraftStore();
    const changed = vi.fn();
    store.subscribeContent('thread-a', changed);
    store.appendText('thread-a', 'execution-a', 'partial reply');
    store.appendText('thread-b', 'execution-b', 'other reply');
    changed.mockClear();

    store.markDisconnected();

    expect(store.getContent('thread-a')).toMatchObject({
      executionId: 'execution-a', text: 'partial reply', unconfirmed: true,
    });
    expect(store.getContent('thread-b')?.unconfirmed).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    store.clear('thread-a', 'execution-other');
    expect(store.getContent('thread-a')?.text).toBe('partial reply');
    store.clear('thread-a', 'execution-a');
    expect(store.getContent('thread-a')).toBeNull();
    expect(store.getContent('thread-b')?.text).toBe('other reply');
  });

  it('coalesces text notifications per frame while keeping the latest snapshot available', () => {
    const frames: Array<() => void> = [];
    const store = new AssistantDraftStore((callback) => frames.push(callback));
    const changed = vi.fn();
    store.subscribeContent('thread-a', changed);

    store.appendText('thread-a', 'execution-a', 'first');
    store.appendText('thread-a', 'execution-a', ' second');
    expect(store.getContent('thread-a')?.text).toBe('first second');
    expect(changed).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not let an old frame consume the notification for a replacement stream', () => {
    const frames: Array<() => void> = [];
    const store = new AssistantDraftStore((callback) => frames.push(callback));
    const changed = vi.fn();
    store.subscribeContent('thread-a', changed);

    store.appendText('thread-a', 'execution-a', 'old');
    store.clear('thread-a', 'execution-a');
    expect(changed).toHaveBeenCalledTimes(1);
    store.appendText('thread-a', 'execution-b', 'new');
    frames.shift()!();
    expect(changed).toHaveBeenCalledTimes(1);
    frames.shift()!();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(store.getContent('thread-a')?.text).toBe('new');
  });

  it('notifies content without notifying tool cards or tool layout during text streaming', () => {
    const store = new AssistantDraftStore();
    const contentChanged = vi.fn();
    const toolLayoutChanged = vi.fn();
    const toolCardChanged = vi.fn();
    store.subscribeContent('thread-a', contentChanged);
    store.subscribeToolSlots('thread-a', 'execution-a', toolLayoutChanged);
    store.subscribeToolPreview('thread-a', 'execution-a', 0, toolCardChanged);

    store.appendText('thread-a', 'execution-a', 'first');
    store.appendPreview('thread-a', 'execution-a', {
      type: 'tool',
      call: { index: 0, name: 'shell', argumentsText: '{"command":"a"}' },
    });
    contentChanged.mockClear();
    toolLayoutChanged.mockClear();
    toolCardChanged.mockClear();

    store.appendText('thread-a', 'execution-a', ' token');

    expect(store.getContent('thread-a')).toMatchObject({ executionId: 'execution-a', text: 'first token' });
    expect(contentChanged).toHaveBeenCalledTimes(1);
    expect(toolLayoutChanged).not.toHaveBeenCalled();
    expect(toolCardChanged).not.toHaveBeenCalled();
  });

  it('updates only the matching tool card while accumulating its preview arguments', () => {
    const store = new AssistantDraftStore();
    const layoutChanged = vi.fn();
    const firstCardChanged = vi.fn();
    const secondCardChanged = vi.fn();
    store.appendPreview('thread-a', 'execution-a', {
      type: 'tool',
      call: { index: 0, name: 'shell', argumentsText: '{"command":' },
    });
    store.subscribeToolSlots('thread-a', 'execution-a', layoutChanged);
    store.subscribeToolPreview('thread-a', 'execution-a', 0, firstCardChanged);
    store.subscribeToolPreview('thread-a', 'execution-a', 1, secondCardChanged);

    store.appendPreview('thread-a', 'execution-a', {
      type: 'tool',
      call: { index: 0, argumentsText: '{"command":"pwd"}' },
    });

    expect(store.getToolPreview('thread-a', 'execution-a', 0)?.argumentsText).toBe('{"command":"pwd"}');
    expect(layoutChanged).not.toHaveBeenCalled();
    expect(firstCardChanged).toHaveBeenCalledTimes(1);
    expect(secondCardChanged).not.toHaveBeenCalled();

    store.appendPreview('thread-a', 'execution-a', {
      type: 'tool',
      call: { index: 1, name: 'read_file', argumentsText: '{"path":' },
    });

    expect(store.getToolSlots('thread-a', 'execution-a')).toEqual([
      { index: 0, name: 'shell' },
      { index: 1, name: 'read_file' },
    ]);
    expect(layoutChanged).toHaveBeenCalledTimes(1);
    expect(firstCardChanged).toHaveBeenCalledTimes(1);
    expect(secondCardChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps other threads untouched and clears the selected stream on completion', () => {
    const store = new AssistantDraftStore();
    const firstThreadChanged = vi.fn();
    const secondThreadChanged = vi.fn();
    store.subscribeContent('thread-a', firstThreadChanged);
    store.subscribeContent('thread-b', secondThreadChanged);
    store.appendText('thread-a', 'execution-a', 'draft');
    store.appendText('thread-b', 'execution-b', 'other');
    firstThreadChanged.mockClear();
    secondThreadChanged.mockClear();

    store.clear('thread-a', 'execution-a');

    expect(store.getContent('thread-a')).toBeNull();
    expect(store.getContent('thread-b')?.text).toBe('other');
    expect(firstThreadChanged).toHaveBeenCalledTimes(1);
    expect(secondThreadChanged).not.toHaveBeenCalled();
  });

  it('preserves an earlier execution draft until its own snapshot handoff completes', () => {
    const store = new AssistantDraftStore();
    store.appendText('thread-a', 'execution-a', 'first reply');

    // A later execution starts before the earlier assistant record is visible.
    store.appendText('thread-a', 'execution-b', 'second reply');

    expect(store.getContents('thread-a')).toEqual([
      { executionId: 'execution-a', text: 'first reply', settled: true },
      { executionId: 'execution-b', text: 'second reply' },
    ]);
    expect(store.getContent('thread-a')).toMatchObject({ executionId: 'execution-b', text: 'second reply' });

    store.clear('thread-a', 'execution-a');
    expect(store.getContentForExecution('thread-a', 'execution-a')).toBeNull();
    expect(store.getContents('thread-a')).toEqual([{ executionId: 'execution-b', text: 'second reply' }]);

    store.clear('thread-a', 'execution-b');
    expect(store.getContents('thread-a')).toEqual([]);
  });

  it('retains a settled visible draft until handoff and clears confirmed drafts when leaving', () => {
    const store = new AssistantDraftStore();
    store.appendText('thread-a', 'execution-a', 'finished reply');
    store.markSettled('thread-a', 'execution-a', 12);
    expect(store.getContents('thread-a')).toEqual([
      { executionId: 'execution-a', text: 'finished reply', settled: true, committedSeq: 12 },
    ]);
    store.appendText('thread-a', 'execution-b', 'still writing');
    store.clearCommitted('thread-a');
    expect(store.getContents('thread-a')).toEqual([{ executionId: 'execution-b', text: 'still writing' }]);
  });
});
