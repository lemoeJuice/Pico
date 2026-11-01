import { randomUUID } from 'node:crypto';

export const LEGACY_IDLE_MARKER_PATH = '/opt/pico/data/pico-executor-idle';
export const LEGACY_HEALTH_ENABLE_MARKER_PATH = '/opt/pico/data/pico-health-supervisor-enabled';
export const LEGACY_IDLE_HEALTH_COMMAND = `test ! -e ${LEGACY_IDLE_MARKER_PATH}`;

export interface LegacyContainerHealthCheck {
  kind: 'none' | 'idle-marker' | 'other';
  command?: string;
  intervalMs?: number;
  startPeriodMs?: number;
  retries?: number;
  onFailure?: string;
}

export interface LegacyContainerUpdateInspection {
  id: string;
  name: string;
  running: boolean;
  paused: boolean;
  /** Exact Podman `.State.Status`, used to distinguish stopped from stopping. */
  status: string;
  healthCheck: LegacyContainerHealthCheck;
}

export interface FrozenContainerLedger {
  pending: string[];
  running: string[];
}

export type LegacyContainerUpdateStage =
  | 'prepared'
  | 'pausing'
  | 'paused'
  | 'ledger_checked'
  | 'terminating'
  | 'stopped'
  | 'installing'
  | 'installed'
  | 'configuring_health'
  | 'health_configured'
  | 'starting'
  | 'verifying'
  | 'restoring'
  | 'complete'
  | 'rolled_back';

export interface LegacyContainerUpdateJournal {
  schemaVersion: 1;
  transactionId: string;
  containerName: string;
  containerId: string;
  originallyRunning: boolean;
  originalHealthCheck: LegacyContainerHealthCheck;
  targetVersion: string;
  stage: LegacyContainerUpdateStage;
  rollbackFromStage?: LegacyContainerUpdateStage;
  updatedAt: string;
}

export interface LegacyContainerUpdateJournalStore {
  /** Must durably replace the record before resolving. */
  read(containerName: string): Promise<LegacyContainerUpdateJournal | null>;
  /** Must durably replace the record before resolving. */
  write(containerName: string, journal: LegacyContainerUpdateJournal): Promise<void>;
  /** Must durably remove the record before resolving. */
  clear(containerName: string): Promise<void>;
}

export interface LegacyContainerUpdateCallbacks {
  /** Cross-process fence preventing Runtime work and competing updates. */
  acquireUpdateLock(containerName: string): Promise<() => Promise<void> | void>;
  /** Runs one Podman command without shell interpolation and must redact credentials from diagnostics. */
  runPodman(args: string[]): Promise<void>;
  inspect(containerName: string): Promise<LegacyContainerUpdateInspection | null>;
  /** Only valid for a paused or stopped container; null means unreadable or otherwise unknown. */
  readFrozenLedger(containerId: string): Promise<FrozenContainerLedger | null>;
  /**
   * Atomically stage and install the new bundle plus enable marker, remove any stale idle marker,
   * and durably retain a prior bundle/marker backup under transactionId for restoreInstalledFiles.
   * Do not write credentials into the image, markers, journal, or logs.
   */
  installBundleAndMarkers(
    containerId: string,
    input: {
      transactionId: string;
      targetVersion: string;
      bundle: Uint8Array;
      enableMarkerPath: string;
      removeIdleMarkerPath: string;
    },
  ): Promise<void>;
  /**
   * Idempotently restores the prior bundle/enable marker and removes the idle marker.
   * If installation never created a durable backup, this must be a no-op.
   */
  restoreInstalledFiles(containerId: string, transactionId: string): Promise<void>;
  /** Removes transaction backups after the durable journal has been cleared. */
  cleanupUpdateArtifacts?(containerId: string, transactionId: string): Promise<void>;
  /** Verifies protocol, exact version, and health-supervisor capability from the live agent. */
  verifyUpdated(
    containerId: string,
    targetVersion: string,
  ): Promise<{ verified: boolean; version?: string; reason?: string }>;
  /** Verifies that the restored original agent is usable. */
  verifyRestored(containerId: string): Promise<boolean>;
}

export interface LegacyContainerUpdateOptions {
  containerName: string;
  targetVersion: string;
  bundle: Uint8Array;
  journal: LegacyContainerUpdateJournalStore;
  callbacks: LegacyContainerUpdateCallbacks;
  now?: () => Date;
  transactionId?: () => string;
}

export class UnsafeLegacyContainerUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeLegacyContainerUpdateError';
  }
}

const idleHealthCheck: LegacyContainerHealthCheck = {
  kind: 'idle-marker',
  command: LEGACY_IDLE_HEALTH_COMMAND,
  intervalMs: 2_000,
  startPeriodMs: 30_000,
  retries: 1,
  onFailure: 'stop',
};

export const LEGACY_CONTAINER_STOP_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 100;
const stoppedStatuses = new Set(['created', 'stopped', 'exited']);

const stages: LegacyContainerUpdateStage[] = [
  'prepared',
  'pausing',
  'paused',
  'ledger_checked',
  'terminating',
  'stopped',
  'installing',
  'installed',
  'configuring_health',
  'health_configured',
  'terminating',
  'stopped',
  'starting',
  'verifying',
  'restoring',
  'complete',
  'rolled_back',
];

function copyHealthCheck(value: LegacyContainerHealthCheck): LegacyContainerHealthCheck {
  if (value.kind === 'none') return { kind: 'none' };
  if (value.kind === 'idle-marker') {
    return {
      kind: 'idle-marker',
      command: value.command!,
      intervalMs: value.intervalMs!,
      startPeriodMs: value.startPeriodMs!,
      retries: value.retries!,
      onFailure: value.onFailure!,
    };
  }
  return { kind: 'other' };
}

function isOwnedIdleHealthCheck(value: LegacyContainerHealthCheck): boolean {
  return (
    value.kind === 'idle-marker' &&
    value.command === idleHealthCheck.command &&
    value.intervalMs === idleHealthCheck.intervalMs &&
    value.startPeriodMs === idleHealthCheck.startPeriodMs &&
    value.retries === idleHealthCheck.retries &&
    value.onFailure === idleHealthCheck.onFailure
  );
}

function hasValidHealthShape(value: unknown): value is LegacyContainerHealthCheck {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  const health = value as LegacyContainerHealthCheck;
  const keys = Object.keys(value);
  if (health.kind === 'none' || health.kind === 'other') return keys.length === 1 && keys[0] === 'kind';
  return (
    health.kind === 'idle-marker' &&
    keys.length === 6 &&
    keys.every((key) => ['kind', 'command', 'intervalMs', 'startPeriodMs', 'retries', 'onFailure'].includes(key)) &&
    typeof health.command === 'string' &&
    typeof health.intervalMs === 'number' &&
    typeof health.startPeriodMs === 'number' &&
    typeof health.retries === 'number' &&
    typeof health.onFailure === 'string'
  );
}

function validateInspection(
  inspection: LegacyContainerUpdateInspection | null,
  containerName: string,
  expectedId?: string,
): LegacyContainerUpdateInspection {
  if (!inspection) throw new UnsafeLegacyContainerUpdateError('Container was not found; refusing in-place Update.');
  if (
    typeof inspection.id !== 'string' ||
    !inspection.id.trim() ||
    inspection.name !== containerName ||
    typeof inspection.running !== 'boolean' ||
    typeof inspection.paused !== 'boolean' ||
    typeof inspection.status !== 'string' ||
    !inspection.status.trim() ||
    !hasValidHealthShape(inspection.healthCheck)
  ) {
    throw new UnsafeLegacyContainerUpdateError('Container inspection is incomplete or invalid; refusing Update.');
  }
  if (expectedId && inspection.id !== expectedId) {
    throw new UnsafeLegacyContainerUpdateError('Container identity changed during Update; refusing further actions.');
  }
  if (inspection.paused && inspection.running) {
    throw new UnsafeLegacyContainerUpdateError('Container reported an unknown running/paused state combination.');
  }
  if (
    (inspection.status === 'paused' && (inspection.running || !inspection.paused)) ||
    (inspection.status === 'running' && (!inspection.running || inspection.paused)) ||
    (stoppedStatuses.has(inspection.status) && (inspection.running || inspection.paused)) ||
    !['running', 'paused', 'stopping', ...stoppedStatuses].includes(inspection.status)
  ) {
    throw new UnsafeLegacyContainerUpdateError('Container state status conflicts with its running/paused fields.');
  }
  return inspection;
}

