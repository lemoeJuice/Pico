#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { cp } from 'node:fs/promises';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildReleaseManifest, diagnoseChanges, readReleaseBaseline, writeReleaseBaseline } from './deploy/manifest.mjs';
import { createSourceSnapshot, removeSourceSnapshot } from './deploy/snapshot.mjs';
import { prepareWebPublication, registeredPluginWebUis } from './deploy/publish-web.mjs';
import { compareInstalledLock } from './deploy/dependencies.mjs';
import { runtimeArtifactHashes } from './deploy/artifacts.mjs';
import { selectDeploymentScope } from './deploy/selection.mjs';
import { acquireSystemdUnitReference, assertRestartableSystemdUnit } from './deploy/systemd.mjs';
import { assertSystemdTokenSource } from './deploy/systemd-credentials.mjs';
import { recoverStoppedSystemdUnit } from './deploy/systemd-recovery.mjs';
import { getActiveThreadCount as countActiveThreads } from './deploy/thread-activity.mjs';
import {
  assertAddressesUncontended,
  assertNoConflictingListeners,
  listenerPidsConflictingWithAddresses,
  parseListenerRows,
} from './deploy/listeners.mjs';

const projectRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const runtimeLauncher = path.join(projectRoot, 'scripts/start-runtime.sh');
const containerScopeHelper = path.join(projectRoot, 'scripts/deploy/systemd-container-scope.py');
const defaultLogPath = '/tmp/pico-runtime-production.log';
const lockPath = path.join(projectRoot, '.pico-deploy.lock');
const backupPrefix = '.pico-deploy-backup-';
const manifestName = 'manifest.json';
const releaseBaselinePath = path.join(projectRoot, '.pico-deploy-state.json');
let receivedSignal;
let shutdownStarted = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    receivedSignal ??= signal;
  });
}

// The token must come from the live Runtime below, never from this script's caller environment.
delete process.env.PICO_ACCESS_TOKEN;

const port = parseInteger(process.env.PICO_DEPLOY_PORT ?? '4173', 'PICO_DEPLOY_PORT', 1, 65535);
const idleTimeoutSeconds = parseInteger(
  process.env.PICO_DEPLOY_IDLE_TIMEOUT_SECONDS ?? '300',
  'PICO_DEPLOY_IDLE_TIMEOUT_SECONDS',
  0,
  86400,
);
const shutdownTimeoutSeconds = parseInteger(
  process.env.PICO_DEPLOY_SHUTDOWN_TIMEOUT_SECONDS ?? '180',
  'PICO_DEPLOY_SHUTDOWN_TIMEOUT_SECONDS',
  1,
  86400,
);
const startupTimeoutSeconds = parseInteger(
  process.env.PICO_DEPLOY_STARTUP_TIMEOUT_SECONDS ?? '45',
  'PICO_DEPLOY_STARTUP_TIMEOUT_SECONDS',
  1,
  3600,
);
const logPath = path.resolve(process.env.PICO_DEPLOY_LOG ?? defaultLogPath);

function parseInteger(value, name, min, max) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function throwIfInterrupted() {
  if (receivedSignal && !shutdownStarted) throw new Error(`Deployment interrupted by ${receivedSignal}.`);
}

function acquireDeploymentLock() {
  let fd;
  let identity;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    identity = fstatSync(fd);
    writeSync(fd, `${process.pid} ${processStartTime(process.pid)}\n`);
    return { fd, identity };
  } catch (error) {
    if (fd !== undefined) {
      try {
        const current = statSync(lockPath);
        if (identity && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
      } catch {
        // Keep the original lock error as the useful failure.
      }
      closeSync(fd);
    }
    if (error?.code === 'EEXIST') {
      throw new Error('Another deployment may be running, or .pico-deploy.lock is stale. Verify its PID before removing it.', { cause: error });
    }
    throw new Error('Could not create the deployment lock in the project root.', { cause: error });
  }
}

function releaseDeploymentLock(lock) {
  if (!lock) return;
  try {
    const current = statSync(lockPath);
    if (current.dev === lock.identity.dev && current.ino === lock.identity.ino) unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    closeSync(lock.fd);
  }
}

function listenerRows() {
  const result = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('Cannot inspect the listener. Run this script on the deployment host with permission to inspect it.');
  }
  return parseListenerRows(result.stdout);
}

function listenerPids() {
  return [...new Set(listenerRows().flatMap((row) => row.pids))];
}

function readProcessEnvironment(pid) {
  const buffer = readFileSync(`/proc/${pid}/environ`);
  const environment = Object.create(null);
  for (const item of buffer.toString('utf8').split('\0')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    environment[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return environment;
}

function processStartTime(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  if (!startTime) throw new Error(`Cannot read process identity for ${pid}.`);
  return startTime;
}

function processBelongsToControlGroup(pid, controlGroup) {
  const expected = controlGroup.replace(/\/$/, '') || '/';
  const entries = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf(':') + 1))
    .filter(Boolean);
  return entries.some((entry) => entry === expected || (expected !== '/' && entry.startsWith(`${expected}/`)));
}

function isolateRuntimeContainerProcesses(systemdContext, runtimePid, expectedStartTime) {
  if (!systemdContext?.supported) {
    throw new Error('Container preservation requires a verified systemd manager; no Runtime was stopped.');
  }
  const busMode = systemdContext.args?.includes('--user') ? '--user' : '--system';
  if (busMode === '--user' && !process.env.XDG_RUNTIME_DIR) {
    throw new Error('The user systemd bus is unavailable; no Runtime was stopped.');
  }
  const controlGroup = systemdShow(systemdContext, 'ControlGroup');
  if (!controlGroup.startsWith('/') || !isPicoProcess(runtimePid, expectedStartTime)) {
    throw new Error('Cannot verify the Pico Runtime unit cgroup; no Runtime was stopped.');
  }
  if (!processBelongsToControlGroup(runtimePid, controlGroup)) {
    throw new Error('The Pico Runtime process is outside its verified systemd cgroup; no Runtime was stopped.');
  }

  const scopePrefix = `pico-container-preserve-${randomUUID()}`;
  const helperEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (busMode === '--user') helperEnvironment.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  const result = spawnSync(
    'python3',
    [containerScopeHelper, busMode, systemdContext.unit, controlGroup, scopePrefix],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: helperEnvironment,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    },
  );
  const summary = /^OK (\d+)\s*$/.exec(result.stdout ?? '');
  if (result.error || result.status !== 0 || !summary) {
    throw new Error('Could not isolate Runtime Container processes; no Runtime was stopped.');
  }
  if (
    systemdShow(systemdContext, 'ControlGroup') !== controlGroup ||
    !isPicoProcess(runtimePid, expectedStartTime) ||
    !processBelongsToControlGroup(runtimePid, controlGroup)
  ) {
    throw new Error('The Runtime or its systemd cgroup changed during Container isolation; no Runtime was stopped.');
  }
  return Number(summary[1]);
}

