import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { chmodSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PicoStore } from '../core/store.js';
import {
  LEGACY_HEALTH_ENABLE_MARKER_PATH,
  LEGACY_IDLE_MARKER_PATH,
  type FrozenContainerLedger,
  type LegacyContainerHealthCheck,
  type LegacyContainerUpdateCallbacks,
  type LegacyContainerUpdateInspection,
  type LegacyContainerUpdateJournal,
  type LegacyContainerUpdateJournalStore,
} from './legacy-container-update.js';

const INSTALL_PATH = '/opt/pico/executor-agent.mjs';
const VERSION_PATH = `${INSTALL_PATH}.version`;
const DATA_DESTINATION = '/opt/pico/data';
const INSTALLATION_SETTING = 'executor-container-installation-id';
const JOURNAL_DIRECTORY = 'legacy-container-updates';

export interface LegacyPlatformPodmanResult {
  stdout: string;
  stderr: string;
}

export type LegacyPlatformPodmanRunner = (
  args: string[],
  input?: string,
  signal?: AbortSignal,
) => Promise<LegacyPlatformPodmanResult>;

export interface LegacyStartAgentAndVerifyInput {
  containerId: string;
  version: string;
  accessToken: string;
  workspaceRoot: string;
  requireLease: boolean;
}

export type LegacyStartAgentAndVerify = (
  input: LegacyStartAgentAndVerifyInput,
) => Promise<{ verified: boolean; version?: string; reason?: string }>;

export interface LegacyUpdatePlatformInput {
  containerName: string;
  store: PicoStore;
  runPodman: LegacyPlatformPodmanRunner;
  bundle: Uint8Array;
  version: string;
  accessToken: string;
  workspaceRoot: string;
  startAgentAndVerify: LegacyStartAgentAndVerify;
}

export interface LegacyUpdatePlatform {
  callbacks: LegacyContainerUpdateCallbacks;
  journal: LegacyContainerUpdateJournalStore;
}

interface PodmanInspection {
  Id?: unknown;
  Name?: unknown;
  State?: { Running?: unknown; Paused?: unknown; Status?: unknown };
  Config?: {
    Labels?: Record<string, unknown>;
    Env?: unknown;
    Healthcheck?: unknown;
    HealthcheckOnFailureAction?: unknown;
  };
  HostConfig?: { HealthCheckOnFailureAction?: unknown; HealthConfig?: unknown };
  Mounts?: Array<{ Type?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown; Name?: unknown }>;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value: string): string {
  if (!value.trim() || value.includes('\0')) throw new Error('Legacy Container name is invalid.');
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isFrozen(inspection: LegacyContainerUpdateInspection): boolean {
  return (
    (inspection.status === 'paused' && inspection.paused && !inspection.running) ||
    (['created', 'exited', 'stopped'].includes(inspection.status) && !inspection.paused && !inspection.running)
  );
}

function persistentDatabasePath(store: PicoStore): string | null {
  const rows = store.db.prepare('PRAGMA database_list').all() as Array<{ name?: unknown; file?: unknown }>;
  const main = rows.find((row) => row.name === 'main');
  if (typeof main?.file !== 'string' || !main.file || main.file === ':memory:') return null;
  return resolve(main.file);
}

function settingPath(store: PicoStore): string {
  const path = persistentDatabasePath(store);
  if (!path) throw new Error('A persistent local Runtime database is required for legacy Container Update recovery.');
  return path;
}

function envMap(value: unknown): Map<string, string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Container environment inspection is unreadable; refusing Update.');
  }
  const result = new Map<string, string>();
  for (const entry of value as string[]) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    result.set(entry.slice(0, index), entry.slice(index + 1));
  }
  return result;
}

