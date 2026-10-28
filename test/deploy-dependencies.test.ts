import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Plain .mjs helper intentionally has no project-wide declaration file.
import { compareInstalledLock as compareInstalledLockUntyped } from '../scripts/deploy/dependencies.mjs';

type Comparison = { matches: boolean; reason: string };
type LockEntry = { name?: string; version?: string; integrity?: string; optional?: boolean };
const compareInstalledLock = compareInstalledLockUntyped as unknown as (
  snapshotRoot: string,
  workspaceRoot: string,
) => Comparison;

const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pico-deploy-dependencies-'));
  temporaryRoots.push(root);
  const snapshotRoot = path.join(root, 'snapshot');
  const workspaceRoot = path.join(root, 'workspace');
  mkdirSync(snapshotRoot, { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'node_modules'), { recursive: true });
  return { root, snapshotRoot, workspaceRoot };
}

function entries(): Record<string, LockEntry> {
  return {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/required': { version: '2.3.4', integrity: 'sha512-required' },
    'node_modules/optional': { version: '5.6.7', integrity: 'sha512-optional', optional: true },
  };
}

function writeLocks(snapshotRoot: string, workspaceRoot: string, installedPackages = entries()) {
  const lock = { name: 'fixture', lockfileVersion: 3, packages: entries() };
  const installedLock = { lockfileVersion: 3, packages: installedPackages };
  writeFileSync(path.join(snapshotRoot, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(path.join(workspaceRoot, 'node_modules', '.package-lock.json'), JSON.stringify(installedLock));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('compareInstalledLock', () => {
  it('accepts an installed inventory with matching versions and integrity values', () => {
    const { snapshotRoot, workspaceRoot } = fixture();
    writeLocks(snapshotRoot, workspaceRoot);
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: true });
  });

  it('rejects a mismatched package version', () => {
    const { snapshotRoot, workspaceRoot } = fixture();
    const installed = entries();
    installed['node_modules/required']!.version = '9.9.9';
    writeLocks(snapshotRoot, workspaceRoot, installed);
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: false });
  });

  it('rejects mismatched integrity even when the package version matches', () => {
    const { snapshotRoot, workspaceRoot } = fixture();
    const installed = entries();
    installed['node_modules/required']!.integrity = 'sha512-different';
    writeLocks(snapshotRoot, workspaceRoot, installed);
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: false });
  });

  it('rejects missing required packages but permits missing optional packages', () => {
    const { snapshotRoot, workspaceRoot } = fixture();
    const withoutRequired = entries();
    delete withoutRequired['node_modules/required'];
    writeLocks(snapshotRoot, workspaceRoot, withoutRequired);
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: false });

    const withoutOptional = entries();
    delete withoutOptional['node_modules/optional'];
    writeLocks(snapshotRoot, workspaceRoot, withoutOptional);
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: true });
  });

  it('rejects packages present in node_modules but absent from the snapshot lock', () => {
    const { snapshotRoot, workspaceRoot } = fixture();
    const installed = entries();
    installed['node_modules/extra'] = { version: '1.0.0', integrity: 'sha512-extra' };
    writeLocks(snapshotRoot, workspaceRoot, installed);
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: false });
  });

  it('fails safely when either lock is missing or malformed', () => {
    const { snapshotRoot, workspaceRoot } = fixture();
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: false });

    writeLocks(snapshotRoot, workspaceRoot);
    writeFileSync(path.join(workspaceRoot, 'node_modules', '.package-lock.json'), '{broken');
    expect(compareInstalledLock(snapshotRoot, workspaceRoot)).toMatchObject({ matches: false });
  });
});