function validateJournal(journal: LegacyContainerUpdateJournal, containerName: string): void {
  if (
    journal.schemaVersion !== 1 ||
    !journal.transactionId ||
    journal.containerName !== containerName ||
    !journal.containerId ||
    typeof journal.originallyRunning !== 'boolean' ||
    !hasValidHealthShape(journal.originalHealthCheck) ||
    !journal.targetVersion ||
    !stages.includes(journal.stage) ||
    (journal.stage === 'restoring' && !journal.rollbackFromStage) ||
    (journal.rollbackFromStage !== undefined && !stages.includes(journal.rollbackFromStage))
  ) {
    throw new UnsafeLegacyContainerUpdateError('Legacy Container Update journal is invalid; refusing recovery.');
  }
}

function updateJournal(
  journal: LegacyContainerUpdateJournal,
  stage: LegacyContainerUpdateStage,
  now: () => Date,
  rollbackFromStage?: LegacyContainerUpdateStage,
): LegacyContainerUpdateJournal {
  return {
    ...journal,
    stage,
    ...(rollbackFromStage ? { rollbackFromStage } : {}),
    updatedAt: now().toISOString(),
  };
}

async function inspectSameContainer(
  containerName: string,
  containerId: string,
  callbacks: LegacyContainerUpdateCallbacks,
): Promise<LegacyContainerUpdateInspection> {
  return validateInspection(await callbacks.inspect(containerName), containerName, containerId);
}

async function waitForStoppedContainer(
  containerName: string,
  containerId: string,
  callbacks: LegacyContainerUpdateCallbacks,
  timeoutMs = LEGACY_CONTAINER_STOP_TIMEOUT_MS,
): Promise<LegacyContainerUpdateInspection> {
  const deadline = Date.now() + timeoutMs;
  let inspected = await inspectSameContainer(containerName, containerId, callbacks);
  while (!stoppedStatuses.has(inspected.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`Container did not reach a stopped state within ${timeoutMs}ms (status: ${inspected.status}).`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
    inspected = await inspectSameContainer(containerName, containerId, callbacks);
  }
  return inspected;
}

async function unpauseOriginalContainer(
  containerName: string,
  containerId: string,
  callbacks: LegacyContainerUpdateCallbacks,
): Promise<LegacyContainerUpdateInspection> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await callbacks.runPodman(['unpause', containerId]);
    } catch (error) {
      lastError = error;
    }
    const inspected = await inspectSameContainer(containerName, containerId, callbacks);
    if (!inspected.paused && inspected.running) return inspected;
  }
  throw new Error('Original Container could not be safely unpaused after two attempts.', { cause: lastError });
}

async function assertFrozen(
  containerName: string,
  containerId: string,
  originallyRunning: boolean,
  callbacks: LegacyContainerUpdateCallbacks,
): Promise<LegacyContainerUpdateInspection> {
  const inspected = await inspectSameContainer(containerName, containerId, callbacks);
  if (originallyRunning ? !inspected.paused || inspected.running : inspected.running || inspected.paused) {
    throw new UnsafeLegacyContainerUpdateError('Container is no longer in the expected frozen state; refusing Update.');
  }
  return inspected;
}

async function persist(
  journal: LegacyContainerUpdateJournal,
  stage: LegacyContainerUpdateStage,
  journalStore: LegacyContainerUpdateJournalStore,
  now: () => Date,
  rollbackFromStage?: LegacyContainerUpdateStage,
): Promise<LegacyContainerUpdateJournal> {
  const updated = updateJournal(journal, stage, now, rollbackFromStage);
  await journalStore.write(journal.containerName, updated);
  return updated;
}

function filesMayHaveChanged(stage: LegacyContainerUpdateStage): boolean {
  return [
    'installing',
    'installed',
    'configuring_health',
    'health_configured',
    'terminating',
    'stopped',
    'starting',
    'verifying',
  ].includes(stage);
}

function healthMayHaveChanged(stage: LegacyContainerUpdateStage): boolean {
  return ['configuring_health', 'health_configured', 'terminating', 'stopped', 'starting', 'verifying'].includes(stage);
}

