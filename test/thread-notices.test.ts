import { describe, expect, it } from 'vitest';
import { noticeForThread, withThreadNotice, withoutThreadNotice } from '../src/web/thread-notices.js';

describe('Thread-scoped notices', () => {
  it('keeps a background command result with its Thread until the user returns', () => {
    const notices = withThreadNotice({}, 'thread-a', 'Command finished.');

    expect(noticeForThread('thread-b', notices)).toBe('');
    expect(noticeForThread('thread-a', notices)).toBe('Command finished.');
  });

  it('dismisses only the selected Thread notice and leaves general notices independent', () => {
    const notices = withThreadNotice(withThreadNotice({}, 'thread-a', 'A finished.'), 'thread-b', 'B finished.');
    const dismissed = withoutThreadNotice(notices, 'thread-a');

    expect(noticeForThread('thread-a', dismissed)).toBe('');
    expect(noticeForThread('thread-b', dismissed)).toBe('B finished.');
    expect(noticeForThread(null, dismissed, 'Settings saved.')).toBe('Settings saved.');
  });
});