function isPicoProcess(pid, expectedStartTime) {
  try {
    if (statSync(`/proc/${pid}`).uid !== process.getuid()) return false;
    if (expectedStartTime !== undefined && processStartTime(pid) !== expectedStartTime) return false;
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    const args = readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const executable = realpathSync(`/proc/${pid}/exe`);
    return (
      cwd === projectRoot &&
      args.some((arg) => /(^|\/)dist\/server\/server\.js$/.test(arg)) &&
      /\/node(?:js)?$/.test(executable)
    );
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
    throw new Error(`Cannot verify process ${pid}; run as the Runtime owner and retry.`, { cause: error });
  }
}

function requirePicoListener(expectedPid, expectedStartTime) {
  const rows = listenerRows();
  const targetAddresses = [...new Set(rows.filter((row) => row.pids.includes(expectedPid)).map((row) => row.address))];
  if (!isPicoProcess(expectedPid, expectedStartTime)) {
    throw new Error(
      `Port ${port} is no longer owned by the verified Pico Runtime from this repository; refusing to stop or replace it.`,
    );
  }
  assertNoConflictingListeners(rows, expectedPid, targetAddresses);
}

function otherPicoListenerPids(rows, expectedPid) {
  return [...new Set(rows.flatMap((row) => row.pids))]
    .filter((pid) => pid !== expectedPid && isPicoProcess(pid));
}

function normalizedAddress(address) {
  const unscoped = address.split('%', 1)[0].toLowerCase();
  return unscoped.startsWith('::ffff:') ? unscoped.slice('::ffff:'.length) : unscoped;
}

async function apiBaseUrl(runtimeEnvironment) {
  const bindHost = runtimeEnvironment.PICO_HOST || '127.0.0.1';
  let connectHost;
  if (bindHost === '0.0.0.0') connectHost = '127.0.0.1';
  else if (bindHost === '::') connectHost = '::1';
  else if (bindHost.toLowerCase() === 'localhost') connectHost = '127.0.0.1';
  else {
    const normalizedHost = normalizedAddress(bindHost);
    const localAddresses = new Set(Object.values(networkInterfaces())
      .flatMap((interfaces) => interfaces ?? [])
      .map((address) => normalizedAddress(address.address)));
    localAddresses.add('127.0.0.1');
    localAddresses.add('::1');
    let candidates;
    if (isIP(normalizedHost)) candidates = [normalizedHost];
    else {
      try {
        candidates = (await lookup(bindHost, { all: true, verbatim: true })).map((entry) => normalizedAddress(entry.address));
      } catch {
        throw new Error('PICO_HOST does not resolve to a local network address; refusing to send the access token.');
      }
    }
    connectHost = candidates.find((address) => localAddresses.has(address));
    if (!connectHost) throw new Error('PICO_HOST does not resolve to a local network address; refusing to send the access token.');
  }
  const urlHost = connectHost.includes(':') && !connectHost.startsWith('[') ? `[${connectHost}]` : connectHost;
  return `http://${urlHost}:${port}`;
}

function getSystemdContext(pid, runtimeEnvironment) {
  if (runtimeEnvironment.INVOCATION_ID || runtimeEnvironment.SYSTEMD_EXEC_PID) {
    const cgroups = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    const unit = cgroups
      .split('\n')
      .map((line) => line.slice(line.lastIndexOf(':') + 1))
      .flatMap((groupPath) => groupPath.split('/'))
      .findLast((part) => part.endsWith('.service'));
    if (!unit) return { supported: false };
    const userManager = cgroups.includes('/user.slice/user-') && cgroups.includes('/user@');
    return { supported: true, unit, args: userManager ? ['--user'] : [] };
  }
  const cgroups = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  const unit = cgroups
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf(':') + 1))
    .flatMap((groupPath) => groupPath.split('/'))
    .findLast((part) => part.endsWith('.service'));
  if (!unit) return null;
  const userManager = cgroups.includes('/user.slice/user-') && cgroups.includes('/user@');
  return { supported: true, unit, args: userManager ? ['--user'] : [] };
}

function systemdShow(context, property) {
  const result = spawnSync('systemctl', [...context.args, 'show', context.unit, '--no-pager', `--property=${property}`, '--value'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot safely inspect systemd unit ${context.unit}; no Runtime was stopped.`);
  }
  return result.stdout.trim();
}

function verifySystemdTokenSource(context, token) {
  if (!context?.supported) {
    throw new Error('This systemd unit type cannot be safely restarted by the deployment script.');
  }
  const userManager = context.args.includes('--user');
  let managerEnvironment = '';
  if (userManager) {
    const result = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.error || result.status !== 0) throw new Error('Cannot safely inspect the systemd user manager environment; no Runtime was stopped.');
    managerEnvironment = result.stdout;
  }
  assertSystemdTokenSource({
    unitEnvironment: systemdShow(context, 'Environment'),
    managerEnvironment,
    unsetEnvironment: systemdShow(context, 'UnsetEnvironment'),
    environmentFiles: systemdShow(context, 'EnvironmentFiles'),
    execStart: systemdShow(context, 'ExecStart'),
    userManager,
    token,
  });
}

function verifyRestartableSystemdUnit(context) {
  assertRestartableSystemdUnit(context, (property) => systemdShow(context, property), (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

async function controlSystemdUnit(context, operation) {
  if (!['stop', 'start'].includes(operation)) throw new Error('Unsupported systemd operation.');
  await new Promise((resolve, reject) => {
    const child = spawn('systemctl', [...context.args, operation, context.unit], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => reject(new Error(`Could not ${operation} systemd unit ${context.unit}.`)));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`systemd could not ${operation} ${context.unit}; inspect the unit and deployment state.`));
    });
  });
}

async function fetchWithTimeout(url, options = {}) {
  const method = options.method ?? 'GET';
  const maxAttempts = method === 'GET' ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(250);
    }
  }
  const route = new URL(url).pathname;
  const reason = lastError?.cause?.code || lastError?.name || 'network error';
  throw new Error(`Cannot reach the Runtime API at ${route} (${reason}).`);
}

async function createSession(baseUrl, token) {
  const response = await fetchWithTimeout(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error('The live Runtime rejected its configured access token.');
  const session = await response.json().catch(() => null);
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie?.split(';', 1)[0];
  if (!session?.authenticated || !cookie) {
    throw new Error('The Runtime did not issue an authenticated session.');
  }
  return cookie;
}

async function getJson(baseUrl, cookie, route) {
  const response = await fetchWithTimeout(`${baseUrl}${route}`, { headers: { cookie } });
  if (!response.ok) throw new Error(`Authenticated Runtime check failed (${response.status}).`);
  return response.json().catch(() => {
    throw new Error('The Runtime returned an invalid response during deployment checks.');
  });
}

async function revokeSession(baseUrl, cookie, required = false) {
  if (!cookie) return;
  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/auth/session`, {
      method: 'DELETE',
      headers: { cookie },
    });
    if (!response.ok && required) throw new Error('Could not revoke the temporary authentication session.');
  } catch (error) {
    if (required) throw error;
  }
}

