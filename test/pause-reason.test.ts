import { describe, expect, it } from 'vitest';
import { visiblePauseReason } from '../src/web/pause-reason.js';

describe('durable Thread pause reason', () => {
  it('shows the persisted reason after transient UI state is gone', () => {
    expect(visiblePauseReason('paused', 'Model step failed: provider context limit')).toBe(
      'Model step failed: provider context limit',
    );
  });

  it('does not repeat a reason already covered by a transient banner', () => {
    expect(
      visiblePauseReason('paused', 'Model step failed: provider context limit', ['provider context limit']),
    ).toBeNull();
  });

  it('shows a reason while the Thread is still pausing but not after it resumes', () => {
    expect(visiblePauseReason('pausing', 'Paused by user. Current Tool execution will settle.')).toContain(
      'Current Tool execution will settle.',
    );
    expect(visiblePauseReason('running', 'Paused by user. Current Tool execution will settle.')).toBeNull();
  });
});
