import { describe, expect, it } from 'vitest';
import type { UiContribution } from '../src/core/types.js';
import { uiContributionsAt } from '../src/web/ui-contributions.js';

describe('semantic plugin UI slots', () => {
  it('routes toolbar, composer, and sidebar contributions to their matching surface', () => {
    const toolbar: UiContribution = { slot: 'thread.toolbar', id: 'toolbar', label: 'Toolbar' };
    const composer: UiContribution = { slot: 'composer.action', id: 'composer', label: 'Composer' };
    const sidebar: UiContribution = { slot: 'sidebar.panel', id: 'sidebar', label: 'Sidebar' };
    const contributions = [toolbar, composer, sidebar];

    expect(uiContributionsAt(contributions, 'thread.toolbar')).toEqual([toolbar]);
    expect(uiContributionsAt(contributions, 'composer.action')).toEqual([composer]);
    expect(uiContributionsAt(contributions, 'sidebar.panel')).toEqual([sidebar]);
  });
});
