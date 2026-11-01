import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_HEALTH_ENABLE_MARKER_PATH,
  LEGACY_IDLE_HEALTH_COMMAND,
  LEGACY_IDLE_MARKER_PATH,
  recoverLegacyContainerUpdate,
  updateLegacyContainerInPlace,
  type LegacyContainerHealthCheck,
  type LegacyContainerUpdateCallbacks,
  type LegacyContainerUpdateInspection,
  type LegacyContainerUpdateJournal,
  type LegacyContainerUpdateJournalStore,
} from '../src/executor/legacy-container-update.js';

const name = 'legacy-executor';
const id = 'container-original-id';
const version = '1.2.3';
const bundle = new Uint8Array([1, 2, 3, 4]);
const none: LegacyContainerHealthCheck = { kind: 'none' };
const ownedHealth: LegacyContainerHealthCheck = {
  kind: 'idle-marker',
  command: LEGACY_IDLE_HEALTH_COMMAND,
  intervalMs: 2_000,
  startPeriodMs: 30_000,
  retries: 1,
  onFailure: 'stop',
};

function initialInspection(overrides: Partial<LegacyContainerUpdateInspection> = {}): LegacyContainerUpdateInspection {
  return {
    id,
    name,
    running: true,
    paused: false,
    status: 'running',
    healthCheck: none,
    ...overrides,
  };
}

function fixture({
  pending = [],
  running = [],
  ledger = true,
  healthCheck = none,
  originallyRunning = true,
  installFailure = false,
  verifyFailure = false,
  pauseResponseFailure = false,
}: {
  pending?: string[];
  running?: string[];
  ledger?: boolean;
  healthCheck?: LegacyContainerHealthCheck;
  originallyRunning?: boolean;
  installFailure?: boolean;
  verifyFailure?: boolean;
  pauseResponseFailure?: boolean;
} = {}) {
  const operations: string[] = [];
  const state = initialInspection({ running: originallyRunning, healthCheck });
  state.status = originallyRunning ? 'running' : 'exited';
  let saved: LegacyContainerUpdateJournal | null = null;
  let installed = false;
  let stoppingReads = 0;
  const journal: LegacyContainerUpdateJournalStore = {
    async read() {
      return saved ? structuredClone(saved) : null;
    },
    async write(_containerName, value) {
      saved = structuredClone(value);
      operations.push(`journal:${value.stage}`);
    },
    async clear() {
      operations.push('journal:clear');
      saved = null;
    },
  };
  const callbacks: LegacyContainerUpdateCallbacks = {
    async acquireUpdateLock(containerName) {
      operations.push(`lock:${containerName}`);
      return async () => {
        operations.push('unlock');
      };
    },
    async runPodman(args) {
      operations.push(`podman:${args.join(' ')}`);
      switch (args[0]) {
        case 'pause':
          state.running = false;
          state.paused = true;
          state.status = 'paused';
          if (pauseResponseFailure) throw new Error('pause response lost');
          break;
        case 'unpause':
          state.running = true;
          state.paused = false;
          state.status = 'running';
          break;
        case 'kill':
          state.running = false;
          state.paused = false;
          state.status = 'stopping';
          stoppingReads = 1;
          break;
        case 'start':
          state.running = true;
          state.paused = false;
          state.status = 'running';
          break;
        case 'stop':
          state.running = false;
          state.paused = false;
          state.status = 'stopping';
          stoppingReads = 1;
          break;
        case 'update':
          if (args.includes('--no-healthcheck')) {
            state.healthCheck = none;
            break;
          }
          state.healthCheck = ownedHealth;
          break;
      }
    },
    async inspect(containerName) {
      operations.push(`inspect:${containerName}`);
      if (state.status === 'stopping' && stoppingReads > 0) {
        stoppingReads -= 1;
      } else if (state.status === 'stopping') {
        state.status = 'exited';
      }
      return structuredClone(state);
    },
    async readFrozenLedger(containerId) {
      operations.push(`ledger:${containerId}`);
      return ledger ? { pending: [...pending], running: [...running] } : null;
    },
    async installBundleAndMarkers(containerId, input) {
      operations.push(`install:${containerId}:${input.targetVersion}`);
      expect(input.enableMarkerPath).toBe(LEGACY_HEALTH_ENABLE_MARKER_PATH);
      expect(input.removeIdleMarkerPath).toBe(LEGACY_IDLE_MARKER_PATH);
      expect(input.bundle).toEqual(bundle);
      installed = true;
      if (installFailure) throw new Error('installation failed');
    },
    async restoreInstalledFiles(containerId, transactionId) {
      operations.push(`restore-files:${containerId}:${transactionId}`);
      installed = false;
    },
    async verifyUpdated(containerId, expectedVersion) {
      operations.push(`verify-updated:${containerId}:${expectedVersion}`);
      return verifyFailure
        ? { verified: false, reason: 'version mismatch' }
        : { verified: true, version: expectedVersion };
    },
    async verifyRestored(containerId) {
      operations.push(`verify-restored:${containerId}`);
      return !installed;
    },
  };
  return {
    callbacks,
    journal,
    operations,
    state,
    isInstalled: () => installed,
    getSaved: () => saved,
    options: {
      containerName: name,
      targetVersion: version,
      bundle,
      journal,
      callbacks,
      transactionId: () => 'legacy-update-transaction',
      now: () => new Date('2026-11-01T00:00:00.000Z'),
    },
  };
}

