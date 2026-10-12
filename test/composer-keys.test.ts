import { describe, expect, it } from 'vitest';
import { shouldSubmitOnEnter } from '../src/web/composer-keys.js';

describe('message composer Enter handling', () => {
  it('submits plain Enter and preserves Shift+Enter', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })).toBe(true);
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('does not submit Enter used to confirm an IME candidate', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 })).toBe(false);
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false);
  });

  it('does not treat another key as a submit action', () => {
    expect(shouldSubmitOnEnter({ key: 'Escape', shiftKey: false, isComposing: false, keyCode: 27 })).toBe(false);
  });
});
