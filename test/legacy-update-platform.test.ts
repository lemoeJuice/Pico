import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import {
  createLegacyUpdatePlatform,
  hasLegacyUpdateJournal,
  type LegacyPlatformPodmanRunner,
  type LegacyStartAgentAndVerifyInput,
} from '../src/executor/legacy-update-platform.js';

const token = 'legacy-update-platform-token-that-is-never-logged';
const installationId = 'a'.repeat(32);
const executorKey = 'c'.repeat(64);
const containerName = `pico-executor-${installationId.slice(0, 16)}-${executorKey.slice(0, 32)}`;
const containerId = 'abcdef1234567890';

async function fixture(executorKind: 'container' | 'workspace' = 'container') {
  const directory = await mkdtemp(join(tmpdir(), 'pico-legacy-platform-'));
  const runtimeDb = new PicoStore(join(directory, 'runtime.sqlite'));
  runtimeDb.setSetting('executor-container-installation-id', installationId);
  const data = join(directory, 'volume-data');
  const containerRoot = join(directory, 'container-root');
  await mkdir(data);
  await mkdir(join(containerRoot, 'opt', 'pico'), { recursive: true });
  await writeFile(join(containerRoot, 'opt', 'pico', 'executor-agent.mjs'), 'original-agent');
  await writeFile(join(containerRoot, 'opt', 'pico', 'executor-agent.mjs.version'), '1.0.0\n');
  const ledger = new DatabaseSync(join(data, 'executor.sqlite'));
  ledger.exec('CREATE TABLE remote_executions (execution_id TEXT PRIMARY KEY, status TEXT NOT NULL);');
  ledger.prepare('INSERT INTO remote_executions (execution_id, status) VALUES (?, ?)').run('pending-1', 'pending');
  ledger.prepare('INSERT INTO remote_executions (execution_id, status) VALUES (?, ?)').run('running-1', 'running');
  ledger.close();
  const executorLabels: Record<string, string> = {
    'io.pico.installation-id': installationId,
    'io.pico.executor': executorKind,
    [executorKind === 'workspace' ? 'io.pico.workspace-key' : 'io.pico.executor-key']: executorKey,
  };
  const inspection = {
    Id: containerId,
    Name: `/${containerName}`,
    State: { Running: true, Paused: false, Status: 'running' },
    Config: {
      Labels: executorLabels,
      Env: [`PICO_EXECUTOR_TOKEN=${token}`],
      Healthcheck: null,
      HealthcheckOnFailureAction: 'none',
    },
    Mounts: [
      {
        Type: 'volume',
        Name: `pico-executor-data-${installationId.slice(0, 16)}-${executorKey.slice(0, 32)}`,
        Source: data,
        Destination: '/opt/pico/data',
        RW: true,
      },
    ],
  };
  const runPodman = vi.fn<LegacyPlatformPodmanRunner>(async (args) => {
    if (args[0] === 'inspect') return { stdout: JSON.stringify([inspection]), stderr: '' };
    if (args[0] === 'cp') {
      const source = args[1]!;
      const destination = args[2]!;
      const fromContainer = source.startsWith(`${containerId}:`);
      const fromPath = fromContainer ? join(containerRoot, source.slice(containerId.length + 1)) : source;
      const toPath = fromContainer ? destination : join(containerRoot, destination.slice(containerId.length + 1));
      await mkdir(join(toPath, '..'), { recursive: true });
      await copyFile(fromPath, toPath);
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected podman operation ${args[0]}`);
  });
  const verifyCalls: LegacyStartAgentAndVerifyInput[] = [];
  const platform = createLegacyUpdatePlatform({
    containerName,
    store: runtimeDb,
    runPodman,
    bundle: new Uint8Array([1, 2, 3]),
    version: '2.0.0',
    accessToken: token,
    workspaceRoot: '/workspace',
    startAgentAndVerify: async (verifyInput) => {
      verifyCalls.push(verifyInput);
      return { verified: true, version: verifyInput.version };
    },
  });
  return { directory, store: runtimeDb, data, containerRoot, inspection, runPodman, platform, verifyCalls };
}

describe('legacy Container Podman update platform', () => {
  const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = [];
  afterEach(async () => {
    for (const item of fixtures.splice(0)) {
      item.store.close();
      await rm(item.directory, { recursive: true, force: true });
    }
  });

  it('validates the owned immutable Container, healthcheck, and frozen ledger without logging tokens', async () => {
    const item = await fixture();
    fixtures.push(item);
    const inspected = await item.platform.callbacks.inspect(containerName);
    expect(inspected).toEqual({
      id: containerId,
      name: containerName,
      running: true,
      paused: false,
      status: 'running',
      healthCheck: { kind: 'none' },
    });
    item.inspection.State.Paused = true;
    item.inspection.State.Running = false;
    item.inspection.State.Status = 'paused';
    expect(await item.platform.callbacks.readFrozenLedger(containerId)).toEqual({
      pending: ['pending-1'],
      running: ['running-1'],
    });
    item.inspection.State.Paused = false;
    item.inspection.State.Running = true;
    item.inspection.State.Status = 'running';
    expect(JSON.stringify(item.runPodman.mock.calls)).not.toContain(token);

    (item.inspection.Config as { Healthcheck: unknown }).Healthcheck = {
      Test: ['CMD-SHELL', 'curl attacker.invalid'],
    };
    expect((await item.platform.callbacks.inspect(containerName))?.healthCheck.kind).toBe('other');
    (item.inspection.Config as { Healthcheck: unknown }).Healthcheck = {
      Test: ['CMD-SHELL', 'test ! -e /opt/pico/data/pico-executor-idle'],
      Interval: 2_000_000_000,
      StartPeriod: 30_000_000_000,
      Timeout: 30_000_000_000,
      Retries: 1,
    };
    (item.inspection.Config as { HealthcheckOnFailureAction: unknown }).HealthcheckOnFailureAction = 'stop';
    expect((await item.platform.callbacks.inspect(containerName))?.healthCheck).toMatchObject({
      kind: 'idle-marker',
      intervalMs: 2_000,
      startPeriodMs: 30_000,
      onFailure: 'stop',
    });
    (item.inspection.Config as { Healthcheck: unknown }).Healthcheck = null;
    (item.inspection.Config as { Healthcheck: unknown }).Healthcheck = undefined;
    (item.inspection.Config as { HealthcheckOnFailureAction: unknown }).HealthcheckOnFailureAction = undefined;
    expect((await item.platform.callbacks.inspect(containerName))?.healthCheck.kind).toBe('none');
    item.inspection.Config.Labels['io.pico.installation-id'] = 'b'.repeat(32);
    await expect(item.platform.callbacks.inspect(containerName)).rejects.toThrow(/not owned/);
  });

  it('accepts legacy workspace Containers identified by workspace-key labels', async () => {
    const item = await fixture('workspace');
    fixtures.push(item);
    expect(await item.platform.callbacks.inspect(containerName)).toMatchObject({
      id: containerId,
      name: containerName,
      healthCheck: { kind: 'none' },
    });
    expect(item.inspection.Config.Labels['io.pico.workspace-key']).toBe(executorKey);
    expect(item.inspection.Config.Labels['io.pico.executor-key']).toBeUndefined();
  });

  it('maps stopping state for the orchestrator to wait, but never allows file writes before stopped', async () => {
    const item = await fixture();
    fixtures.push(item);
    item.inspection.State.Running = false;
    item.inspection.State.Status = 'stopping';
    expect(await item.platform.callbacks.inspect(containerName)).toMatchObject({
      running: false,
      paused: false,
      status: 'stopping',
    });
    await expect(
      item.platform.callbacks.installBundleAndMarkers(containerId, {
        transactionId: 'tx-stopping',
        targetVersion: '2.0.0',
        bundle: new Uint8Array([1, 2, 3]),
        enableMarkerPath: '/opt/pico/data/pico-health-supervisor-enabled',
        removeIdleMarkerPath: '/opt/pico/data/pico-executor-idle',
      }),
    ).rejects.toThrow(/paused or stopped/);
    item.inspection.State.Status = 'mystery';
    await expect(item.platform.callbacks.inspect(containerName)).rejects.toThrow(/status inspection/);
  });

  it('backs up and restores agent, version, and marker bytes around a paused install', async () => {
    const item = await fixture();
    fixtures.push(item);
    item.inspection.State.Paused = true;
    item.inspection.State.Running = false;
    item.inspection.State.Status = 'paused';
    await item.platform.callbacks.installBundleAndMarkers(containerId, {
      transactionId: 'tx-backup',
      targetVersion: '2.0.0',
      bundle: new Uint8Array([1, 2, 3]),
      enableMarkerPath: '/opt/pico/data/pico-health-supervisor-enabled',
      removeIdleMarkerPath: '/opt/pico/data/pico-executor-idle',
    });
    const agentPath = join(item.containerRoot, 'opt', 'pico', 'executor-agent.mjs');
    const versionPath = `${agentPath}.version`;
    expect(await readFile(agentPath)).toEqual(Buffer.from([1, 2, 3]));
    expect(await readFile(versionPath, 'utf8')).toBe('2.0.0\n');
    expect(await readFile(join(item.data, 'pico-health-supervisor-enabled'))).toEqual(Buffer.alloc(0));
    expect(item.runPodman.mock.calls.filter(([args]) => args[0] === 'cp').every(([args]) => args.length === 3)).toBe(
      true,
    );

    await item.platform.callbacks.restoreInstalledFiles(containerId, 'tx-backup');
    expect(await readFile(agentPath, 'utf8')).toBe('original-agent');
    expect(await readFile(versionPath, 'utf8')).toBe('1.0.0\n');
    await expect(readFile(join(item.data, 'pico-health-supervisor-enabled'))).rejects.toMatchObject({ code: 'ENOENT' });
    const backupFiles: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else backupFiles.push(path);
      }
    };
    await walk(join(item.directory, 'legacy-container-updates'));
    const backups = backupFiles.filter((path) => /executor-agent\.mjs$/.test(path));
    expect(backups).toHaveLength(1);
    expect((await stat(backups[0]!)).mode & 0o777).toBe(0o600);
  });

  it('treats a missing durable backup manifest as an untouched install and sweeps orphan backups under lock', async () => {
    const item = await fixture();
    fixtures.push(item);
    item.inspection.State.Paused = true;
    item.inspection.State.Running = false;
    item.inspection.State.Status = 'paused';
    const tx = 'tx-crashed-before-manifest';
    const txDirectory = join(
      item.directory,
      'legacy-container-updates',
      'backups',
      createHash('sha256').update(containerName).digest('hex'),
      createHash('sha256').update(tx).digest('hex'),
    );
    await mkdir(txDirectory, { recursive: true });
    await writeFile(join(txDirectory, 'executor-agent.mjs'), 'partial backup');

    await item.platform.callbacks.restoreInstalledFiles(containerId, tx);
    expect(await readFile(join(item.containerRoot, 'opt', 'pico', 'executor-agent.mjs'), 'utf8')).toBe(
      'original-agent',
    );
    expect(item.runPodman.mock.calls.some(([args]) => args[0] === 'cp')).toBe(false);

    const unlock = await item.platform.callbacks.acquireUpdateLock(containerName);
    unlock();
    await expect(readFile(join(txDirectory, 'executor-agent.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes complete transaction backups only through post-journal cleanup', async () => {
    const item = await fixture();
    fixtures.push(item);
    item.inspection.State.Paused = true;
    item.inspection.State.Running = false;
    item.inspection.State.Status = 'paused';
    const tx = 'tx-cleanup';
    await item.platform.callbacks.installBundleAndMarkers(containerId, {
      transactionId: tx,
      targetVersion: '2.0.0',
      bundle: new Uint8Array([1, 2, 3]),
      enableMarkerPath: '/opt/pico/data/pico-health-supervisor-enabled',
      removeIdleMarkerPath: '/opt/pico/data/pico-executor-idle',
    });
    const backupDirectory = join(
      item.directory,
      'legacy-container-updates',
      'backups',
      createHash('sha256').update(containerName).digest('hex'),
      createHash('sha256').update(tx).digest('hex'),
    );
    expect(await stat(backupDirectory)).toBeTruthy();
    await item.platform.callbacks.cleanupUpdateArtifacts!(containerId, tx);
    await expect(stat(backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes a durable journal and serializes concurrent processes with a crash-released SQLite lock', async () => {
    const item = await fixture();
    fixtures.push(item);
    const journal = {
      schemaVersion: 1 as const,
      transactionId: 'tx-safe',
      containerName,
      containerId,
      originallyRunning: true,
      originalHealthCheck: { kind: 'none' as const },
      targetVersion: '2.0.0',
      stage: 'prepared' as const,
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    await item.platform.journal.write(containerName, journal);
    expect(await item.platform.journal.read(containerName)).toEqual(journal);
    expect(hasLegacyUpdateJournal(item.store, containerName)).toBe(true);

    const unlock = await item.platform.callbacks.acquireUpdateLock(containerName);
    await expect(item.platform.callbacks.acquireUpdateLock(containerName)).rejects.toThrow(/Another process/);
    unlock();
    const next = await item.platform.callbacks.acquireUpdateLock(containerName);
    next();
    await item.platform.journal.clear(containerName);
    expect(await item.platform.journal.read(containerName)).toBeNull();
    expect(hasLegacyUpdateJournal(item.store, containerName)).toBe(false);
  });

  it('checks journal presence without persistent storage and rejects non-file journal entries', async () => {
    const item = await fixture();
    fixtures.push(item);
    const memoryStore = new PicoStore(':memory:');
    try {
      expect(hasLegacyUpdateJournal(memoryStore, containerName)).toBe(false);
    } finally {
      memoryStore.close();
    }
    const journalPath = join(
      item.directory,
      'legacy-container-updates',
      `${createHash('sha256').update(containerName).digest('hex')}.json`,
    );
    await mkdir(journalPath, { recursive: true });
    expect(() => hasLegacyUpdateJournal(item.store, containerName)).toThrow(/not a regular file/);
  });

  it('requires lease capability for the installed version but not for rollback verification', async () => {
    const item = await fixture();
    fixtures.push(item);
    item.inspection.State.Paused = true;
    item.inspection.State.Running = false;
    item.inspection.State.Status = 'paused';
    const transactionId = 'tx-require-lease';
    await item.platform.callbacks.installBundleAndMarkers(containerId, {
      transactionId,
      targetVersion: '2.0.0',
      bundle: new Uint8Array([1, 2, 3]),
      enableMarkerPath: '/opt/pico/data/pico-health-supervisor-enabled',
      removeIdleMarkerPath: '/opt/pico/data/pico-executor-idle',
    });
    await item.platform.callbacks.verifyUpdated(containerId, '2.0.0');
    expect(item.verifyCalls.at(-1)).toMatchObject({ version: '2.0.0', requireLease: true });
    await item.platform.journal.write(containerName, {
      schemaVersion: 1,
      transactionId,
      containerName,
      containerId,
      originallyRunning: true,
      originalHealthCheck: { kind: 'none' },
      targetVersion: '2.0.0',
      stage: 'restoring',
      rollbackFromStage: 'installing',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(await item.platform.callbacks.verifyRestored(containerId)).toBe(true);
    expect(item.verifyCalls.at(-1)).toMatchObject({ version: '1.0.0', requireLease: false });
  });
});