function healthFromInspect(raw: PodmanInspection): LegacyContainerHealthCheck {
  const config = raw.Config?.Healthcheck !== undefined ? raw.Config.Healthcheck : raw.HostConfig?.HealthConfig;
  const onFailure = raw.Config?.HealthcheckOnFailureAction ?? raw.HostConfig?.HealthCheckOnFailureAction;
  if (config === undefined)
    return onFailure === undefined || onFailure === 'none' ? { kind: 'none' } : { kind: 'other' };
  if (
    config === null ||
    (typeof config === 'object' &&
      config !== null &&
      'Test' in config &&
      Array.isArray((config as { Test?: unknown }).Test) &&
      ((config as { Test: unknown[] }).Test.length === 0 || (config as { Test: unknown[] }).Test[0] === 'NONE'))
  ) {
    return onFailure && onFailure !== 'none' ? { kind: 'other' } : { kind: 'none' };
  }
  if (typeof config !== 'object' || config === null) return { kind: 'other' };
  const candidate = config as {
    Test?: unknown;
    Interval?: unknown;
    StartPeriod?: unknown;
    Timeout?: unknown;
    Retries?: unknown;
  };
  if (!Array.isArray(candidate.Test) || candidate.Test.some((item) => typeof item !== 'string'))
    return { kind: 'other' };
  const command = candidate.Test.join(' ');
  const interval = candidate.Interval;
  const startPeriod = candidate.StartPeriod;
  const retries = candidate.Retries;
  if (
    command === `CMD-SHELL test ! -e ${LEGACY_IDLE_MARKER_PATH}` &&
    typeof interval === 'number' &&
    interval === 2_000_000_000 &&
    typeof startPeriod === 'number' &&
    startPeriod === 30_000_000_000 &&
    candidate.Timeout === 30_000_000_000 &&
    retries === 1 &&
    onFailure === 'stop'
  ) {
    return {
      kind: 'idle-marker',
      command: `test ! -e ${LEGACY_IDLE_MARKER_PATH}`,
      intervalMs: 2_000,
      startPeriodMs: 30_000,
      retries: 1,
      onFailure: 'stop',
    };
  }
  return { kind: 'other' };
}

function toInspection(
  name: string,
  raw: PodmanInspection,
  expectedInstallation: string,
  expectedToken: string,
): {
  value: LegacyContainerUpdateInspection;
  dataSource: string;
} {
  const id = raw.Id;
  const rawName = typeof raw.Name === 'string' ? raw.Name.replace(/^\//, '') : '';
  if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/i.test(id) || rawName !== name) {
    throw new Error('Container identity is incomplete or does not match; refusing Update.');
  }
  if (!raw.State || typeof raw.State.Running !== 'boolean' || typeof raw.State.Paused !== 'boolean') {
    throw new Error('Container state inspection is incomplete; refusing Update.');
  }
  const status = raw.State.Status;
  const acceptedStatuses = new Set(['created', 'exited', 'paused', 'running', 'stopped', 'stopping']);
  if (typeof status !== 'string' || !acceptedStatuses.has(status)) {
    throw new Error('Container status inspection is incomplete or transitional; refusing Update.');
  }
  const stateConsistent =
    (status === 'running' && raw.State.Running && !raw.State.Paused) ||
    (status === 'paused' && !raw.State.Running && raw.State.Paused) ||
    (['created', 'exited', 'stopped'].includes(status) && !raw.State.Running && !raw.State.Paused) ||
    (status === 'stopping' && !raw.State.Paused);
  if (!stateConsistent) throw new Error('Container status conflicts with its running/paused state.');
  const labels = raw.Config?.Labels;
  const prefix = process.env.PICO_CONTAINER_NAME?.trim() || 'pico-executor';
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameMatch = new RegExp(`^${escapedPrefix}-${expectedInstallation.slice(0, 16)}-([a-f0-9]{32})$`).exec(name);
  const executorKind = labels?.['io.pico.executor'];
  const executorKey =
    executorKind === 'workspace'
      ? labels?.['io.pico.workspace-key']
      : executorKind === 'container'
        ? labels?.['io.pico.executor-key']
        : undefined;
  if (
    !labels ||
    labels['io.pico.installation-id'] !== expectedInstallation ||
    (executorKind !== 'container' && executorKind !== 'workspace') ||
    !nameMatch ||
    typeof executorKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(executorKey) ||
    !executorKey.startsWith(nameMatch[1]!)
  ) {
    throw new Error('Container is not owned by this Pico installation; refusing Update.');
  }
  const env = envMap(raw.Config?.Env);
  // Legacy containers keep only the token in Config.Env; agent launch settings
  // are supplied by a later `podman exec env` command and are not inspectable here.
  if (!constantTimeEqual(env.get('PICO_EXECUTOR_TOKEN') ?? '', expectedToken)) {
    throw new Error('Container Executor configuration does not match this Runtime; refusing Update.');
  }
  if (!Array.isArray(raw.Mounts)) throw new Error('Container mounts are unreadable; refusing Update.');
  const dataMounts = raw.Mounts.filter((mount) => mount.Destination === DATA_DESTINATION);
  if (
    dataMounts.length !== 1 ||
    typeof dataMounts[0]?.Source !== 'string' ||
    dataMounts[0].Type !== 'volume' ||
    dataMounts[0].Name !== `pico-executor-data-${expectedInstallation.slice(0, 16)}-${executorKey.slice(0, 32)}` ||
    dataMounts[0].RW !== true
  ) {
    throw new Error('Container data mount is missing, ambiguous, or read-only; refusing Update.');
  }
  return {
    value: {
      id,
      name,
      running: raw.State.Running,
      paused: raw.State.Paused,
      status,
      healthCheck: healthFromInspect(raw),
    },
    dataSource: dataMounts[0].Source,
  };
}