async function verifyWorkspace(baseUrl, cookie) {
  const info = await getJson(baseUrl, cookie, '/api/info');
  if (typeof info.defaultWorkspace !== 'string' || realpathSync(info.defaultWorkspace) !== projectRoot) {
    throw new Error('The Runtime API reports a different workspace; refusing to deploy to it.');
  }
}

async function getActiveThreadCount(baseUrl, cookie) {
  const threads = await getJson(baseUrl, cookie, '/api/threads');
  return countActiveThreads(threads, (threadId) =>
    getJson(baseUrl, cookie, `/api/threads/${encodeURIComponent(threadId)}`),
  );
}

async function waitForIdle(baseUrl, cookie) {
  const deadline = Date.now() + idleTimeoutSeconds * 1000;
  let activeCount = await getActiveThreadCount(baseUrl, cookie);
  if (activeCount === 0) return;
  if (idleTimeoutSeconds === 0) {
    throw new Error(`${activeCount} Thread(s) are active. Pause or finish them, then rerun deployment.`);
  }
  console.log(`当前有 ${activeCount} 个活动 Thread，等待其进入空闲状态（最长 ${idleTimeoutSeconds} 秒）。`);
  while (Date.now() < deadline) {
    await sleep(2000);
    activeCount = await getActiveThreadCount(baseUrl, cookie);
    if (activeCount === 0) return;
  }
  throw new Error(`${activeCount} Thread(s) remain active. No process was stopped; pause or finish them and retry.`);
}

async function confirmRestart() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive confirmation is required. Run this script in a terminal.');
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question('授权开始构建并替换当前 Runtime？输入 RESTART 继续：');
    if (answer.trim() !== 'RESTART') throw new Error('Restart cancelled; the current Runtime is still running.');
  } finally {
    readline.close();
  }
}

async function confirmNoInFlightCommands() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive confirmation is required before stopping the Runtime.');
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      '构建已完成。请确认没有运行中的 /compact、插件模型调用或其他命令，也没有客户端在部署期间提交新工作。输入 STOP_RUNTIME 停服：',
    );
    if (answer.trim() !== 'STOP_RUNTIME') {
      throw new Error('Final quiescence confirmation cancelled; the old Runtime is still running.');
    }
  } finally {
    readline.close();
  }
}

async function runNpm(args, sourceRoot, { quiet = false } = {}) {
  const environment = { ...process.env };
  // Tests and builds must never inherit a production DB, plugin directory,
  // listener, credential, or production-only dependency installation mode.
  for (const key of Object.keys(environment)) if (key.startsWith('PICO_')) delete environment[key];
  delete environment.NODE_ENV;
  await new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: sourceRoot, env: environment, stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
    child.once('error', () => reject(new Error(`Could not start npm ${args.join(' ')}.`)));
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`npm ${args.join(' ')} failed; production artifacts were not changed.`));
    });
  });
  throwIfInterrupted();
}

async function installSnapshotDependencies(sourceRoot) {
  const comparison = compareInstalledLock(sourceRoot, projectRoot);
  // Never let npm ci remove the production workspace's linked dependencies.
  unlinkSync(path.join(sourceRoot, 'node_modules'));
  if (comparison.matches) {
    console.log('已安装依赖与锁文件一致；复制到隔离快照并校验依赖树。');
    try {
      await cp(path.join(projectRoot, 'node_modules'), path.join(sourceRoot, 'node_modules'), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (source) => {
          const relativePath = path.relative(path.join(projectRoot, 'node_modules'), source);
          return !['.cache', '.vite', '.vitest-cache'].includes(relativePath.split(path.sep)[0]);
        },
      });
      const copied = compareInstalledLock(sourceRoot, sourceRoot);
      if (!copied.matches) throw new Error(`Copied dependency inventory does not match the lock: ${copied.reason}`);
      await runNpm(['ls', '--all', '--parseable'], sourceRoot, { quiet: true });
      return;
    } catch (error) {
      throwIfInterrupted();
      console.warn(`现有依赖树无法用于隔离构建，将尝试按锁文件安装：${error instanceof Error ? error.message : 'unknown error'}`);
      rmSync(path.join(sourceRoot, 'node_modules'), { recursive: true, force: true });
    }
  } else {
    console.log(`已安装依赖与锁文件不一致，将尝试在快照中安装：${comparison.reason}`);
  }
  console.log('按锁文件在快照中安装依赖。');
  await runNpm(['ci', '--prefer-offline', '--no-audit', '--no-fund'], sourceRoot);
}

async function runBuild(scriptName, sourceRoot = projectRoot) {
  console.log(`开始构建：npm run ${scriptName}`);
  await runNpm(['run', scriptName], sourceRoot);
}

async function runTests(sourceRoot, { runtime = false, changedChecks = [] } = {}) {
  const args = ['exec', '--', 'vitest', 'run'];
  const tests = new Set(runtime
    ? ['test/deploy-plan.test.ts', 'test/deploy-selection.test.ts', 'test/deploy-cli.test.ts', 'test/deploy-dependencies.test.ts', 'test/deploy-artifacts.test.ts', 'test/deploy-publish-web.test.ts', 'test/deploy-server.test.ts', 'test/deploy-systemd.test.ts', 'test/deploy-systemd-credentials.test.ts', 'test/deploy-systemd-recovery.test.ts', 'test/deploy-systemd-container-scope.test.ts',
      'test/server.test.ts', 'test/server-auth.test.ts', 'test/server-errors.test.ts',
      'test/store.test.ts', 'test/plugin-host-lifecycle.test.ts']
    : ['test/plugin-ui.test.ts', 'test/ui-contributions.test.ts', 'test/model-selection-ui.test.tsx']);
  let fullSuite = false;
  for (const check of changedChecks) {
    if (check.action !== 'run-tests') continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(check.path) && existsSync(path.join(sourceRoot, check.path))) tests.add(check.path);
    else fullSuite = true; // A changed helper, configuration, or deleted test can affect any suite.
  }
  if (!fullSuite) args.push(...tests);
  console.log(fullSuite ? '测试辅助文件发生变化，运行完整测试。' : runtime ? '运行 Runtime 与部署相关测试。' : '运行前端相关测试。');
  await runNpm(args, sourceRoot);
}

