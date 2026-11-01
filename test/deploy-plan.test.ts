import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The release helpers are plain Node ESM modules; keep their test-facing shape explicit here.
type ManifestTarget = { files: Record<string, string>; actions: Record<string, { action: string; reason: string }> };
type Manifest = {
  version: 1;
  targets: Record<string, ManifestTarget>;
  checks: { files: Record<string, string>; actions: Record<string, { action: string; reason: string }> };
  ignoredPaths: Array<{ path: string; reason: string }>;
  unknownPaths: Array<{ path: string; reason: string }>;
};
type ChangeDiagnostic = {
  targets: Array<{ target: string; paths: string[] }>;
  changedChecks: Array<{ path: string; action: string }>;
  unknownPaths: Array<{ path: string; reason: string }>;
};
type ManifestApi = {
  buildReleaseManifest: (rootDir: string) => Manifest;
  diagnoseChanges: (input: { currentManifest: Manifest; baselineManifest: Manifest | null }) => ChangeDiagnostic;
  readReleaseBaseline: (filePath: string) => Manifest | null;
  writeReleaseBaseline: (filePath: string, manifest: Manifest) => void;
};
type RulesApi = { classifyPath: (path: string) => { kind: string; action?: string; targets?: string[] } };
// @ts-expect-error Plain .mjs helpers intentionally have no project-wide declaration file.
import * as manifestApiUntyped from '../scripts/deploy/manifest.mjs';
const { buildReleaseManifest, diagnoseChanges, readReleaseBaseline, writeReleaseBaseline } =
  manifestApiUntyped as unknown as ManifestApi;
// @ts-expect-error Plain .mjs helpers intentionally have no project-wide declaration file.
import { classifyPath } from '../scripts/deploy/rules.mjs';
const classifyPathTyped = classifyPath as unknown as RulesApi['classifyPath'];

const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pico-deploy-plan-'));
  temporaryRoots.push(root);
  return root;
}