async function rollbackUpdate(input: {
  journal: LegacyContainerUpdateJournal;
  journalStore: LegacyContainerUpdateJournalStore;
  callbacks: LegacyContainerUpdateCallbacks;
  now: () => Date;
}): Promise<LegacyContainerUpdateJournal> {
  const { journal, journalStore, callbacks, now } = input;
  const rollbackFrom = journal.stage === 'restoring' ? journal.rollbackFromStage : journal.stage;
  if (!rollbackFrom) throw new UnsafeLegacyContainerUpdateError('Rollback stage is missing from the Update journal.');
  let current = await persist(journal, 'restoring', journalStore, now, rollbackFrom);
  let inspected = await inspectSameContainer(current.containerName, current.containerId, callbacks);

  if (filesMayHaveChanged(rollbackFrom)) {
    // Files are restored while the original process remains paused. If it was already
    // restarted, stop it before changing the bundle; if stopped, keep it stopped.
    if (inspected.running) {
      await callbacks.runPodman(['kill', '-s', 'KILL', current.containerId]);
    }
    if (!inspected.paused) {
      inspected = await waitForStoppedContainer(current.containerName, current.containerId, callbacks);
    }
    await callbacks.restoreInstalledFiles(current.containerId, current.transactionId);
  }

  if (healthMayHaveChanged(rollbackFrom)) {
    if (current.originalHealthCheck.kind === 'none') {
      await callbacks.runPodman(['update', '--no-healthcheck', current.containerId]);
    } else {
      await callbacks.runPodman([
        'update',
        `--health-cmd=${current.originalHealthCheck.command}`,
        `--health-interval=${current.originalHealthCheck.intervalMs}ms`,
        `--health-start-period=${current.originalHealthCheck.startPeriodMs}ms`,
        `--health-retries=${current.originalHealthCheck.retries}`,
        `--health-on-failure=${current.originalHealthCheck.onFailure}`,
        current.containerId,
      ]);
    }
  }

  inspected = await inspectSameContainer(current.containerName, current.containerId, callbacks);
  // A crash between issuing pause and durably confirming it is ambiguous: an
  // external actor may have paused the container. Never unpause that state blindly.
  if (rollbackFrom === 'pausing' && inspected.paused) {
    throw new UnsafeLegacyContainerUpdateError(
      'Pause outcome is ambiguous; Container remains paused and the recovery journal is retained for safe manual resolution.',
    );
  }
  if (inspected.paused) {
    if (!current.originallyRunning) {
      throw new UnsafeLegacyContainerUpdateError(
        'A previously stopped Container is paused; refusing automatic recovery.',
      );
    }
    inspected = await unpauseOriginalContainer(current.containerName, current.containerId, callbacks);
  } else if (current.originallyRunning && stoppedStatuses.has(inspected.status)) {
    await callbacks.runPodman(['start', current.containerId]);
    inspected = await inspectSameContainer(current.containerName, current.containerId, callbacks);
    if (!inspected.running || inspected.paused) throw new Error('Original Container did not restart after rollback.');
  } else if (!current.originallyRunning && inspected.running) {
    await callbacks.runPodman(['stop', '--time', '10', current.containerId]);
    inspected = await inspectSameContainer(current.containerName, current.containerId, callbacks);
    if (inspected.running || inspected.paused)
      throw new Error('Originally stopped Container did not return to stopped state.');
  }

  if (current.originallyRunning) {
    const restored = await callbacks.verifyRestored(current.containerId);
    if (!restored) throw new Error('Original Executor did not pass its post-rollback health check.');
  }
  current = await persist(current, 'rolled_back', journalStore, now, rollbackFrom);
  return current;
}

async function clearJournalAndCleanup(
  containerName: string,
  journal: LegacyContainerUpdateJournal,
  journalStore: LegacyContainerUpdateJournalStore,
  callbacks: LegacyContainerUpdateCallbacks,
): Promise<void> {
  try {
    await journalStore.clear(containerName);
  } catch {
    return;
  }
  await callbacks.cleanupUpdateArtifacts?.(journal.containerId, journal.transactionId).catch(() => undefined);
}

