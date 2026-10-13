import type { UiContribution } from '../core/types.js';

export function uiContributionsAt(
  contributions: readonly UiContribution[],
  slot: UiContribution['slot'],
  provider?: string,
): UiContribution[] {
  return contributions.filter(
    (contribution) =>
      contribution.slot === slot &&
      (contribution.providers === undefined || (provider !== undefined && contribution.providers.includes(provider))),
  );
}

export function toolRendererForCall(
  contributions: readonly UiContribution[],
  toolName: string,
): UiContribution | undefined {
  return uiContributionsAt(contributions, 'tool.renderer').find(
    (contribution) => contribution.toolNames === undefined || contribution.toolNames.includes(toolName),
  );
}
