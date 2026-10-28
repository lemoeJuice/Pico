import { describe, expect, it } from 'vitest';
import type { UiContribution } from '../src/core/types.js';
import { pluginUiContributionKey, toolResultForCall, uiContributionsAt } from '../src/web/ui-contributions.js';
import { clampPluginPopoverWidth } from '../src/web/plugin-ui-sizing.js';
import { readFileSync } from 'node:fs';

describe('semantic plugin UI slots', () => {
  it('keeps React view identities scoped to their UI slot', () => {
    const component = {
      id: 'settings',
      pluginId: 'example.plugin',
      entry: 'webui',
      component: 'Settings',
      label: 'Settings',
    };
    expect(pluginUiContributionKey({ ...component, slot: 'thread.toolbar' })).not.toBe(
      pluginUiContributionKey({ ...component, slot: 'composer.model' }),
    );
  });

  it('uses a fixed host-owned popover width bounded by the viewport', () => {
    expect(clampPluginPopoverWidth(500)).toBe(360);
    expect(clampPluginPopoverWidth(400)).toBe(360);
    expect(clampPluginPopoverWidth(100)).toBe(76);
  });

  it('lets the block popover scroll long host-rendered content within the visible viewport', () => {
    const css = readFileSync(new URL('../src/web/styles/regions/toolbar-panels.css', import.meta.url), 'utf8');
    const view = readFileSync(new URL('../src/web/plugin-web-view.tsx', import.meta.url), 'utf8');
    expect(css).toMatch(/\.plugin-toolbar-popover\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.plugin-toolbar-popover > \.plugin-ui-host-rendered\s*\{[^}]*display:\s*block;/s);
    expect(css).toContain('max-width: calc(100vw - 24px)');
    expect(view).not.toContain('toolbarContentHeight');
    expect(view).toContain('maxHeight: popover ? availablePopoverHeight');
    expect(view).toContain("display: popover ? 'block' : 'none'");
  });

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
