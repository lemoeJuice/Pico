import { describe, expect, it } from 'vitest';
import type { UiContribution } from '../src/core/types.js';
import { toolResultForCall, uiContributionsAt } from '../src/web/ui-contributions.js';

describe('semantic plugin UI slots', () => {
  it('mounts provider model controls only for the selected provider and preserves unscoped controls', () => {
    const chatgpt: UiContribution = {
      slot: 'composer.model',
      id: 'chatgpt',
      label: 'ChatGPT',
      providers: ['chatgpt-plan'],
    };
    const global: UiContribution = { slot: 'composer.model', id: 'global', label: 'Global' };
    expect(uiContributionsAt([chatgpt, global], 'composer.model', 'openai-compatible')).toEqual([global]);
    expect(uiContributionsAt([chatgpt, global], 'composer.model', 'chatgpt-plan')).toEqual([chatgpt, global]);
    expect(uiContributionsAt([chatgpt, global], 'composer.model')).toEqual([global]);
  });

  it('routes toolbar, composer, and sidebar contributions to their matching surface', () => {
    const toolbar: UiContribution = { slot: 'thread.toolbar', id: 'toolbar', label: 'Toolbar' };
    const composer: UiContribution = { slot: 'composer.action', id: 'composer', label: 'Composer' };
    const sidebar: UiContribution = { slot: 'sidebar.panel', id: 'sidebar', label: 'Sidebar' };
    const resultActions: UiContribution = {
      slot: 'tool.result',
      id: 'read-file-result-actions',
      label: 'Read file result actions',
      toolNames: ['read_file'],
    };
    const contributions = [toolbar, composer, sidebar, resultActions];

    expect(uiContributionsAt(contributions, 'thread.toolbar')).toEqual([toolbar]);
    expect(uiContributionsAt(contributions, 'composer.action')).toEqual([composer]);
    expect(uiContributionsAt(contributions, 'sidebar.panel')).toEqual([sidebar]);
    expect(uiContributionsAt(contributions, 'tool.result')).toEqual([resultActions]);
    expect(toolResultForCall(contributions, 'read_file')).toEqual(resultActions);
    expect(toolResultForCall(contributions, 'shell')).toBeUndefined();
    const globalResultActions: UiContribution = { slot: 'tool.result', id: 'all-tools', label: 'All tools' };
    expect(toolResultForCall([...contributions, globalResultActions], 'shell')).toEqual(globalResultActions);
  });
});
