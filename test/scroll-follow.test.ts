import { describe, expect, it } from 'vitest';
import { isNearScrollEnd } from '../src/web/scroll-follow.js';

describe('conversation scroll following', () => {
  it('follows when the viewport is at or close to the latest content', () => {
    expect(isNearScrollEnd({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 })).toBe(true);
    expect(isNearScrollEnd({ scrollHeight: 1000, scrollTop: 828, clientHeight: 100 })).toBe(true);
  });

  it('stops following while the user reads earlier content', () => {
    expect(isNearScrollEnd({ scrollHeight: 1000, scrollTop: 827, clientHeight: 100 })).toBe(false);
  });

  it('allows the near-end distance to be tuned for the viewport', () => {
    expect(isNearScrollEnd({ scrollHeight: 1000, scrollTop: 800, clientHeight: 100 }, 120)).toBe(true);
  });
});
