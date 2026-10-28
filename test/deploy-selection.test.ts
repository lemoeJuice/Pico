import { describe, expect, it } from 'vitest';

type Manifest = {
  version: 1;
  targets: Record<
    string,
    { files: Record<string, string>; actions: Record<string, { action: string; reason: string }> }
  >;
  checks: { files: Record<string, string>; actions: Record<string, { action: string; reason: string }> };
  ignoredPaths: Array<{ path: string; reason: string }>;
  unknownPaths: Array<{ path: string; reason: string }>;
};
type SelectionApi = {
  selectDeploymentScope(input: {
    options: { full: boolean; web: boolean; pluginIds: string[]; checks: boolean; acceptWarnings: boolean };
    currentManifest: Manifest;
    baselineManifest: Manifest | null;
    availablePluginIds: string[];
  }): {
    ok: boolean;
    blocked: boolean;
    scope: { full: boolean; mainWeb: boolean; pluginIds: string[]; checks: boolean };
    warnings: string[];
    errors: string[];
  };
};
// @ts-expect-error Plain .mjs helper intentionally has no project-wide declaration file.
import * as selectionApiUntyped from '../scripts/deploy/selection.mjs';
const { selectDeploymentScope } = selectionApiUntyped as unknown as SelectionApi;

const action = { action: 'incremental', reason: 'fixture' };
function manifest(
  targets: Record<string, Record<string, string>>,
  unknownPaths: Manifest['unknownPaths'] = [],
): Manifest {
  return {
    version: 1,
    targets: Object.fromEntries(
      Object.entries(targets).map(([name, files]) => [
        name,
        {
          files,
          actions: Object.fromEntries(Object.keys(files).map((file) => [file, action])),
        },
      ]),
    ),
    checks: { files: {}, actions: {} },
    ignoredPaths: [],
    unknownPaths,
  };
}
const baseline = manifest({
  runtime: { 'src/server.ts': 'a' },
  web: { 'src/web.tsx': 'a' },
  'plugin-ui:example.webui': { 'plugins/example/webui.tsx': 'a' },
  'plugin-ui:other.webui': { 'plugins/other/webui.tsx': 'a' },
});
const changed = manifest({
  runtime: { 'src/server.ts': 'a' },
  web: { 'src/web.tsx': 'b' },
  'plugin-ui:example.webui': { 'plugins/example/webui.tsx': 'b' },
  'plugin-ui:other.webui': { 'plugins/other/webui.tsx': 'a' },
});
const baseOptions = { full: false, web: false, pluginIds: [] as string[], checks: false, acceptWarnings: false };
const availablePluginIds = ['example.webui', 'other.webui'];
const select = (options: Partial<typeof baseOptions>, current = changed, before: Manifest | null = baseline) =>
  selectDeploymentScope({
    options: { ...baseOptions, ...options },
    currentManifest: current,
    baselineManifest: before,
    availablePluginIds,
  });

describe('explicit deploy scope selection', () => {
  it('allows a selected UI scope with no detected difference', () => {
    const result = select({ pluginIds: ['example.webui'] }, baseline, baseline);
    expect(result).toMatchObject({ ok: true, blocked: false, scope: { pluginIds: ['example.webui'] }, warnings: [] });
  });

  it('warns about changed targets outside the selected UI without expanding scope', () => {
    const result = select({ pluginIds: ['example.webui'] });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.warnings.join(' ')).toContain('web');
    expect(result.scope.pluginIds).toEqual(['example.webui']);
    expect(result.scope.mainWeb).toBe(false);
  });

  it('allows an explicit warning acceptance for range mismatches', () => {
    const result = select({ pluginIds: ['example.webui'], acceptWarnings: true });
    expect(result).toMatchObject({ ok: true, blocked: false, scope: { pluginIds: ['example.webui'] } });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects partial web or plugin scopes without a baseline even when warnings are accepted', () => {
    for (const options of [{ web: true }, { pluginIds: ['example.webui'] }]) {
      const result = select({ ...options, acceptWarnings: true }, changed, null);
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('baseline');
    }
  });

  it('reports unknown paths as warnings for UI scope and full scope', () => {
    const withUnknown = { ...changed, unknownPaths: [{ path: 'src/mystery.ts', reason: 'unclassified' }] };
    const partial = select({ pluginIds: ['example.webui'], acceptWarnings: true }, withUnknown);
    expect(partial.warnings.join(' ')).toContain('Unknown');
    const full = select({ full: true }, withUnknown, null);
    expect(full.ok).toBe(false);
    expect(full.warnings.join(' ')).toContain('Unknown');
    expect(select({ full: true, acceptWarnings: true }, withUnknown, null).ok).toBe(true);
  });

  it('selects full release explicitly and rejects mixing full with other scopes', () => {
    expect(select({ full: true }, changed, null)).toMatchObject({ ok: true, scope: { full: true } });
    expect(select({ full: true, web: true }, changed, null).errors.join(' ')).toContain('cannot be combined');
  });

  it('allows checks-only without a baseline and never selects release targets', () => {
    const result = select({ checks: true }, changed, null);
    expect(result).toMatchObject({
      ok: true,
      blocked: false,
      scope: { full: false, mainWeb: false, pluginIds: [], checks: true },
    });
  });

  it('does not require warning acceptance for checks-only with unknown source paths', () => {
    const withUnknown = { ...changed, unknownPaths: [{ path: 'src/mystery.ts', reason: 'unclassified' }] };
    expect(select({ checks: true }, withUnknown, null)).toMatchObject({ ok: true, blocked: false, warnings: [] });
  });

  it('rejects empty and unknown plugin selection, while allowing a plugin with no detected difference', () => {
    expect(select({}).errors.join(' ')).toContain('Select a deployment scope');
    expect(select({ pluginIds: ['missing.webui'] }).errors.join(' ')).toContain('no available source entry');
    expect(select({ pluginIds: ['other.webui'] }, baseline, baseline)).toMatchObject({ ok: true, blocked: false });
  });

  it('rejects checks combined with a release target and plugin targets missing from the manifest', () => {
    expect(select({ checks: true, web: true }).errors.join(' ')).toContain('cannot be combined');
    const withoutPluginTarget = manifest({ runtime: {}, web: {}, 'plugin-ui:other.webui': {} });
    expect(select({ pluginIds: ['example.webui'] }, withoutPluginTarget).errors.join(' ')).toContain('missing target');
  });

  it('warns about full classification when the changed file was deleted', () => {
    const current = manifest({ runtime: {}, web: {}, 'plugin-ui:example.webui': {}, 'plugin-ui:other.webui': {} });
    const before = manifest({
      runtime: {},
      web: {},
      'plugin-ui:example.webui': { 'plugins/example/old.ts': 'old' },
      'plugin-ui:other.webui': {},
    });
    before.targets['plugin-ui:example.webui']!.actions['plugins/example/old.ts'] = {
      action: 'full',
      reason: 'requires full release',
    };
    const result = select({ pluginIds: ['example.webui'] }, current, before);
    expect(result.warnings.join(' ')).toContain('full release');
    expect(result.blocked).toBe(true);
  });
});