describe('safe in-place update for a legacy Container Executor', () => {
  it('writes a durable journal before pause and updates the original Container object in place', async () => {
    const state = fixture();
    const result = await updateLegacyContainerInPlace(state.options);
    expect(result.stage).toBe('complete');
    expect(state.state).toMatchObject({ id, running: true, paused: false, healthCheck: ownedHealth });
    expect(state.operations.indexOf('journal:pausing')).toBeLessThan(state.operations.indexOf(`podman:pause ${id}`));
    expect(state.operations.indexOf(`ledger:${id}`)).toBeLessThan(
      state.operations.indexOf(`podman:kill -s KILL ${id}`),
    );
    expect(state.operations.indexOf('journal:ledger_checked')).toBeLessThan(
      state.operations.indexOf(`podman:kill -s KILL ${id}`),
    );
    expect(state.operations).toContain(`install:${id}:${version}`);
    expect(state.operations).toContain(
      `podman:update --health-cmd=${LEGACY_IDLE_HEALTH_COMMAND} --health-interval=2s --health-start-period=30s --health-retries=1 --health-on-failure=stop ${id}`,
    );
    expect(state.operations.some((operation) => operation.startsWith('podman:rm'))).toBe(false);
    expect(state.operations.some((operation) => operation.startsWith('podman:create'))).toBe(false);
    expect(state.getSaved()).toBeNull();
  });

  it('waits for Podman stopping to become exited before starting the agent', async () => {
    const state = fixture();
    await updateLegacyContainerInPlace(state.options);
    const killAt = state.operations.indexOf(`podman:kill -s KILL ${id}`);
    const startAt = state.operations.indexOf(`podman:start ${id}`);
    const inspectionsBetween = state.operations
      .slice(killAt + 1, startAt)
      .filter((operation) => operation === `inspect:${name}`);
    expect(killAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(killAt);
    expect(inspectionsBetween.length).toBeGreaterThanOrEqual(2);
  });

  it('fails closed on unrelated or unknown healthchecks before pausing', async () => {
    for (const healthCheck of [
      { kind: 'other' as const },
      {
        kind: 'idle-marker' as const,
        command: 'test true',
        intervalMs: 2_000,
        startPeriodMs: 30_000,
        retries: 1,
        onFailure: 'stop',
      },
    ]) {
      const state = fixture({ healthCheck });
      await expect(updateLegacyContainerInPlace(state.options)).rejects.toThrow(/healthcheck/);
      expect(state.operations).not.toContain(`podman:pause ${id}`);
      expect(state.getSaved()).toBeNull();
    }
  });

  it('unpauses without killing when frozen ledger inspection is unknown or has active work', async () => {
    for (const state of [
      fixture({ ledger: false }),
      fixture({ pending: ['pending-tool'] }),
      fixture({ running: ['running-tool'] }),
    ]) {
      await expect(updateLegacyContainerInPlace(state.options)).rejects.toThrow(/ledger|pending or running work/);
      expect(state.operations).toContain(`podman:unpause ${id}`);
      expect(state.operations.some((operation) => operation === `podman:kill -s KILL ${id}`)).toBe(false);
      expect(state.state).toMatchObject({ running: true, paused: false });
    }
  });

  it('recovers a durably confirmed pause by unpausing the same original object', async () => {
    const state = fixture();
    state.state.running = false;
    state.state.paused = true;
    state.state.status = 'paused';
    const journalValue: LegacyContainerUpdateJournal = {
      schemaVersion: 1,
      transactionId: 'crashed-update',
      containerName: name,
      containerId: id,
      originallyRunning: true,
      originalHealthCheck: none,
      targetVersion: version,
      stage: 'paused',
      updatedAt: new Date(0).toISOString(),
    };
    await state.journal.write(name, journalValue);
    expect(await recoverLegacyContainerUpdate(name, state.journal, state.callbacks)).toBe('rolled_back');
    expect(state.operations).toContain(`podman:unpause ${id}`);
    expect(state.state).toMatchObject({ id, running: true, paused: false });
    expect(state.getSaved()).toBeNull();
  });

  it('fails closed if pause may have succeeded but its result was not confirmed', async () => {
    const state = fixture({ pauseResponseFailure: true });
    await expect(updateLegacyContainerInPlace(state.options)).rejects.toThrow(/recovery is incomplete/);
    expect(state.state).toMatchObject({ running: false, paused: true });
    expect(state.operations).not.toContain(`podman:unpause ${id}`);
    expect(state.getSaved()).toMatchObject({ stage: 'restoring', rollbackFromStage: 'pausing' });
  });

  it('allows a competing Runtime start only after the new bundle is fully installed', async () => {
    const state = fixture();
    const runPodman = state.callbacks.runPodman.bind(state.callbacks);
    let raceInjected = false;
    vi.spyOn(state.callbacks, 'runPodman').mockImplementation(async (args) => {
      await runPodman(args);
      if (args[0] === 'kill' && !raceInjected) {
        raceInjected = true;
        expect(state.isInstalled()).toBe(true);
        // Simulate another Runtime winning the start race after PID1 was killed.
        await runPodman(['start', id]);
        expect(state.isInstalled()).toBe(true);
        // The competing start exits while this updater waits for a terminal state.
        await runPodman(['kill', '-s', 'KILL', id]);
      }
    });
    await expect(updateLegacyContainerInPlace(state.options)).resolves.toMatchObject({ stage: 'complete' });
    expect(state.operations.indexOf(`install:${id}:${version}`)).toBeLessThan(
      state.operations.indexOf(`podman:kill -s KILL ${id}`),
    );
    expect(state.state).toMatchObject({ id, running: true, paused: false, healthCheck: ownedHealth });
    expect(state.getSaved()).toBeNull();
  });

  it('restores interrupted installation phases before restarting or unpausing', async () => {
    const interruptedStages = [
      'installing',
      'installed',
      'configuring_health',
      'health_configured',
      'terminating',
      'stopped',
      'starting',
      'verifying',
    ] as const;
    for (const stage of interruptedStages) {
      const state = fixture();
      state.state.running = ['starting', 'verifying'].includes(stage);
      state.state.paused = [
        'installing',
        'installed',
        'configuring_health',
        'health_configured',
        'terminating',
      ].includes(stage);
      state.state.status = state.state.paused ? 'paused' : state.state.running ? 'running' : 'exited';
      state.state.healthCheck = [
        'configuring_health',
        'health_configured',
        'terminating',
        'stopped',
        'starting',
        'verifying',
      ].includes(stage)
        ? ownedHealth
        : none;
      await state.journal.write(name, {
        schemaVersion: 1,
        transactionId: `crashed-${stage}`,
        containerName: name,
        containerId: id,
        originallyRunning: true,
        originalHealthCheck: none,
        targetVersion: version,
        stage,
        updatedAt: new Date(0).toISOString(),
      });
      expect(await recoverLegacyContainerUpdate(name, state.journal, state.callbacks)).toBe('rolled_back');
      const restoreAt = state.operations.indexOf(`restore-files:${id}:crashed-${stage}`);
      const restartAt = state.operations.indexOf(`podman:start ${id}`);
      const unpauseAt = state.operations.indexOf(`podman:unpause ${id}`);
      expect(restoreAt, stage).toBeGreaterThan(-1);
      if (restartAt > -1) expect(restoreAt).toBeLessThan(restartAt);
      if (unpauseAt > -1) expect(restoreAt).toBeLessThan(unpauseAt);
      expect(state.state).toMatchObject({ id, running: true, paused: false, healthCheck: none });
      expect(state.getSaved()).toBeNull();
    }
  });

  it('recovers a crash during health setup and removes the owned check when none existed before', async () => {
    const state = fixture();
    state.state.running = false;
    state.state.status = 'exited';
    state.state.healthCheck = ownedHealth;
    await state.journal.write(name, {
      schemaVersion: 1,
      transactionId: 'crashed-health-update',
      containerName: name,
      containerId: id,
      originallyRunning: true,
      originalHealthCheck: none,
      targetVersion: version,
      stage: 'configuring_health',
      updatedAt: new Date(0).toISOString(),
    });
    expect(await recoverLegacyContainerUpdate(name, state.journal, state.callbacks)).toBe('rolled_back');
    expect(state.operations).toContain(`podman:update --no-healthcheck ${id}`);
    expect(state.operations).toContain(`podman:start ${id}`);
    expect(state.state).toMatchObject({ id, running: true, paused: false, healthCheck: none });
    expect(state.getSaved()).toBeNull();
  });

  it('restores files and restarts the original Container after install or verification failure', async () => {
    for (const state of [fixture({ installFailure: true }), fixture({ verifyFailure: true })]) {
      await expect(updateLegacyContainerInPlace(state.options)).rejects.toThrow(/failed|mismatch/);
      expect(state.operations.some((operation) => operation.startsWith(`restore-files:${id}:`))).toBe(true);
      if (state.operations.includes(`podman:kill -s KILL ${id}`)) {
        expect(state.operations).toContain(`podman:start ${id}`);
      }
      if (
        state.operations.includes(
          `podman:update --health-cmd=${LEGACY_IDLE_HEALTH_COMMAND} --health-interval=2s --health-start-period=30s --health-retries=1 --health-on-failure=stop ${id}`,
        )
      ) {
        expect(state.operations).toContain(`podman:update --no-healthcheck ${id}`);
        expect(state.state.healthCheck).toEqual(none);
      }
      expect(state.operations).toContain(`verify-restored:${id}`);
      expect(state.state).toMatchObject({ id, running: true, paused: false });
      expect(state.getSaved()).toBeNull();
    }
  });

  it('returns an originally stopped Container to stopped state after verification', async () => {
    const state = fixture({ originallyRunning: false });
    const result = await updateLegacyContainerInPlace(state.options);
    expect(result.stage).toBe('complete');
    expect(state.state).toMatchObject({ id, running: false, paused: false });
    expect(state.operations).not.toContain(`podman:pause ${id}`);
    expect(state.operations).not.toContain(`podman:kill -s KILL ${id}`);
    expect(state.operations).toContain(`podman:stop --time 10 ${id}`);
  });

  it('never hides an uncompleted rollback journal when restoring files fails', async () => {
    const state = fixture({ installFailure: true });
    vi.spyOn(state.callbacks, 'restoreInstalledFiles').mockRejectedValue(new Error('backup unavailable'));
    await expect(updateLegacyContainerInPlace(state.options)).rejects.toThrow(/recovery is incomplete/);
    expect(state.getSaved()?.stage).toBe('restoring');
    expect(state.state).toMatchObject({ running: false, paused: true });
  });
});
