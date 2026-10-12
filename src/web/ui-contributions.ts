import type { UiContribution } from '../core/types.js';

export function uiContributionsAt(
  contributions: readonly UiContribution[],
  slot: UiContribution['slot'],
): UiContribution[] {
  return contributions.filter((contribution) => contribution.slot === slot);
}