async function atomicWrite(path: string, contents: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.${hash(path).slice(0, 16)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await rename(temp, path);
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Persistent Update path is not a safe directory.');
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await syncDirectory(dirname(directory));
    await syncDirectory(directory);
  }
  await chmod(absolute, 0o700);
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function journalPath(directory: string, name: string): string {
  return join(directory, `${hash(name)}.json`);
}

/** Checks for a recovery journal without creating directories or acquiring the update lock. */
export function hasLegacyUpdateJournal(store: PicoStore, containerName: string): boolean {
  safeName(containerName);
  const databasePath = persistentDatabasePath(store);
  if (!databasePath) return false;
  const path = journalPath(join(dirname(databasePath), JOURNAL_DIRECTORY), containerName);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Legacy Container Update journal is not a regular file; recovery is unsafe.');
  }
  return true;
}

function createJournalStore(directory: string): LegacyContainerUpdateJournalStore {
  return {
    async read(name) {
      const path = journalPath(directory, name);
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
      const journal = JSON.parse(data.toString('utf8')) as LegacyContainerUpdateJournal;
      if (!journal || journal.containerName !== name || journal.schemaVersion !== 1) {
        throw new Error('Legacy Container Update journal is invalid; refusing recovery.');
      }
      return journal;
    },
    async write(name, journal) {
      if (journal.containerName !== name) throw new Error('Journal/container name mismatch.');
      await atomicWrite(journalPath(directory, name), Buffer.from(JSON.stringify(journal), 'utf8'));
    },
    async clear(name) {
      const path = journalPath(directory, name);
      await rm(path, { force: true });
      const dir = await open(directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    },
  };
}

function createLock(directory: string): (containerName: string) => Promise<() => void> {
  return async (containerName) => {
    await ensurePrivateDirectory(directory);
    const path = join(directory, `${hash(containerName)}.lock.sqlite`);
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch (error) {
      db.close();
      throw new Error('Another process is updating or recovering this Executor; retry later.', { cause: error });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        db.exec('ROLLBACK;');
      } finally {
        db.close();
      }
    };
  };
}

async function copyContainerFile(
  runPodman: LegacyPlatformPodmanRunner,
  id: string,
  source: string,
  destination: string,
): Promise<void> {
  await runPodman(['cp', `${id}:${source}`, destination]);
}

async function copyHostFile(
  runPodman: LegacyPlatformPodmanRunner,
  source: string,
  id: string,
  destination: string,
): Promise<void> {
  await runPodman(['cp', source, `${id}:${destination}`]);
}

