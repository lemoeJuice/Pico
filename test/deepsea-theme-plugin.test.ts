import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionPipelines } from '../src/core/pipeline.js';
import { PicoStore } from '../src/core/store.js';
import { ToolCatalog } from '../src/executor/tool-catalog.js';
import { MAX_THEME_VARIABLES, themeRoleCoverageErrors } from '../src/contracts/plugin-theme.js';
import { CommandRegistry, PluginHost } from '../src/plugins/host.js';
import { deepseaThemePlugin } from '../src/plugins/deepsea-theme.js';
import { unavailablePluginServices } from '../src/plugins/services.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Deepsea Liquid Glass theme plugin', () => {
  it('registers its light-base blue glass palette through PluginHost', async () => {
    const store = new PicoStore(':memory:');
    const directory = mkdtempSync(join(tmpdir(), 'pico-deepsea-theme-test-'));
    temporaryDirectories.push(directory);
    const host = new PluginHost(
      store,
      new ToolCatalog(),
      new ExecutionPipelines(),
      new CommandRegistry(),
      directory,
      unavailablePluginServices,
    );
    try {
      await host.load([deepseaThemePlugin]);
      const [theme] = host.uiThemes();
      expect(theme).toMatchObject({
        pluginId: 'pico.deepsea-theme',
        id: 'pico.deepsea-theme:deepsea-blue-glass',
        appearance: 'light',
        background: { entry: 'webui', path: 'assets/deepsea-background.svg' },
        brandIcon: { entry: 'webui', path: 'assets/deepseek-whale.svg' },
        brandLabel: 'deepseek-theme',
        coverage: 'complete',
      });
      expect(themeRoleCoverageErrors(theme!)).toEqual([]);
      expect(theme!.inheritRoles).toContain('--pico-tool-success-surface');
      expect(theme!.inheritRoles).toContain('--pico-conversation-running-surface');
      expect(theme!.inheritRoles).toContain('--pico-mcp-security-surface');
      expect(theme!.inheritRoles).toContain('--pico-shell-sidebar-width-option-font-size');
      expect(Object.keys(theme!.variables).length).toBeLessThanOrEqual(MAX_THEME_VARIABLES);
      expect(Object.keys(theme!.variables).length).toBeGreaterThan(100);
      expect(theme!.variables['--pico-material-backdrop']).toBe('blur(22px)');
      expect(theme!.variables['--pico-accent']).toBe('#4176e6');
      expect(theme!.variables['--pico-page-bg']).toBe('#edf3fe');
      expect(theme!.variables['--pico-shell-app-shell-surface']).toContain('rgba(');
      expect(theme!.variables['--pico-shell-brand-name-text']).toBe('#253447');
      expect(theme!.variables['--pico-topbar-topbar-surface']).toContain('rgba(');
      expect(theme!.variables['--pico-settings-developer-diagnostic-card-surface']).toContain('rgba(');
      expect(theme!.variables['--pico-control-button-primary-hover']).toBe('#315fc4');
      expect(theme!.variables['--pico-control-modal-intro-text']).toBe('#687789');
      expect(theme!.variables['--pico-control-form-label-text']).toBe('#52677f');
      expect(theme!.variables['--pico-control-form-note-text']).toBe('#687789');
      expect(theme!.variables['--pico-control-select-option-text']).toBe('#52677f');
      expect(theme!.variables['--pico-control-select-option-active-text']).toBe('#315fc4');
      expect(theme!.variables['--pico-control-select-option-active-fill']).toBe('rgba(65, 118, 230, 0.12)');
      expect(theme!.variables['--pico-control-select-option-selected-text']).toBe('#315fc4');
      expect(theme!.variables['--pico-control-select-option-check']).toBe('#4176e6');
      expect(theme!.variables['--pico-control-switch-track-on']).toBe('#4176e6');
      expect(theme!.variables['--pico-model-selection-trigger-fill']).toBe('rgba(255, 255, 255, 0.78)');
      expect(theme!.variables['--pico-model-selection-trigger-hover-fill']).toBe('rgba(65, 118, 230, 0.08)');
      expect(theme!.variables['--pico-model-selection-panel-fill']).toBe('rgba(255, 255, 255, 0.96)');
      expect(theme!.variables['--pico-model-selection-panel-hover-fill']).toBe('rgba(65, 118, 230, 0.1)');
      expect(theme!.variables['--pico-model-selection-adapter-selected-fill']).toBe('rgba(65, 118, 230, 0.12)');
      expect(theme!.variables['--pico-model-selection-confirm-fill']).toBe('#4176e6');
      expect(theme!.variables['--pico-model-selection-submenu-fill']).toBe('rgba(255, 255, 255, 0.96)');
      expect(theme!.variables['--pico-composer-box-focus-border']).toBe('rgba(65, 118, 230, 0.48)');
      expect(theme!.variables['--pico-composer-usage-emphasis']).toBe('#315fc4');
      expect(theme!.variables['--pico-shell-icon-button-hover-surface']).toContain('rgba(');
      expect(theme!.variables['--pico-shell-project-folder-icon-text']).toBe('#315fc4');
      expect(theme!.variables['--pico-shell-thread-tree-toggle-focus-visible-focus-ring']).toBe(
        'rgba(65, 118, 230, 0.48)',
      );
      expect(theme!.variables['--pico-control-path-suggestion-text']).toBe('#315fc4');
      expect(theme!.variables['--pico-settings-plugin-manager-status-is-loaded-text']).toBe('#28734a');
      expect(theme!.variables['--pico-settings-plugin-manager-status-is-loaded-surface']).toContain('rgba(');
      expect(theme!.variables['--pico-settings-developer-status-is-ready-text']).toBe('#28734a');
      expect(theme!.variables['--pico-control-status-success-text']).toBe('#28734a');
      expect(theme!.variables['--pico-tool-success-surface']).toBeUndefined();
      expect(theme!.variables['--pico-conversation-running-surface']).toBeUndefined();
      expect(theme!.variables['--pico-conversation-detail-surface']).toBe('rgba(255, 255, 255, 0.68)');
      expect(theme!.variables['--pico-tool-code-surface']).toBe('rgba(255, 255, 255, 0.78)');
      expect(theme!.variables['--pico-tool-command-surface']).toBe('rgba(65, 118, 230, 0.08)');
      expect(theme!.variables['--pico-tool-nested-surface']).toBe('rgba(255, 255, 255, 0.68)');
      expect(theme!.variables['--pico-tool-control-surface']).toBe('rgba(65, 118, 230, 0.1)');
      expect(theme!.variables['--pico-toolbar-controls-toolbar-count-badge-surface']).toBe('rgba(65, 118, 230, 0.12)');
      expect(theme!.variables['--pico-toolbar-controls-plugin-toolbar-badge-surface']).toBe('rgba(65, 118, 230, 0.12)');
      expect(theme!.variables['--pico-conversation-compaction-icon-surface']).toBe('rgba(65, 118, 230, 0.1)');
      expect(theme!.variables['--pico-conversation-scroll-thumb-active']).toBe('#4176e6');
      expect(theme!.variables['--pico-conversation-inline-link']).toBe('#315fc4');
      expect(theme!.variables['--pico-dialog-history-branch-node-is-active-border']).toBe('rgba(65, 118, 230, 0.48)');
      expect(theme!.variables['--pico-dialog-history-branch-status-is-active-text']).toBe('#315fc4');
      expect(theme!.variables['--pico-public-button-primary-fill']).toBe('#4176e6');
      expect(theme!.variables['--pico-public-focus']).toBe('#4176e6');
      expect(theme!.variables['--pico-markdown-link']).toBe('#315fc4');
      expect(theme!.variables['--pico-dialog-executor-choice-surface']).toBe('rgba(255, 255, 255, 0.76)');
      expect(theme!.variables['--pico-dialog-executor-choice-chosen-surface']).toBe('rgba(65, 118, 230, 0.12)');
      expect(theme!.variables['--pico-dialog-executor-choice-chosen-border']).toBe('rgba(65, 118, 230, 0.48)');
      expect(theme!.variables['--pico-dialog-choice-icon-text']).toBe('#315fc4');
      expect(theme!.variables['--pico-dialog-executor-choice-text-variant-4']).toBe('#315fc4');
      expect(theme!.variables['--pico-shell-brand-mark-welcome-mark-surface']).toBe('rgba(255, 255, 255, 0.9)');
      expect(theme!.variables['--pico-topbar-connection-dot-online-thread-state-dot-state-running-surface']).toBe(
        '#42a867',
      );
    } finally {
      await host.shutdown();
      store.close();
    }
  });

  it('publishes the whale icon and a self-contained background without a logo', () => {
    const webuiRoot = join(process.cwd(), 'plugins/pico.deepsea-theme/webui');
    const manifest = JSON.parse(readFileSync(join(webuiRoot, 'theme-assets.json'), 'utf8')) as { assets: string[] };
    expect(manifest.assets).toEqual(['assets/deepseek-whale.svg', 'assets/deepsea-background.svg']);
    for (const asset of manifest.assets) expect(readFileSync(join(webuiRoot, asset), 'utf8')).toBeTruthy();
    const selfContainedBackground = readFileSync(join(webuiRoot, 'assets/deepsea-background.svg'), 'utf8');
    const whaleIcon = readFileSync(join(webuiRoot, 'assets/deepseek-whale.svg'), 'utf8');
    expect(whaleIcon).toContain('fill="#4D6BFE"');
    expect(whaleIcon).not.toContain('deepseek</');
    expect(selfContainedBackground).not.toContain('deepseek-whale.svg');
    expect(selfContainedBackground).not.toMatch(/href="data:image\/svg\+xml;base64,/);
    expect(readFileSync(join(webuiRoot, 'index.html'), 'utf8')).toContain(
      '<title>Deepsea Liquid Glass theme assets</title>',
    );
  });
});