async function recoverUnderLock(
  containerName: string,
  journalStore: LegacyContainerUpdateJournalStore,
  callbacks: LegacyContainerUpdateCallbacks,
  now: () => Date,
): Promise<'none' | 'complete' | 'rolled_back'> {
  const journal = await journalStore.read(containerName);
  if (!journal) return 'none';
  validateJournal(journal, containerName);
  if (journal.stage === 'complete') {
    await journalStore.clear(containerName);
    await callbacks.cleanupUpdateArtifacts?.(journal.containerId, journal.transactionId).catch(() => undefined);
    return 'complete';
  }
  if (journal.stage === 'rolled_back') {
    await journalStore.clear(containerName);
    await callbacks.cleanupUpdateArtifacts?.(journal.containerId, journal.transactionId).catch(() => undefined);
    return 'rolled_back';
  }
  await rollbackUpdate({ journal, journalStore, callbacks, now });
  await journalStore.clear(containerName);
  await callbacks.cleanupUpdateArtifacts?.(journal.containerId, journal.transactionId).catch(() => undefined);
  return 'rolled_back';
}

/** Recover a crash-interrupted legacy in-place Update. Call during startup before admitting work. */
export async function recoverLegacyContainerUpdate(
  containerName: string,
  journalStore: LegacyContainerUpdateJournalStore,
  callbacks: LegacyContainerUpdateCallbacks,
  now: () => Date = () => new Date(),
): Promise<'none' | 'complete' | 'rolled_back'> {
  const unlock = await callbacks.acquireUpdateLock(containerName);
  try {
    return await recoverUnderLock(containerName, journalStore, callbacks, now);
  } finally {
    await unlock();
  }
}

/**
 * Explicitly update an old Container in place. No container action is automatic at Runtime startup.
 * A durable journal is committed before pause; installation and health setup happen while frozen.
 * All Podman operations address the inspected ID.
 */
