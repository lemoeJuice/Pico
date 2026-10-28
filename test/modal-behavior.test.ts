import { describe, expect, it } from 'vitest';
import { shouldCloseModalOnEscape } from '../src/web/modal-behavior.js';

describe('modal keyboard behavior', () => {
  const escape = { key: 'Escape', keyCode: 27, isComposing: false, defaultPrevented: false };

  it('closes only for an unhandled Escape on the topmost dialog', () => {
    expect(shouldCloseModalOnEscape(escape, true)).toBe(true);
    expect(shouldCloseModalOnEscape(escape, false)).toBe(false);
    expect(shouldCloseModalOnEscape({ ...escape, defaultPrevented: true }, true)).toBe(false);
  });

  it('leaves Escape to IME composition and other keys to the active control', () => {
    expect(shouldCloseModalOnEscape({ ...escape, isComposing: true }, true)).toBe(false);
    expect(shouldCloseModalOnEscape({ ...escape, keyCode: 229 }, true)).toBe(false);
    expect(shouldCloseModalOnEscape({ ...escape, key: 'Enter' }, true)).toBe(false);
  });
});