function installRuntimeArtifacts(sourceRoot) {
  const required = ['dist/server/server.js', 'dist/executor-agent.mjs'];
  for (const relativePath of required) {
    if (!existsSync(path.join(sourceRoot, relativePath))) throw new Error(`Missing built artifact: ${relativePath}`);
  }
  const serverTarget = path.join(projectRoot, 'dist/server');
  rmSync(serverTarget, { recursive: true, force: true });
  cpSync(path.join(sourceRoot, 'dist/server'), serverTarget, { recursive: true });
  cpSync(path.join(sourceRoot, 'dist/executor-agent.mjs'), path.join(projectRoot, 'dist/executor-agent.mjs'));
  const plugins = path.join(sourceRoot, 'plugins');
  for (const entry of readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const built = path.join(plugins, entry.name, 'runtime.mjs');
    if (!existsSync(built)) continue;
    const target = path.join(projectRoot, 'plugins', entry.name, 'runtime.mjs');
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(built, target);
  }
}

function buildArtifactPaths() {
  const paths = [
    'dist',
    'plugins/pico.chatgpt-plan/webui/build',
    'plugins/pico.openai-provider/webui/build',
    'plugins/pico.model-parameters/webui/build',
  ];
  const pluginsRoot = path.join(projectRoot, 'plugins');
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    paths.push(path.join('plugins', entry.name, 'runtime.mjs'));
  }
  return [...new Set(paths)];
}

function writeBackupManifest(backup, phase = backup.manifest.phase) {
  backup.manifest.phase = phase;
  const manifestPath = path.join(backup.backupRoot, manifestName);
  const temporaryPath = `${manifestPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(backup.manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, manifestPath);
}

function backupBuildArtifacts(pid, startTime) {
  const backupRoot = mkdtempSync(path.join(projectRoot, '.pico-deploy-backup-'));
  try {
    const entries = buildArtifactPaths().map((relativePath) => ({
      relativePath,
      existed: existsSync(path.join(projectRoot, relativePath)),
    }));
    for (const entry of entries) {
      if (!entry.existed) continue;
      const backupPath = path.join(backupRoot, entry.relativePath);
      mkdirSync(path.dirname(backupPath), { recursive: true });
      cpSync(path.join(projectRoot, entry.relativePath), backupPath, { recursive: true, preserveTimestamps: true });
    }
    chmodSync(backupRoot, 0o700);
    const backup = {
      backupRoot,
      manifest: { version: 1, phase: 'building', pid, startTime, entries },
    };
    writeBackupManifest(backup);
    return backup;
  } catch {
    rmSync(backupRoot, { recursive: true, force: true });
    throw new Error('Could not preserve the current build artifacts; the existing Runtime was left running.');
  }
}

function parseBackupManifest(backupRoot) {
  const manifestPath = path.join(backupRoot, manifestName);
  if (!existsSync(manifestPath)) {
    throw new Error(`Incomplete deployment backup at ${backupRoot}; inspect it before retrying.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Invalid deployment backup manifest at ${backupRoot}; inspect it before retrying.`);
  }
  const allowedPaths = new Set(buildArtifactPaths());
  if (
    manifest?.version !== 1 ||
    !['building', 'built', 'stopping', 'old-stopped', 'committed'].includes(manifest.phase) ||
    !Number.isSafeInteger(manifest.pid) ||
    typeof manifest.startTime !== 'string' ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== allowedPaths.size ||
    new Set(manifest.entries.map((entry) => entry?.relativePath)).size !== manifest.entries.length ||
    manifest.entries.some((entry) =>
      !allowedPaths.has(entry?.relativePath) ||
      typeof entry.existed !== 'boolean' ||
      (entry.existed && !existsSync(path.join(backupRoot, entry.relativePath))),
    )
  ) {
    throw new Error(`Invalid deployment backup contents at ${backupRoot}; inspect it before retrying.`);
  }
  return { backupRoot, manifest };
}

function restoreBuildArtifacts(backup, { discard = true } = {}) {
  for (const entry of backup.manifest.entries) {
    const targetPath = path.join(projectRoot, entry.relativePath);
    rmSync(targetPath, { recursive: true, force: true });
    if (entry.existed) {
      const backupPath = path.join(backup.backupRoot, entry.relativePath);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(backupPath, targetPath, { recursive: true, preserveTimestamps: true });
    }
  }
  if (discard) discardBuildBackup(backup);
}

function discardBuildBackup(backup) {
  if (backup) rmSync(backup.backupRoot, { recursive: true, force: true });
}

function recoverInterruptedBuilds() {
  const backups = readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(backupPrefix));
  for (const entry of backups) {
    const backupRoot = path.join(projectRoot, entry.name);
    if (!entry.isDirectory()) throw new Error(`Unexpected deployment backup path ${backupRoot}; inspect it before retrying.`);
    const backup = parseBackupManifest(backupRoot);
    if (backup.manifest.phase === 'committed') {
      discardBuildBackup(backup);
      continue;
    }
    if (backup.manifest.phase === 'building' || backup.manifest.phase === 'built') {
      const rows = listenerRows();
      const targetPid = backup.manifest.pid;
      const targetAddresses = [...new Set(rows.filter((row) => row.pids.includes(targetPid)).map((row) => row.address))];
      if (targetAddresses.length > 0 && isPicoProcess(targetPid, backup.manifest.startTime)) {
        assertNoConflictingListeners(rows, targetPid, targetAddresses);
        if (otherPicoListenerPids(rows, targetPid).length > 0) {
          throw new Error('Another Pico Runtime from this repository is running; refusing to restore artifacts beneath it.');
        }
        restoreBuildArtifacts(backup);
        console.log('已恢复上次中断构建前的产物；原 Runtime 仍在运行。');
        continue;
      }
    }
    throw new Error(
      `A previous deployment stopped in phase "${backup.manifest.phase}". Backup kept at ${backupRoot}; inspect the Runtime and artifacts before retrying.`,
    );
  }
}

async function waitForOldRuntimeExit(pid, expectedStartTime, targetAddresses) {
  const deadline = Date.now() + shutdownTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    const rows = listenerRows();
    assertAddressesUncontended(rows, pid, targetAddresses);
    const oldProcessStillPresent = isPicoProcess(pid, expectedStartTime);
    const oldListenerStillPresent = rows.some((row) => row.pids.includes(pid));
    if (!oldListenerStillPresent && !oldProcessStillPresent) return;
    await sleep(1000);
    throwIfInterrupted();
  }
  throw new Error(
    `The old Runtime did not exit within ${shutdownTimeoutSeconds} seconds. It was not force-stopped; close or reload its WebUI tab if needed, inspect active work, then retry.`,
  );
}

function launchRuntime(runtimeEnvironment) {
  let logFd;
  try {
    logFd = openSync(logPath, 'a', 0o600);
    chmodSync(logPath, 0o600);
    writeSync(logFd, `\n[${new Date().toISOString()}] Starting Pico Runtime from ${projectRoot}\n`);
    const child = spawn('/bin/bash', [runtimeLauncher, runtimeEnvironment.PICO_HOST || '127.0.0.1'], {
      cwd: projectRoot,
      env: runtimeEnvironment,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', () => {
      child.startError = true;
    });
    child.unref();
    return child;
  } catch {
    throw new Error(`Could not start the replacement Runtime. Review the service log at ${logPath}.`);
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }
}

async function waitForNewListener(oldPid, oldStartTime, child, targetAddresses) {
  const deadline = Date.now() + startupTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    const rows = listenerRows();
    const candidates = [...new Set(rows.flatMap((row) => row.pids).filter((pid) => isPicoProcess(pid)))];
    if (candidates.length > 1) throw new Error('Multiple Pico Runtime processes listen on the deployment port; inspect them before proceeding.');
    if (candidates.length === 1) {
      const pid = candidates[0];
      assertNoConflictingListeners(rows, pid, targetAddresses);
      const startTime = processStartTime(pid);
      if (pid !== oldPid || startTime !== oldStartTime) return { pid, startTime };
    }
    if (child && (child.startError || child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`The replacement Runtime exited during startup. Review the service log at ${logPath}.`);
    }
    await sleep(1000);
  }
  throw new Error(`No Runtime listener appeared within ${startupTimeoutSeconds} seconds. Review the service log at ${logPath}.`);
}

async function verifyWebUi(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/`);
  if (!response.ok) throw new Error(`The WebUI returned HTTP ${response.status}.`);
  await response.body?.cancel();
}