function put(root: string, relativePath: string, contents: string) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deploy rules and manifests', () => {
  it('classifies documentation and production inspection separately from release payload', () => {
    expect(classifyPathTyped('docs/production-deployment.md').kind).toBe('ignore');
    expect(classifyPathTyped('test/deploy-plan.test.ts').kind).toBe('check');
    expect(classifyPathTyped('scripts/deploy-production.mjs').kind).toBe('ignore');
    expect(classifyPathTyped('plugins/example-plugin.mjs')).toMatchObject({
      kind: 'deploy',
      targets: ['runtime'],
      action: 'full',
    });
    expect(classifyPathTyped('public/pico-plugin-ui-bridge.js')).toMatchObject({
      kind: 'deploy',
      targets: expect.arrayContaining(['web', 'plugin-ui:pico.chatgpt-plan', 'plugin-ui:pico.todo']),
    });
  });

  it('hashes actual source files including untracked files, while excluding generated and sensitive state', () => {
    const root = fixture();
    put(root, 'src/server.ts', 'tracked or untracked source');
    put(root, 'src/server-extra.ts', 'new source without Git status dependency');
    put(root, 'test/smoke.test.ts', 'check input');
    put(root, 'dist/server.js', 'generated bundle');
    put(root, 'plugins/pico.todo/runtime.mjs', 'generated plugin runtime');
    put(root, 'plugins/pico.todo/webui/build/index.js', 'generated plugin UI');
    put(root, 'data/pico.sqlite', 'local database');
    put(root, '.env', 'secret=must-not-be-read');
    put(root, '.codex/private.json', 'private local config');
    put(root, '.git/config', 'git metadata');

    const manifest = buildReleaseManifest(root);
    expect(manifest.targets.runtime!.files['src/server.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.targets.runtime!.files['src/server-extra.ts']).toMatch(/^[a-f0-9]{64}$/);
    const allHashedPaths = Object.values(manifest.targets).flatMap((target) => Object.keys(target.files));
    expect(allHashedPaths).not.toContain('dist/server.js');
    expect(allHashedPaths.some((file) => file.startsWith('data/'))).toBe(false);
    expect(allHashedPaths.some((file) => file.includes('runtime.mjs'))).toBe(false);
    expect(allHashedPaths.some((file) => file.startsWith('.env'))).toBe(false);
    expect(manifest.checks.files['test/smoke.test.ts']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ignores the root LICENSE as documentation rather than treating it as an unknown release path', () => {
    const root = fixture();
    put(root, 'LICENSE', 'license terms');

    const manifest = buildReleaseManifest(root);
    const allHashedPaths = Object.values(manifest.targets).flatMap((target) => Object.keys(target.files));
    expect(manifest.unknownPaths).toEqual([]);
    expect(allHashedPaths).not.toContain('LICENSE');
    expect(manifest.ignoredPaths).toContainEqual({
      path: 'LICENSE',
      reason: 'Documentation changes do not require deployment or product checks.',
    });
  });

  it('reports per-target additions, modifications, and removals without widening deployment', () => {
    const root = fixture();
    put(root, 'src/server.ts', 'runtime-v1');
    put(root, 'src/web/app.tsx', 'web-v1');
    put(root, 'src/plugins/chatgpt-plan/webui-entry.tsx', 'plugin-ui-v1');
    put(root, 'plugins/pico.chatgpt-plan/webui/old-view.tsx', 'existing plugin UI file');
    const baseline = buildReleaseManifest(root);
    put(root, 'src/server.ts', 'runtime-v2');
    put(root, 'src/web/new-view.tsx', 'added web file');
    put(root, 'plugins/pico.chatgpt-plan/webui/new-view.tsx', 'added web file');
    const beforeRemoval = buildReleaseManifest(root);
    rmSync(path.join(root, 'plugins/pico.chatgpt-plan/webui/new-view.tsx'));
    rmSync(path.join(root, 'plugins/pico.chatgpt-plan/webui/old-view.tsx'));
    const current = buildReleaseManifest(root);

    const diagnostic = diagnoseChanges({ currentManifest: current, baselineManifest: baseline });
    expect(diagnostic.targets.map((target) => target.target)).toEqual([
      'plugin-ui:pico.chatgpt-plan',
      'runtime',
      'web',
    ]);
    expect(diagnostic.targets.find((target) => target.target === 'runtime')?.paths).toContain('src/server.ts');
    expect(diagnostic.targets.find((target) => target.target === 'web')?.paths).toContain('src/web/new-view.tsx');
    expect(diagnostic.targets.find((target) => target.target === 'plugin-ui:pico.chatgpt-plan')?.paths).toContain(
      'plugins/pico.chatgpt-plan/webui/old-view.tsx',
    );
    expect(
      beforeRemoval.targets['plugin-ui:pico.chatgpt-plan']!.files['plugins/pico.chatgpt-plan/webui/old-view.tsx'],
    ).toBeTruthy();
  });

  it('uses isolated plugin UI baselines and treats shared contracts and dependencies as full release work', () => {
    const root = fixture();
    put(root, 'src/plugins/chatgpt-plan/webui-entry.tsx', 'chatgpt-ui-v1');
    put(root, 'src/plugins/openai-provider/webui.tsx', 'provider-ui-v1');
    const baseline = buildReleaseManifest(root);
    put(root, 'src/plugins/chatgpt-plan/webui-entry.tsx', 'chatgpt-ui-v2');
    const pluginDiagnostic = diagnoseChanges({
      currentManifest: buildReleaseManifest(root),
      baselineManifest: baseline,
    });
    expect(pluginDiagnostic.targets.map((target) => target.target)).toEqual(['plugin-ui:pico.chatgpt-plan']);

    put(root, 'src/contracts/protocol.ts', 'protocol change');
    const contractDiagnostic = diagnoseChanges({
      currentManifest: buildReleaseManifest(root),
      baselineManifest: baseline,
    });
    expect(contractDiagnostic.targets.map((target) => target.target)).toEqual(
      expect.arrayContaining([
        'runtime',
        'web',
        'plugin-ui:pico.chatgpt-plan',
        'plugin-ui:pico.openai-provider',
        'plugin-ui:pico.qq-adapter',
      ]),
    );
    expect(contractDiagnostic.targets.every((target) => Object.keys(target).sort().join(',') === 'paths,target')).toBe(
      true,
    );
    expect(classifyPathTyped('package-lock.json').action).toBe('full');
    expect(classifyPathTyped('src/plugins/model-parameters/index.ts')).toMatchObject({
      targets: ['runtime'],
      action: 'full',
    });
    expect(classifyPathTyped('src/plugins/openai-provider/form.ts')).toMatchObject({
      targets: ['runtime'],
      action: 'full',
    });
    expect(classifyPathTyped('src/server.ts')).toMatchObject({ targets: ['runtime'], action: 'full' });
  });

  it('includes a loaded root-level plugin module in the Runtime full-release baseline', () => {
    const root = fixture();
    put(root, 'src/server.ts', 'runtime-v1');
    const baseline = buildReleaseManifest(root);
    put(root, 'plugins/example-plugin.mjs', 'export default { id: "example" };');

    const current = buildReleaseManifest(root);
    expect(current.targets.runtime!.files['plugins/example-plugin.mjs']).toMatch(/^[a-f0-9]{64}$/);
    const diagnostic = diagnoseChanges({ currentManifest: current, baselineManifest: baseline });
    expect(diagnostic.targets).toContainEqual({
      target: 'runtime',
      paths: ['plugins/example-plugin.mjs'],
    });
  });

  it('tracks the Deepsea theme runtime and image assets in their respective release targets', () => {
    const root = fixture();
    put(root, 'src/plugins/deepsea-theme.ts', 'theme runtime');
    put(root, 'plugins/pico.deepsea-theme.mjs', 'theme entry');
    put(root, 'plugins/pico.deepsea-theme/webui/index.html', 'theme assets entry');
    put(root, 'plugins/pico.deepsea-theme/webui/theme-assets.json', '{"assets":["assets/whale.svg"]}');
    put(root, 'plugins/pico.deepsea-theme/webui/assets/whale.svg', '<svg/>');

    const manifest = buildReleaseManifest(root);
    expect(manifest.unknownPaths).toEqual([]);
    expect(manifest.targets.runtime!.files['src/plugins/deepsea-theme.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.targets.runtime!.files['plugins/pico.deepsea-theme.mjs']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.targets['plugin-ui:pico.deepsea-theme']!.files['plugins/pico.deepsea-theme/webui/assets/whale.svg'])
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports unknown source paths and check changes without selecting work', () => {
    const root = fixture();
    put(root, 'src/server.ts', 'baseline');
    const baseline = buildReleaseManifest(root);
    put(root, 'src/unmapped/new-format.bin', 'unknown source');
    let diagnostic = diagnoseChanges({ currentManifest: buildReleaseManifest(root), baselineManifest: baseline });
    expect(diagnostic.unknownPaths.map((entry) => entry.path)).toContain('src/unmapped/new-format.bin');

    rmSync(path.join(root, 'src/unmapped'), { recursive: true });
    put(root, 'docs/release-notes.md', 'documentation only');
    put(root, 'test/new.test.ts', 'test only');
    diagnostic = diagnoseChanges({ currentManifest: buildReleaseManifest(root), baselineManifest: baseline });
    expect(diagnostic.targets).toEqual([]);
    expect(diagnostic.changedChecks.map((entry) => entry.path)).toContain('test/new.test.ts');
    expect(classifyPathTyped('docs/release-notes.md').kind).toBe('ignore');
    expect(classifyPathTyped('test/new.test.ts').kind).toBe('check');
  });

  it('reports no target or check differences when the baseline is missing and reads/writes valid baselines', () => {
    const root = fixture();
    put(root, 'src/server.ts', 'source');
    const current = buildReleaseManifest(root);
    current.unknownPaths.push({ path: 'src/unclassified.bin', reason: 'unclassified source' });
    expect(diagnoseChanges({ currentManifest: current, baselineManifest: null })).toEqual({
      targets: [],
      changedChecks: [],
      unknownPaths: [{ path: 'src/unclassified.bin', reason: 'unclassified source' }],
    });

    const baselinePath = path.join(root, 'baseline.json');
    writeReleaseBaseline(baselinePath, current);
    expect(readReleaseBaseline(baselinePath)?.version).toBe(1);
    expect(JSON.parse(readFileSync(baselinePath, 'utf8')).targets.runtime.files['src/server.ts']).toBeTruthy();
    writeFileSync(baselinePath, '{broken json');
    expect(readReleaseBaseline(baselinePath)).toBeNull();
    expect(diagnoseChanges({ currentManifest: current, baselineManifest: readReleaseBaseline(baselinePath) })).toEqual({
      targets: [],
      changedChecks: [],
      unknownPaths: [{ path: 'src/unclassified.bin', reason: 'unclassified source' }],
    });
  });
});
