import type { UiContribution } from '../core/types.js';

export function pluginUiContributionKey(contribution: UiContribution): string {
  return JSON.stringify([
    contribution.slot,
    contribution.pluginId ?? '',
    contribution.entry ?? '',
    contribution.component ?? '',
    contribution.id,
  ]);
}

export function uiContributionsAt(
  contributions: readonly UiContribution[],
  slot: UiContribution['slot'],
  provider?: string,
): UiContribution[] {
  const matches = contributions.filter(
    (contribution) =>
      contribution.slot === slot &&
      (contribution.providers === undefined || (provider !== undefined && contribution.providers.includes(provider))),
  );
  if (slot !== 'composer.model') return matches;

  // Keep provider-specific model selectors before shared controls and popovers at the end.
  const displayOrder = (contribution: UiContribution): number => {
    if (contribution.supportsPopover) return 2;
    return contribution.providers === undefined ? 1 : 0;
  };
  return matches.sort((left, right) => displayOrder(left) - displayOrder(right));
}

export function toolResultForCall(
  contributions: readonly UiContribution[],
  toolName: string,
): UiContribution | undefined {
  return uiContributionsAt(contributions, 'tool.result').find(
    (contribution) => contribution.toolNames === undefined || contribution.toolNames.includes(toolName),
  );
}