function availablePluginIds(root) {
  return readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, 'plugins', entry.name, 'webui', 'index.html')))
    .map((entry) => entry.name).sort();
}

function parseOptions(args) {
  const options = { plan: false, full: false, web: false, pluginIds: [], allPluginUis: false, checks: false, acceptWarnings: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--plugin-ui' || arg.startsWith('--plugin-ui=')) {
      const id = arg === '--plugin-ui' ? args[++i] : arg.slice('--plugin-ui='.length);
      if (!id || id.startsWith('--') || options.pluginIds.includes(id)) throw new Error('Provide a unique plugin ID after --plugin-ui.');
      options.pluginIds.push(id);
      continue;
    }
    const names = { '--plan': 'plan', '--full': 'full', '--web': 'web', '--all-plugin-uis': 'allPluginUis', '--checks': 'checks', '--accept-warnings': 'acceptWarnings' };
    const name = names[arg];
    if (!name || seen.has(arg)) throw new Error(`Unknown or repeated deployment option: ${arg}`);
    seen.add(arg);
    options[name] = true;
  }
  if (options.allPluginUis && options.pluginIds.length) throw new Error('Choose --all-plugin-uis or individual --plugin-ui options, not both.');
  return options;
}

function showDiagnostics(diagnostic, baseline) {
  if (!baseline) console.log('尚无可信发布清单，无法比较源码与已发布版本。');
  else {
    if (!diagnostic.targets.length) console.log('清单中没有已识别的发布源文件变化。');
    for (const target of diagnostic.targets) {
      console.log(`  差异 ${target.target}:`);
      for (const file of target.paths) console.log(`    ${file}`);
    }
    for (const check of diagnostic.changedChecks ?? []) console.log(`  检查文件变化 ${check.path}: ${check.action}`);
  }
  for (const item of diagnostic.unknownPaths ?? []) console.log(`  未分类 ${item.path}: ${item.reason}`);
  console.log('差异仅供核对；发布范围由调用者指定。');
}

function selectedPlan(selection, diagnostic, currentManifest, baseline) {
  const scope = selection.scope;
  const targetNames = scope.full ? Object.keys(currentManifest.targets).sort() : [
    ...(scope.mainWeb ? ['web'] : []), ...scope.pluginIds.map((id) => `plugin-ui:${id}`),
  ];
  return {
    scope,
    initialRelease: scope.full && !baseline,
    targets: targetNames.map((target) => ({ target })),
    changedChecks: diagnostic.changedChecks ?? [],
  };
}

function showSelection(selection) {
  const scope = selection.scope;
  if (scope.full) console.log('已选择：完整部署，需要等待任务空闲并确认停服。');
  else if (scope.checks) console.log('已选择：仅运行检查。');
  else console.log(`已选择：${[...(scope.mainWeb ? ['主 WebUI'] : []), ...scope.pluginIds.map((id) => `插件 UI ${id}`)].join('、')}；不重启 Runtime。`);
  for (const warning of selection.warnings) console.warn(`范围提示：${warning}`);
  for (const error of selection.errors) console.error(`无法执行：${error}`);
  if (selection.blocked && selection.warnings.length) console.warn('审查以上提示后，可显式加 --accept-warnings 继续；脚本不会改变所选范围。');
  else if (selection.warnings.length) console.warn('已按 --accept-warnings 接受范围提示，仍只执行明确选择的范围。');
}

function frontendPluginIds(sourceRoot, plan, full) {
  if (full) {
    return readdirSync(path.join(sourceRoot, 'plugins'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(sourceRoot, 'plugins', entry.name, 'webui', 'index.html')))
      .map((entry) => entry.name).sort();
  }
  return plan.targets.filter((target) => target.target.startsWith('plugin-ui:'))
    .map((target) => target.target.slice('plugin-ui:'.length));
}

function requireUnchangedPluginEntrypoints(snapshotManifest) {
  const liveManifest = buildReleaseManifest(projectRoot);
  const snapshotFiles = snapshotManifest.targets.runtime.files;
  const liveFiles = liveManifest.targets.runtime.files;
  const entries = new Set([...Object.keys(snapshotFiles), ...Object.keys(liveFiles)]
    .filter((file) => /^plugins\/[^/]+\.mjs$/.test(file)));
  if ([...entries].some((file) => snapshotFiles[file] !== liveFiles[file])) {
    throw new Error('A live plugin entrypoint changed after the source snapshot; retry the deployment.');
  }
}