export async function updateLegacyContainerInPlace(
  options: LegacyContainerUpdateOptions,
): Promise<LegacyContainerUpdateJournal> {
  const { containerName, journal: journalStore, callbacks } = options;
  const now = options.now ?? (() => new Date());
  const transactionId = options.transactionId ?? randomUUID;
  if (!containerName.trim() || !options.targetVersion.trim() || options.bundle.byteLength === 0) {
    throw new UnsafeLegacyContainerUpdateError('Container name, target version, and update bundle are required.');
  }
  const unlock = await callbacks.acquireUpdateLock(containerName);
  try {
    const previousJournal = await journalStore.read(containerName);
    if (previousJournal) {
      validateJournal(previousJournal, containerName);
      if (previousJournal.stage === 'complete' && previousJournal.targetVersion === options.targetVersion) {
        const completedContainer = await inspectSameContainer(containerName, previousJournal.containerId, callbacks);
        if (previousJournal.originallyRunning) {
          if (!completedContainer.running || completedContainer.paused) {
            throw new UnsafeLegacyContainerUpdateError('Completed Update journal does not match a running Container.');
          }
          const completedCheck = await callbacks.verifyUpdated(previousJournal.containerId, options.targetVersion);
          if (!completedCheck.verified || completedCheck.version !== options.targetVersion) {
            throw new UnsafeLegacyContainerUpdateError('Completed Update journal failed its live verification.');
          }
        } else if (completedContainer.running || completedContainer.paused) {
          throw new UnsafeLegacyContainerUpdateError('Completed Update journal does not match a stopped Container.');
        }
        await clearJournalAndCleanup(containerName, previousJournal, journalStore, callbacks);
        return previousJournal;
      }
      if (previousJournal.stage !== 'complete' && previousJournal.stage !== 'rolled_back') {
        await recoverUnderLock(containerName, journalStore, callbacks, now);
        throw new Error(
          'An interrupted Container Update was recovered. Retry the explicit Update to apply the bundle.',
        );
      }
      await journalStore.clear(containerName);
      await callbacks
        .cleanupUpdateArtifacts?.(previousJournal.containerId, previousJournal.transactionId)
        .catch(() => undefined);
    }

    const original = validateInspection(await callbacks.inspect(containerName), containerName);
    if (original.paused) {
      throw new UnsafeLegacyContainerUpdateError('Container is already paused by another operation; refusing Update.');
    }
    if (
      original.healthCheck.kind === 'other' ||
      (original.healthCheck.kind === 'idle-marker' && !isOwnedIdleHealthCheck(original.healthCheck))
    ) {
      throw new UnsafeLegacyContainerUpdateError(
        'Container already has an unrelated or unknown healthcheck; refusing Update.',
      );
    }

    let current: LegacyContainerUpdateJournal = {
      schemaVersion: 1,
      transactionId: transactionId(),
      containerName,
      containerId: original.id,
      originallyRunning: original.running,
      originalHealthCheck: copyHealthCheck(original.healthCheck),
      targetVersion: options.targetVersion,
      stage: 'prepared',
      updatedAt: now().toISOString(),
    };
    await journalStore.write(containerName, current);
    const setStage = async (stage: LegacyContainerUpdateStage): Promise<void> => {
      current = await persist(current, stage, journalStore, now);
    };

    try {
      if (original.running) {
        await setStage('pausing');
        await inspectSameContainer(containerName, original.id, callbacks);
        await callbacks.runPodman(['pause', original.id]);
        const paused = await inspectSameContainer(containerName, original.id, callbacks);
        if (paused.running || !paused.paused) throw new Error('Container did not enter the expected paused state.');
        await setStage('paused');
      } else {
        await setStage('paused');
      }

      await assertFrozen(containerName, original.id, original.running, callbacks);
      const ledger = await callbacks.readFrozenLedger(original.id);
      if (
        !ledger ||
        !Array.isArray(ledger.pending) ||
        !Array.isArray(ledger.running) ||
        ledger.pending.some((id) => typeof id !== 'string') ||
        ledger.running.some((id) => typeof id !== 'string')
      ) {
        throw new UnsafeLegacyContainerUpdateError('Frozen Executor ledger is unreadable or has an unknown shape.');
      }
      await setStage('ledger_checked');
      if (ledger.pending.length > 0 || ledger.running.length > 0) {
        throw new UnsafeLegacyContainerUpdateError(
          'Executor ledger contains pending or running work; wait before Update.',
        );
      }

      await setStage('installing');
      await assertFrozen(containerName, original.id, original.running, callbacks);
      await callbacks.installBundleAndMarkers(original.id, {
        transactionId: current.transactionId,
        targetVersion: options.targetVersion,
        bundle: new Uint8Array(options.bundle),
        enableMarkerPath: LEGACY_HEALTH_ENABLE_MARKER_PATH,
        removeIdleMarkerPath: LEGACY_IDLE_MARKER_PATH,
      });
      await setStage('installed');
      await assertFrozen(containerName, original.id, original.running, callbacks);
      await setStage('configuring_health');
      await callbacks.runPodman([
        'update',
        `--health-cmd=${LEGACY_IDLE_HEALTH_COMMAND}`,
        '--health-interval=2s',
        '--health-start-period=30s',
        '--health-retries=1',
        '--health-on-failure=stop',
        original.id,
      ]);
      await setStage('health_configured');
      await assertFrozen(containerName, original.id, original.running, callbacks);
      if (original.running) {
        await setStage('terminating');
        await callbacks.runPodman(['kill', '-s', 'KILL', original.id]);
        await waitForStoppedContainer(containerName, original.id, callbacks);
      }
      await setStage('stopped');
      await setStage('starting');
      await callbacks.runPodman(['start', original.id]);
      const started = await inspectSameContainer(containerName, original.id, callbacks);
      if (!started.running || started.paused) throw new Error('Updated Container did not start normally.');
      await setStage('verifying');
      const verification = await callbacks.verifyUpdated(original.id, options.targetVersion);
      if (!verification.verified || verification.version !== options.targetVersion) {
        throw new Error(
          verification.reason || 'Updated Executor did not report the expected version and capabilities.',
        );
      }
      if (!original.running) {
        await callbacks.runPodman(['stop', '--time', '10', original.id]);
        await waitForStoppedContainer(containerName, original.id, callbacks);
      }
      current = await persist(current, 'complete', journalStore, now);
      await clearJournalAndCleanup(containerName, current, journalStore, callbacks);
      return current;
    } catch (error) {
      try {
        await rollbackUpdate({ journal: current, journalStore, callbacks, now });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Legacy Container Update failed and recovery is incomplete; durable journal retained for ${containerName}.`,
          { cause: rollbackError },
        );
      }
      await clearJournalAndCleanup(containerName, current, journalStore, callbacks);
      throw error;
    }
  } finally {
    await unlock();
  }
}
