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

const informationalPauseReasonPrefixes = [
  'Paused by user.',
  'Interrupted by user.',
  'Paused from parent collaboration panel',
  'Rolling Context was manually compacted.',
  'Context rewound before the next Model response.',
];

export function pauseReasonIsError(pauseReason: string | null): boolean {
  return Boolean(
    pauseReason && !informationalPauseReasonPrefixes.some((prefix) => pauseReason.startsWith(prefix)),
  );
}