async function verifyPublication(baseUrl, cookie, publication, pluginInfo) {
  const registered = registeredPluginWebUis(pluginInfo);
  for (const url of publication.urls) {
    const plugin = /^\/_pico\/plugin-ui\/([^/]+)\//.exec(url)?.[1];
    if (plugin && !registered.has(plugin)) continue; // Disabled plugins have no accessible route.
    const response = await fetchWithTimeout(`${baseUrl}${url}`, { headers: { cookie } });
    if (!response.ok) throw new Error(`Published resource ${url} returned HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') ?? '';
    if ((url === '/' || url.endsWith('.html')) && !contentType.includes('text/html')) {
      throw new Error(`Published resource ${url} has the wrong content type.`);
    }
    if (url.endsWith('.js') && !/(?:javascript|ecmascript)/i.test(contentType)) {
      throw new Error(`Published resource ${url} has the wrong content type.`);
    }
    if (url.endsWith('.css') && !contentType.includes('text/css')) {
      throw new Error(`Published resource ${url} has the wrong content type.`);
    }
    const digest = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    if (digest !== publication.hashes[url]) throw new Error(`Published resource ${url} does not match its build.`);
  }
}

function updateBaseline(current, previous, plan, full, identity, publication) {
  const targets = full ? current.targets : { ...previous.targets };
  if (!full) for (const target of plan.targets) targets[target.target] = current.targets[target.target];
  const publishedAssets = full ? {} : { ...(previous.publishedAssets ?? {}) };
  if (plan.targets.some((target) => target.target === 'web') || full) publishedAssets.web = {};
  for (const pluginId of publication.pluginIds) publishedAssets[`plugin-ui:${pluginId}`] = {};
  for (const url of publication.urls) {
    const plugin = /^\/_pico\/plugin-ui\/([^/]+)\//.exec(url)?.[1];
    const group = plugin ? `plugin-ui:${plugin}` : 'web';
    publishedAssets[group] ??= {};
    publishedAssets[group][url] = publication.hashes[url];
  }
  return {
    ...current,
    targets,
    publishedAssets,
    runtimeArtifacts: full ? runtimeArtifactHashes(projectRoot) : previous.runtimeArtifacts,
    runtimeIdentity: identity,
    webReleaseId: publication.sharedReleaseId,
    publishedAt: new Date().toISOString(),
  };
}

async function deploy(plan, currentManifest, baseline, sourceRoot) {
  const full = plan.scope.full;
  const mainWeb = full || plan.scope.mainWeb;
  const pluginIds = frontendPluginIds(sourceRoot, plan, full);
  const releaseId = `${Date.now()}-${randomUUID()}`;
  const currentRows = listenerRows();
  const currentPids = [...new Set(currentRows.flatMap((row) => row.pids))];
  const picoPids = currentPids.filter((pid) => isPicoProcess(pid));
  if (picoPids.length !== 1) {
    throw new Error(`Expected one verifiable Pico listener on port ${port}, found ${picoPids.length}; no process was changed.`);
  }
  const oldPid = picoPids[0];
  const runtimeAddresses = [...new Set(currentRows.filter((row) => row.pids.includes(oldPid)).map((row) => row.address))];
  assertNoConflictingListeners(currentRows, oldPid, runtimeAddresses);
  const oldStartTime = processStartTime(oldPid);
  if (!isPicoProcess(oldPid, oldStartTime)) {
    throw new Error('The listener changed while it was being inspected; no process was changed.');
  }

  const runtimeEnvironment = readProcessEnvironment(oldPid);
  const token = runtimeEnvironment.PICO_ACCESS_TOKEN;
  if (!token || Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('The current Runtime does not expose a usable PICO_ACCESS_TOKEN; no process was stopped.');
  }
  const runtimePort = runtimeEnvironment.PICO_PORT || '4173';
  if (Number(runtimePort) !== port) {
    throw new Error(`The live Runtime uses port ${runtimePort}; set PICO_DEPLOY_PORT to that port and retry.`);
  }
  if (!runtimeEnvironment.PATH) throw new Error('The live Runtime environment has no PATH; refusing to deploy.');
  const systemdContext = getSystemdContext(oldPid, runtimeEnvironment);
  let transientSystemdUnit = false;
  if (full && systemdContext) {
    verifyRestartableSystemdUnit(systemdContext);
    verifySystemdTokenSource(systemdContext, token);
    transientSystemdUnit = systemdShow(systemdContext, 'Transient') === 'yes';
  }
  if (runtimeEnvironment.PICO_PLUGIN_DIR && path.resolve(projectRoot, runtimeEnvironment.PICO_PLUGIN_DIR) !== path.join(projectRoot, 'plugins') && (full || pluginIds.length)) {
    throw new Error('This Runtime uses a custom plugin directory; automatic plugin deployment does not manage that directory.');
  }
  if (!full && (baseline?.runtimeIdentity?.pid !== oldPid || baseline?.runtimeIdentity?.startTime !== oldStartTime)) {
    throw new Error('The running Runtime does not match the verified deployment baseline; perform a complete deployment to establish it again.');
  }
  if (!full && (!baseline.runtimeArtifacts || !isDeepStrictEqual(runtimeArtifactHashes(projectRoot), baseline.runtimeArtifacts))) {
    throw new Error('Runtime artifacts differ from the verified deployment baseline; perform a complete deployment to establish it again.');
  }
  if (!full && !mainWeb && !baseline?.webReleaseId) {
    throw new Error('The deployed WebUI release is unknown; a complete deployment is required.');
  }

  const baseUrl = await apiBaseUrl(runtimeEnvironment);
  let oldSession;
  let newSession;
  let artifactBackup;
  let publication;
  let publicationCommitted = false;
  let publicationSucceeded = false;
  let oldProcessStopped = false;
  let unitReference;
  try {
    if (transientSystemdUnit) {
      unitReference = await acquireSystemdUnitReference(systemdContext);
      await unitReference.check();
    }
    oldSession = await createSession(baseUrl, token);
    await verifyWorkspace(baseUrl, oldSession);
    await verifyWebUi(baseUrl);
    const initialHealth = await getJson(baseUrl, oldSession, '/api/health');
    if (initialHealth?.ok !== true) throw new Error('The current Runtime health check did not return ok.');
    if (full) {
      const currentPlugins = await getJson(baseUrl, oldSession, '/api/plugins');
      if (!Array.isArray(currentPlugins?.errors)) throw new Error('The current Runtime returned invalid plugin status.');
      if (currentPlugins.errors.length > 0) {
        throw new Error(`The current Runtime already reports ${currentPlugins.errors.length} plugin load issue(s); resolve them before replacement.`);
      }
    }
    if (!full) {
      if (!baseline.publishedAssets?.web?.['/']) throw new Error('The current WebUI release has no verified asset baseline; perform a complete deployment.');
      const hashes = Object.assign({}, ...Object.values(baseline.publishedAssets));
      const pluginInfo = await getJson(baseUrl, oldSession, '/api/plugins');
      await verifyPublication(baseUrl, oldSession, { urls: Object.keys(hashes), hashes }, pluginInfo);
    }
    console.log(`目标 Runtime 已确认：${runtimeEnvironment.PICO_HOST || '127.0.0.1'}:${port}（PID ${oldPid}）。`);

    console.log('在隔离的源码快照中构建和检查；运行中的任务可以继续。');
    await installSnapshotDependencies(sourceRoot);
    const checkActions = new Set((plan.initialRelease ? [] : plan.changedChecks ?? []).map((check) => check.action));
    if (checkActions.has('run-lint')) await runBuild('lint', sourceRoot);
    if (full) {
      await runBuild('build', sourceRoot);
      await runTests(sourceRoot, { runtime: true, changedChecks: plan.initialRelease ? [] : plan.changedChecks });
    } else {
      await runBuild('typecheck', sourceRoot);
      if (mainWeb) await runBuild('build:webui', sourceRoot);
      if (pluginIds.length) await runBuild('build:plugins:ui', sourceRoot);
      if (checkActions.has('run-tests')) await runBuild('plugins:build', sourceRoot);
      await runTests(sourceRoot, { changedChecks: plan.changedChecks });
    }
    throwIfInterrupted();
    publication = await prepareWebPublication({
      sourceRoot,
      targetRoot: projectRoot,
      releaseId,
      scope: { mainWeb, pluginIds },
      sharedReleaseId: mainWeb ? releaseId : baseline.webReleaseId,
    });
    requirePicoListener(oldPid, oldStartTime);
    throwIfInterrupted();
    if (!full) {
      await publication.commit();
      publicationCommitted = true;
      const pluginInfo = await getJson(baseUrl, oldSession, '/api/plugins');
      await verifyPublication(baseUrl, oldSession, publication, pluginInfo);
      const health = await getJson(baseUrl, oldSession, '/api/health');
      if (health?.ok !== true) throw new Error('Runtime health check failed after WebUI publication.');
      requirePicoListener(oldPid, oldStartTime);
      throwIfInterrupted();
      writeReleaseBaseline(releaseBaselinePath, updateBaseline(currentManifest, baseline, plan, false, { pid: oldPid, startTime: oldStartTime }, publication));
      publicationSucceeded = true;
      console.log(`前端发布完成：${releaseId}，Runtime PID ${oldPid} 未变化。`);
      return;
    }

    await waitForIdle(baseUrl, oldSession);
    throwIfInterrupted();
    requirePicoListener(oldPid, oldStartTime);
    await verifyWorkspace(baseUrl, oldSession);
    await confirmRestart();
    throwIfInterrupted();
    requirePicoListener(oldPid, oldStartTime);
    const lastActiveCount = await getActiveThreadCount(baseUrl, oldSession);
    if (lastActiveCount !== 0) {
      throw new Error(`${lastActiveCount} Thread(s) became active before shutdown; the Runtime is still running.`);
    }

    console.log('构建已完成；准备保留当前产物并替换 Runtime。');
    artifactBackup = backupBuildArtifacts(oldPid, oldStartTime);

    await confirmNoInFlightCommands();
    throwIfInterrupted();
    requirePicoListener(oldPid, oldStartTime);
    const finalActiveCount = await getActiveThreadCount(baseUrl, oldSession);
    if (finalActiveCount !== 0) {
      throw new Error(`${finalActiveCount} Thread(s) became active before shutdown; current artifacts will be restored.`);
    }
    requireUnchangedPluginEntrypoints(currentManifest);
    if (systemdContext) {
      verifyRestartableSystemdUnit(systemdContext);
      verifySystemdTokenSource(systemdContext, token);
      if ((systemdShow(systemdContext, 'Transient') === 'yes') !== transientSystemdUnit) {
        throw new Error('The systemd unit type changed during deployment; no Runtime was stopped.');
      }
      if (unitReference) await unitReference.check();
      const isolatedProcesses = isolateRuntimeContainerProcesses(systemdContext, oldPid, oldStartTime);
      if (isolatedProcesses > 0) {
        console.log(`已将 ${isolatedProcesses} 个已核验的 Container 辅助进程移入独立 scope。`);
      }
      const postIsolationActiveCount = await getActiveThreadCount(baseUrl, oldSession);
      if (postIsolationActiveCount !== 0) {
        throw new Error(`${postIsolationActiveCount} Thread(s) became active during Container isolation; the Runtime is still running.`);
      }
      requirePicoListener(oldPid, oldStartTime);
      if (unitReference) await unitReference.check();
    }

    await revokeSession(baseUrl, oldSession, true);
    oldSession = undefined;

    console.log('向当前 Runtime 发送 SIGTERM，并等待其完成有序关闭。');
    requirePicoListener(oldPid, oldStartTime);
    writeBackupManifest(artifactBackup, 'stopping');
    throwIfInterrupted();
    shutdownStarted = true;
    if (systemdContext) {
      console.log(`通过 systemd 单元 ${systemdContext.unit} 停止 Runtime。`);
      try {
        await controlSystemdUnit(systemdContext, 'stop');
        await waitForOldRuntimeExit(oldPid, oldStartTime, runtimeAddresses);
        oldProcessStopped = true;
      } catch (error) {
        oldProcessStopped = true;
        try {
          oldProcessStopped = !(listenerPids().includes(oldPid) && isPicoProcess(oldPid, oldStartTime));
        } catch {
          // Unknown service state must keep the backup for manual recovery.
        }
        throw error;
      }
    } else {
      try {
        process.kill(oldPid, 'SIGTERM');
        await waitForOldRuntimeExit(oldPid, oldStartTime, runtimeAddresses);
        oldProcessStopped = true;
      } catch (error) {
        oldProcessStopped = true;
        try {
          oldProcessStopped = !(listenerPids().includes(oldPid) && isPicoProcess(oldPid, oldStartTime));
        } catch {
          // Unknown service state must keep the backup for manual recovery.
        }
        throw error;
      }
    }
    writeBackupManifest(artifactBackup, 'old-stopped');

    if (unitReference) await unitReference.check();
    installRuntimeArtifacts(sourceRoot);
    await publication.commit();
    publicationCommitted = true;
    if (unitReference) await unitReference.check();
    if (systemdContext) await controlSystemdUnit(systemdContext, 'start');
    const child = systemdContext ? undefined : launchRuntime(runtimeEnvironment);
    const replacement = await waitForNewListener(oldPid, oldStartTime, child, runtimeAddresses);
    requirePicoListener(replacement.pid, replacement.startTime);
    if (systemdContext && readProcessEnvironment(replacement.pid).PICO_ACCESS_TOKEN !== token) {
      throw new Error('The restarted systemd Runtime did not inherit the existing access token; backup retained for recovery.');
    }
    newSession = await createSession(baseUrl, token);
    await verifyWebUi(baseUrl);
    const health = await getJson(baseUrl, newSession, '/api/health');
    if (health?.ok !== true) throw new Error('The replacement Runtime health check did not return ok.');
    await verifyWorkspace(baseUrl, newSession);
    const pluginInfo = await getJson(baseUrl, newSession, '/api/plugins');
    if (!Array.isArray(pluginInfo?.errors)) throw new Error('The replacement Runtime returned invalid plugin status.');
    if (pluginInfo.errors.length > 0) throw new Error(`The replacement Runtime reports ${pluginInfo.errors.length} plugin load issue(s); the release baseline was not updated.`);
    requireUnchangedPluginEntrypoints(currentManifest);
    await verifyPublication(baseUrl, newSession, publication, pluginInfo);
    await revokeSession(baseUrl, newSession);
    newSession = undefined;
    writeReleaseBaseline(releaseBaselinePath, updateBaseline(currentManifest, baseline, plan, true, replacement, publication));
    publicationSucceeded = true;
    writeBackupManifest(artifactBackup, 'committed');
    discardBuildBackup(artifactBackup);
    artifactBackup = undefined;
    console.log(`部署完成：Runtime PID ${replacement.pid}，WebUI 与认证健康检查通过。日志：${logPath}`);
    if (receivedSignal) console.log(`部署期间收到 ${receivedSignal}；为避免服务停在中间状态，已完成替换。`);
  } catch (error) {
    // If replacement failed before a new listener appeared, restore the saved
    // artifacts and try to restart the still-pinned unit. Never overwrite
    // artifacts beneath a running replacement process.
    if (oldProcessStopped && artifactBackup && systemdContext) {
      try {
        await recoverStoppedSystemdUnit({
          readState: () => ({
            listenerPids: (() => {
              const rows = listenerRows();
              const otherPids = otherPicoListenerPids(rows, oldPid);
              return [...new Set([...listenerPidsConflictingWithAddresses(rows, runtimeAddresses), ...otherPids])];
            })(),
            oldProcessAlive: isPicoProcess(oldPid, oldStartTime),
            activeState: systemdShow(systemdContext, 'ActiveState'),
          }),
          assertStopped: async () => { if (unitReference) await unitReference.check(); },
          restore: () => restoreBuildArtifacts(artifactBackup, { discard: false }),
          start: () => controlSystemdUnit(systemdContext, 'start'),
          verify: async () => {
            const recovered = await waitForNewListener(oldPid, oldStartTime, undefined, runtimeAddresses);
            requirePicoListener(recovered.pid, recovered.startTime);
            if (readProcessEnvironment(recovered.pid).PICO_ACCESS_TOKEN !== token) throw new Error('Recovered Runtime token mismatch.', { cause: error });
            const recoverySession = await createSession(baseUrl, token);
            try {
              const health = await getJson(baseUrl, recoverySession, '/api/health');
              if (health?.ok !== true) throw new Error('Recovered Runtime health check failed.', { cause: error });
              await verifyWorkspace(baseUrl, recoverySession);
            } finally {
              await revokeSession(baseUrl, recoverySession);
            }
          },
        });
        console.error('新版本未完成部署；已尝试恢复旧产物并确认 Runtime 健康，备份仍保留供核对。');
      } catch {
        console.error('自动恢复未完成；旧构建备份已保留，请检查服务及备份。');
      }
    }
    throw error;
  } finally {
    if (publication && publicationCommitted && !publicationSucceeded && !oldProcessStopped) {
      await publication.rollback().catch(() => console.error('Could not roll back WebUI entrypoints.'));
    }
    if (artifactBackup) {
      try {
        if (oldProcessStopped) {
          console.error(`部署未完成，旧构建备份已保留：${artifactBackup.backupRoot}`);
        } else {
          // Full-deployment runtime artifacts are installed only after the old
          // process exits. Re-copying the backup here would disrupt live files.
          discardBuildBackup(artifactBackup);
        }
      } catch {
        console.error('Could not restore or clean up the temporary build backup; inspect .pico-deploy-backup-* in the project root.');
      }
    }
    if (oldSession) await revokeSession(baseUrl, oldSession);
    if (newSession) await revokeSession(baseUrl, newSession);
    if (publication && !publicationCommitted) {
      await publication.cleanupPrepared().catch(() => console.error('Could not remove an uncommitted WebUI release.'));
    }
    if (unitReference) await unitReference.release().catch(() => console.error('Could not cleanly release the systemd unit reference.'));
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const plugins = availablePluginIds(projectRoot);
  if (options.allPluginUis) options.pluginIds = plugins;
  const hasScope = options.full || options.web || options.pluginIds.length > 0 || options.checks;
  if (options.plan && !hasScope) {
    const baseline = readReleaseBaseline(releaseBaselinePath);
    const currentManifest = buildReleaseManifest(projectRoot);
    const diagnostic = diagnoseChanges({ currentManifest, baselineManifest: baseline });
    showDiagnostics(diagnostic, baseline);
    return;
  }
  if (!hasScope) throw new Error('Explicitly select --full, --web, --plugin-ui=<id>, --all-plugin-uis, or --checks.');
  if (options.plan) {
    const currentManifest = buildReleaseManifest(projectRoot);
    const baseline = readReleaseBaseline(releaseBaselinePath);
    const diagnostic = diagnoseChanges({ currentManifest, baselineManifest: baseline });
    showDiagnostics(diagnostic, baseline);
    const selection = selectDeploymentScope({ options, currentManifest, baselineManifest: baseline, availablePluginIds: plugins });
    showSelection(selection);
    if (selection.blocked) process.exitCode = 1;
    return;
  }
  const lock = acquireDeploymentLock();
  let snapshot;
  try {
    recoverInterruptedBuilds();
    const currentManifest = buildReleaseManifest(projectRoot);
    const baseline = readReleaseBaseline(releaseBaselinePath);
    const diagnostic = diagnoseChanges({ currentManifest, baselineManifest: baseline });
    showDiagnostics(diagnostic, baseline);
    const selection = selectDeploymentScope({ options, currentManifest, baselineManifest: baseline, availablePluginIds: plugins });
    showSelection(selection);
    if (selection.blocked) throw new Error('The selected scope needs review before it can be executed.');
    const plan = selectedPlan(selection, diagnostic, currentManifest, baseline);
    snapshot = await createSourceSnapshot(projectRoot);
    const snapshotManifest = buildReleaseManifest(snapshot);
    const comparable = (manifest) => ({
      targets: Object.fromEntries(Object.entries(manifest.targets).map(([target, value]) => [target, value.files])),
      checks: manifest.checks.files,
      unknownPaths: manifest.unknownPaths,
    });
    if (!isDeepStrictEqual(comparable(snapshotManifest), comparable(currentManifest))) {
      throw new Error('Source files changed while the deployment snapshot was created; retry deployment.');
    }
    if (plan.scope.checks) {
      await installSnapshotDependencies(snapshot);
      await runBuild('typecheck', snapshot);
      await runBuild('plugins:build', snapshot);
      await runNpm(['exec', '--', 'vitest', 'run'], snapshot);
      console.log('检查完成，无需发布。');
      return;
    }
    await deploy(plan, snapshotManifest, baseline, snapshot);
  } finally {
    try {
      if (snapshot) await removeSourceSnapshot(snapshot);
    } finally {
      releaseDeploymentLock(lock);
    }
  }
}

main().catch((error) => {
  console.error(`部署未完成：${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
