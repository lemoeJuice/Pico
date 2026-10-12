import type { ThreadState } from '../core/types.js';

export function visiblePauseReason(
  state: ThreadState,
  pauseReason: string | null,
  transientMessages: readonly string[] = [],
): string | null {
  if ((state !== 'paused' && state !== 'pausing') || !pauseReason) return null;
  if (transientMessages.some((message) => message.length > 0 && pauseReason.includes(message))) return null;
  return pauseReason;
}
