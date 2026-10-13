import { describe, expect, it } from 'vitest';
import type { UiContribution } from '../src/core/types.js';
import { toolRendererForCall, uiContributionsAt } from '../src/web/ui-contributions.js';

describe('semantic plugin UI slots', () => {
  it('routes toolbar, composer, and sidebar contributions to their matching surface', () => {
    const toolbar: UiContribution = { slot: 'thread.toolbar', id: 'toolbar', label: 'Toolbar' };
    const composer: UiContribution = { slot: 'composer.action', id: 'composer', label: 'Composer' };
    const sidebar: UiContribution = { slot: 'sidebar.panel', id: 'sidebar', label: 'Sidebar' };
    const renderer: UiContribution = {
      slot: 'tool.renderer',
      id: 'read-file-renderer',
      label: 'Read file renderer',
      toolNames: ['read_file'],
    };
    const contributions = [toolbar, composer, sidebar, renderer];

    expect(uiContributionsAt(contributions, 'thread.toolbar')).toEqual([toolbar]);
    expect(uiContributionsAt(contributions, 'composer.action')).toEqual([composer]);
    expect(uiContributionsAt(contributions, 'sidebar.panel')).toEqual([sidebar]);
    expect(uiContributionsAt(contributions, 'tool.renderer')).toEqual([renderer]);
    expect(toolRendererForCall(contributions, 'read_file')).toEqual(renderer);
    expect(toolRendererForCall(contributions, 'shell')).toBeUndefined();
    const globalRenderer: UiContribution = { slot: 'tool.renderer', id: 'all-tools', label: 'All tools' };
    expect(toolRendererForCall([...contributions, globalRenderer], 'shell')).toEqual(globalRenderer);
  });
});