export function createLegacyUpdatePlatform(input: LegacyUpdatePlatformInput): LegacyUpdatePlatform {
  const containerName = safeName(input.containerName);
  if (!input.version.trim() || input.bundle.byteLength === 0 || !input.accessToken || !input.workspaceRoot) {
    throw new Error('Version, bundle, token, and workspace are required for Container Update.');
  }
  const installationId = input.store.getSetting<string | null>(INSTALLATION_SETTING, null);
  if (!installationId || !/^[a-f0-9]{32}$/.test(installationId)) {
    throw new Error('This Runtime has no valid Pico Container installation identity.');
  }
  const databasePath = settingPath(input.store);
  const persistentDirectory = join(dirname(databasePath), JOURNAL_DIRECTORY);
  const backupRoot = join(persistentDirectory, 'backups');
  const locks = createLock(persistentDirectory);
  let knownDataSource: string | undefined;
  const inspect = async (target: string): Promise<LegacyContainerUpdateInspection | null> => {
    if (target !== containerName) throw new Error('Container name changed during update; refusing.');
    const result = await input.runPodman(['inspect', target]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error('Podman inspect output is invalid; refusing Update.');
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) {
      throw new Error('Podman inspect returned an ambiguous result; refusing Update.');
    }
    const inspected = toInspection(containerName, parsed[0] as PodmanInspection, installationId, input.accessToken);
    knownDataSource = await realpath(inspected.dataSource);
    const sourceStat = await stat(knownDataSource);
    if (!sourceStat.isDirectory()) throw new Error('Container data mount source is not a local directory.');
    return inspected.value;
  };
  const dataDirectory = async (id: string): Promise<string> => {
    if (id !== (await inspect(containerName))?.id || !knownDataSource) throw new Error('Container identity changed.');
    return knownDataSource;
  };
  const backupDirectory = (tx: string): string => join(backupRoot, hash(containerName), hash(tx));
  const backupManifest = (tx: string) => join(backupDirectory(tx), 'manifest.json');
  const cleanupTransactionBackup = async (tx: string): Promise<void> => {
    const directory = backupDirectory(tx);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Update backup path is not a safe directory.');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
    await syncDirectory(dirname(directory));
  };
  const cleanupStaleBackups = async (activeTransactionId?: string): Promise<void> => {
    const containerBackups = join(backupRoot, hash(containerName));
    let info;
    try {
      info = await lstat(containerBackups);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Update backup root is not a safe directory.');
    for (const entry of await readdir(containerBackups, { withFileTypes: true })) {
      const path = join(containerBackups, entry.name);
      const entryInfo = await lstat(path);
      if (entryInfo.isSymbolicLink()) throw new Error('Update backup contains an unexpected symbolic link.');
      if (!entryInfo.isDirectory()) throw new Error('Update backup contains an unexpected non-directory entry.');
      if (activeTransactionId && entry.name === hash(activeTransactionId)) {
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (!child.name.startsWith('.stage-')) continue;
          const stagePath = join(path, child.name);
          const stageInfo = await lstat(stagePath);
          if (stageInfo.isSymbolicLink() || !stageInfo.isDirectory()) {
            throw new Error('Update staging backup entry is unsafe.');
          }
          await rm(stagePath, { recursive: true, force: true });
        }
        continue;
      }
      await rm(path, { recursive: true, force: true });
    }
    await syncDirectory(containerBackups);
  };
  const readBackupManifest = async (tx: string): Promise<{ version: string; enableMarker: boolean } | null> => {
    let data: string;
    try {
      data = await readFile(backupManifest(tx), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(data);
    } catch {
      throw new Error('Update backup manifest is invalid; refusing recovery.');
    }
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      typeof (manifest as { version?: unknown }).version !== 'string' ||
      !(manifest as { version: string }).version.trim() ||
      typeof (manifest as { enableMarker?: unknown }).enableMarker !== 'boolean'
    ) {
      throw new Error('Update backup manifest is incomplete; refusing recovery.');
    }
    return manifest as { version: string; enableMarker: boolean };
  };
  const validateBackupFiles = async (tx: string, manifest: { enableMarker: boolean }): Promise<void> => {
    const dir = backupDirectory(tx);
    for (const path of [
      'executor-agent.mjs',
      'executor-agent.mjs.version',
      ...(manifest.enableMarker ? ['enable-marker'] : []),
    ]) {
      const info = await lstat(join(dir, path));
      const maxBytes = path === 'executor-agent.mjs' ? 50 * 1024 * 1024 : path === 'enable-marker' ? 4096 : 256;
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size < (path === 'enable-marker' ? 0 : 1) ||
        info.size > maxBytes
      ) {
        throw new Error('Update backup is incomplete or unsafe; refusing recovery.');
      }
    }
  };
  const ensureBackup = async (id: string, tx: string): Promise<{ version: string }> => {
    const dir = backupDirectory(tx);
    const manifest = backupManifest(tx);
    await ensurePrivateDirectory(dir);
    try {
      const parsed = await readBackupManifest(tx);
      if (parsed) {
        await validateBackupFiles(tx, parsed);
        return { version: parsed.version };
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const agentBackup = join(dir, 'executor-agent.mjs');
    const versionBackup = join(dir, 'executor-agent.mjs.version');
    await copyContainerFile(input.runPodman, id, INSTALL_PATH, agentBackup);
    await copyContainerFile(input.runPodman, id, VERSION_PATH, versionBackup);
    const agentInfo = await lstat(agentBackup);
    const versionInfo = await lstat(versionBackup);
    if (
      !agentInfo.isFile() ||
      agentInfo.isSymbolicLink() ||
      agentInfo.size < 1 ||
      agentInfo.size > 50 * 1024 * 1024 ||
      !versionInfo.isFile() ||
      versionInfo.isSymbolicLink() ||
      versionInfo.size < 1 ||
      versionInfo.size > 256
    ) {
      throw new Error('Original Executor files are not safe regular files; refusing Update.');
    }
    await chmod(agentBackup, 0o600);
    await chmod(versionBackup, 0o600);
    await syncFile(agentBackup);
    await syncFile(versionBackup);
    const source = await dataDirectory(id);
    const markerPath = join(source, 'pico-health-supervisor-enabled');
    let markerContents: Buffer | null = null;
    try {
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096)
        throw new Error('Health enable marker is not a regular file.');
      markerContents = await readFile(markerPath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const previousVersion = (await readFile(versionBackup, 'utf8')).trim();
    if (!previousVersion || previousVersion.length > 200) throw new Error('Original Executor version is unreadable.');
    if (markerContents) await atomicWrite(join(dir, 'enable-marker'), markerContents);
    await atomicWrite(
      manifest,
      Buffer.from(JSON.stringify({ version: previousVersion, enableMarker: markerContents !== null }), 'utf8'),
    );
    return { version: previousVersion };
  };
  const journal = createJournalStore(persistentDirectory);
  const callbacks: LegacyContainerUpdateCallbacks = {
    async acquireUpdateLock(name) {
      const unlock = await locks(name);
      try {
        const active = await journal.read(name);
        await cleanupStaleBackups(active?.transactionId);
        return unlock;
      } catch (error) {
        unlock();
        throw error;
      }
    },
    async runPodman(args) {
      await input.runPodman(args);
    },
    inspect,
    async readFrozenLedger(id): Promise<FrozenContainerLedger | null> {
      try {
        const state = await inspect(containerName);
        if (!state || id !== state.id || !isFrozen(state)) return null;
        const source = await dataDirectory(id);
        const dbPath = join(source, 'executor.sqlite');
        const dbInfo = await lstat(dbPath);
        if (!dbInfo.isFile() || dbInfo.isSymbolicLink()) return null;
        const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 0 });
        try {
          db.exec('PRAGMA query_only=ON;');
          const rows = db
            .prepare("SELECT execution_id, status FROM remote_executions WHERE status IN ('pending', 'running')")
            .all() as Array<{ execution_id?: unknown; status?: unknown }>;
          if (
            rows.some(
              (row) => typeof row.execution_id !== 'string' || (row.status !== 'pending' && row.status !== 'running'),
            )
          )
            return null;
          return {
            pending: rows.filter((row) => row.status === 'pending').map((row) => row.execution_id as string),
            running: rows.filter((row) => row.status === 'running').map((row) => row.execution_id as string),
          };
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    },
    async installBundleAndMarkers(id, payload) {
      if (payload.targetVersion !== input.version || !Buffer.from(payload.bundle).equals(Buffer.from(input.bundle))) {
        throw new Error('Update bundle does not match the approved platform input.');
      }
      if (
        payload.enableMarkerPath !== LEGACY_HEALTH_ENABLE_MARKER_PATH ||
        payload.removeIdleMarkerPath !== LEGACY_IDLE_MARKER_PATH
      ) {
        throw new Error('Update marker paths are not the expected Container data paths.');
      }
      const state = await inspect(containerName);
      if (!state || state.id !== id || !isFrozen(state)) {
        throw new Error('Container must be paused or stopped before installing Update files.');
      }
      await ensureBackup(id, payload.transactionId);
      const dir = await mkdtemp(join(backupDirectory(payload.transactionId), '.stage-'));
      try {
        const bundlePath = join(dir, 'executor-agent.mjs');
        const versionPath = join(dir, 'executor-agent.mjs.version');
        const enablePath = join(dir, 'pico-health-supervisor-enabled');
        await atomicWrite(bundlePath, input.bundle);
        await atomicWrite(versionPath, Buffer.from(`${input.version}\n`));
        await atomicWrite(enablePath, Buffer.alloc(0));
        await copyHostFile(input.runPodman, bundlePath, id, INSTALL_PATH);
        await copyHostFile(input.runPodman, versionPath, id, VERSION_PATH);
        const source = await dataDirectory(id);
        const enableHostPath = join(source, 'pico-health-supervisor-enabled');
        await atomicWrite(enableHostPath, Buffer.alloc(0));
        await rm(join(source, 'pico-executor-idle'), { force: true });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async restoreInstalledFiles(id, transactionId) {
      const state = await inspect(containerName);
      if (!state || state.id !== id || !isFrozen(state)) {
        throw new Error('Container must be paused or stopped before restoring Update files.');
      }
      const dir = backupDirectory(transactionId);
      const manifest = await readBackupManifest(transactionId);
      // Journal stage `installing` is persisted before ensureBackup starts. If a
      // crash happened before the manifest was committed, no container files have
      // been changed and the safe rollback action is a no-op.
      if (!manifest) return;
      await validateBackupFiles(transactionId, manifest);
      await copyHostFile(input.runPodman, join(dir, 'executor-agent.mjs'), id, INSTALL_PATH);
      await copyHostFile(input.runPodman, join(dir, 'executor-agent.mjs.version'), id, VERSION_PATH);
      const source = await dataDirectory(id);
      const markerTarget = join(source, 'pico-health-supervisor-enabled');
      if (manifest.enableMarker) await atomicWrite(markerTarget, await readFile(join(dir, 'enable-marker')));
      else await rm(markerTarget, { force: true });
      await rm(join(source, 'pico-executor-idle'), { force: true });
    },
    async cleanupUpdateArtifacts(id, transactionId) {
      const state = await inspect(containerName);
      if (!state || state.id !== id) throw new Error('Container identity changed before backup cleanup.');
      await cleanupTransactionBackup(transactionId);
    },
    async verifyUpdated(id, version) {
      return input.startAgentAndVerify({
        containerId: id,
        version,
        accessToken: input.accessToken,
        workspaceRoot: input.workspaceRoot,
        requireLease: true,
      });
    },
    async verifyRestored(id) {
      const txJournal = await journal.read(containerName);
      if (!txJournal) return false;
      const saved = await ensureBackup(id, txJournal.transactionId);
      const result = await input.startAgentAndVerify({
        containerId: id,
        version: saved.version,
        accessToken: input.accessToken,
        workspaceRoot: input.workspaceRoot,
        requireLease: false,
      });
      return result.verified && result.version === saved.version;
    },
  };
  return { callbacks, journal };
}
