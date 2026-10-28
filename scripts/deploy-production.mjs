#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
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

const projectRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const runtimeLauncher = path.join(projectRoot, 'scripts/start-runtime.sh');
const defaultLogPath = '/tmp/pico-runtime-production.log';
const lockPath = path.join(projectRoot, '.pico-deploy.lock');
const backupPrefix = '.pico-deploy-backup-';
const manifestName = 'manifest.json';
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
      throw new Error('Another deployment may be running, or .pico-deploy.lock is stale. Verify its PID before removing it.');
    }
    throw new Error('Could not create the deployment lock in the project root.');
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

function listenerPids() {
  const result = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('Cannot inspect the listener. Run this script on the deployment host with permission to inspect it.');
  }
  return [...new Set([...result.stdout.matchAll(/\bpid=(\d+)/g)].map((match) => Number(match[1])))];
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
    throw new Error(`Cannot verify process ${pid}; run as the Runtime owner and retry.`);
  }
}

function requirePicoListener(expectedPid, expectedStartTime) {
  const pids = listenerPids();
  if (
    pids.length !== 1 ||
    pids[0] !== expectedPid ||
    !isPicoProcess(expectedPid, expectedStartTime)
  ) {
    throw new Error(
      `Port ${port} is no longer owned by the verified Pico Runtime from this repository; refusing to stop or replace it.`,
    );
  }
}

function normalizedAddress(address) {
  const unscoped = address.split('%', 1)[0].toLowerCase();
  return unscoped.startsWith('::ffff:') ? unscoped.slice('::ffff:'.length) : unscoped;
}

async function apiBaseUrl(runtimeEnvironment) {
  const bindHost = runtimeEnvironment.PICO_HOST || '127.0.0.1';
  let connectHost = bindHost;
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
  if (systemdShow(context, 'EnvironmentFiles')) {
    throw new Error('The systemd unit uses EnvironmentFiles; verify its token source and restart it through that unit.');
  }
  const unsetEnvironment = systemdShow(context, 'UnsetEnvironment').split(/\s+/);
  if (unsetEnvironment.some((entry) => entry === '*' || entry === 'PICO_ACCESS_TOKEN' || entry.startsWith('PICO_ACCESS_TOKEN='))) {
    throw new Error('The systemd unit removes PICO_ACCESS_TOKEN with UnsetEnvironment; no process was stopped.');
  }
  const configuredEnvironment = systemdShow(context, 'Environment').split(/\s+/);
  if (!configuredEnvironment.includes(`PICO_ACCESS_TOKEN=${token}`)) {
    throw new Error('The systemd unit does not contain the current Runtime token; no process was stopped.');
  }
  if (systemdShow(context, 'ExecStart').includes(token)) {
    throw new Error('The systemd unit appears to pass a credential in ExecStart; refusing to expose it further.');
  }
}

async function restartSystemdUnit(context) {
  await new Promise((resolve, reject) => {
    const child = spawn('systemctl', [...context.args, 'restart', context.unit], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => reject(new Error(`Could not start the systemd restart for ${context.unit}.`)));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`systemd could not restart ${context.unit}; inspect the unit and deployment state.`));
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
  if (!Array.isArray(threads)) throw new Error('The Runtime returned an invalid Thread list; refusing to restart.');
  const validStates = new Set(['idle', 'paused', 'running', 'pausing']);
  for (const thread of threads) {
    if (!validStates.has(thread?.state)) {
      throw new Error('The Runtime returned an unknown Thread state; refusing to restart.');
    }
  }
  const activeThreadIds = new Set(
    threads
      .filter((thread) => thread.state === 'running' || thread.state === 'pausing')
      .map((thread) => thread.id),
  );
  const pausedThreads = threads.filter((thread) => thread.state === 'paused');
  for (let index = 0; index < pausedThreads.length; index += 8) {
    const page = pausedThreads.slice(index, index + 8);
    const snapshots = await Promise.all(
      page.map((thread) => {
        if (typeof thread.id !== 'string' || !thread.id) {
          throw new Error('The Runtime returned a Thread without an ID; refusing to restart.');
        }
        return getJson(baseUrl, cookie, `/api/threads/${encodeURIComponent(thread.id)}`);
      }),
    );
    for (const [pageIndex, snapshot] of snapshots.entries()) {
      if (!Array.isArray(snapshot?.executions)) {
        throw new Error('The Runtime returned an invalid execution snapshot; refusing to restart.');
      }
      if (snapshot.executions.some((execution) => execution.status === 'pending' || execution.status === 'running')) {
        activeThreadIds.add(page[pageIndex].id);
      }
    }
  }
  return activeThreadIds.size;
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

function runBuild(scriptName) {
  console.log(`开始构建：npm run ${scriptName}`);
  const buildEnvironment = { ...process.env };
  delete buildEnvironment.PICO_ACCESS_TOKEN;
  const result = spawnSync('npm', ['run', scriptName], {
    cwd: projectRoot,
    env: buildEnvironment,
    stdio: 'inherit',
  });
  throwIfInterrupted();
  if (result.error) throw new Error(`Could not start npm run ${scriptName}.`);
  if (result.status !== 0) throw new Error(`npm run ${scriptName} failed; the existing Runtime was left running.`);
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
      const pids = listenerPids();
      if (
        pids.length === 1 &&
        pids[0] === backup.manifest.pid &&
        isPicoProcess(backup.manifest.pid, backup.manifest.startTime)
      ) {
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

async function waitForOldRuntimeExit(pid, expectedStartTime) {
  const deadline = Date.now() + shutdownTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    const pids = listenerPids();
    if (pids.some((listenerPid) => listenerPid !== pid)) {
      throw new Error('Another process acquired the deployment port during shutdown; no replacement was started.');
    }
    const oldProcessStillPresent = isPicoProcess(pid, expectedStartTime);
    if (pids.length === 0 && !oldProcessStillPresent) return;
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

async function waitForNewListener(oldPid, oldStartTime, child) {
  const deadline = Date.now() + startupTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    const pids = listenerPids();
    if (pids.length > 0) {
      if (pids.length !== 1 || !isPicoProcess(pids[0])) {
        throw new Error(`Port ${port} was acquired by an unexpected process; inspect it before proceeding.`);
      }
      const pid = pids[0];
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

async function deploy() {
  const currentPids = listenerPids();
  if (currentPids.length !== 1) {
    throw new Error(`Expected one visible listener on port ${port}, found ${currentPids.length}; no process was changed.`);
  }
  const oldPid = currentPids[0];
  if (!isPicoProcess(oldPid)) {
    throw new Error(`The listener on port ${port} is not the Pico Runtime from ${projectRoot}; no process was changed.`);
  }
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
  if (!runtimeEnvironment.PATH) throw new Error('The live Runtime environment has no PATH; refusing to replace it.');
  const systemdContext = getSystemdContext(oldPid, runtimeEnvironment);
  if (systemdContext) verifySystemdTokenSource(systemdContext, token);

  const baseUrl = await apiBaseUrl(runtimeEnvironment);
  let oldSession;
  let newSession;
  let artifactBackup;
  let oldProcessStopped = false;
  try {
    oldSession = await createSession(baseUrl, token);
    await verifyWorkspace(baseUrl, oldSession);
    await verifyWebUi(baseUrl);
    const initialHealth = await getJson(baseUrl, oldSession, '/api/health');
    if (initialHealth?.ok !== true) throw new Error('The current Runtime health check did not return ok.');
    console.log(`目标 Runtime 已确认：${runtimeEnvironment.PICO_HOST || '127.0.0.1'}:${port}（PID ${oldPid}）。`);

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

    console.log('开始构建；构建失败时会恢复当前服务正在使用的构建产物。');
    artifactBackup = backupBuildArtifacts(oldPid, oldStartTime);
    try {
      throwIfInterrupted();
      runBuild('build');
      runBuild('plugins:build:chatgpt');
      requirePicoListener(oldPid, oldStartTime);
      const activeAfterBuild = await getActiveThreadCount(baseUrl, oldSession);
      throwIfInterrupted();
      if (activeAfterBuild !== 0) {
        throw new Error(`${activeAfterBuild} Thread(s) became active during the build; current artifacts will be restored.`);
      }
      writeBackupManifest(artifactBackup, 'built');
    } catch (error) {
      restoreBuildArtifacts(artifactBackup);
      artifactBackup = undefined;
      throw error;
    }

    await confirmNoInFlightCommands();
    throwIfInterrupted();
    requirePicoListener(oldPid, oldStartTime);
    const finalActiveCount = await getActiveThreadCount(baseUrl, oldSession);
    if (finalActiveCount !== 0) {
      throw new Error(`${finalActiveCount} Thread(s) became active before shutdown; current artifacts will be restored.`);
    }

    await revokeSession(baseUrl, oldSession, true);
    oldSession = undefined;

    console.log('向当前 Runtime 发送 SIGTERM，并等待其完成有序关闭。');
    requirePicoListener(oldPid, oldStartTime);
    writeBackupManifest(artifactBackup, 'stopping');
    throwIfInterrupted();
    shutdownStarted = true;
    if (systemdContext) {
      console.log(`通过 systemd 单元 ${systemdContext.unit} 重启 Runtime。`);
      try {
        await restartSystemdUnit(systemdContext);
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
      process.kill(oldPid, 'SIGTERM');
      await waitForOldRuntimeExit(oldPid, oldStartTime);
      oldProcessStopped = true;
    }
    writeBackupManifest(artifactBackup, 'old-stopped');

    throwIfInterrupted();
    const child = systemdContext ? undefined : launchRuntime(runtimeEnvironment);
    const replacement = await waitForNewListener(oldPid, oldStartTime, child);
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
    if (pluginInfo.errors.length > 0) {
      console.warn(`Runtime is healthy, but plugin status reports ${pluginInfo.errors.length} load issue(s).`);
    }
    await revokeSession(baseUrl, newSession);
    newSession = undefined;
    writeBackupManifest(artifactBackup, 'committed');
    discardBuildBackup(artifactBackup);
    artifactBackup = undefined;
    console.log(`部署完成：Runtime PID ${replacement.pid}，WebUI 与认证健康检查通过。日志：${logPath}`);
    if (receivedSignal) console.log(`部署期间收到 ${receivedSignal}；为避免服务停在中间状态，已完成替换。`);
  } finally {
    if (artifactBackup) {
      try {
        if (oldProcessStopped) {
          console.error(`部署未完成，旧构建备份已保留：${artifactBackup.backupRoot}`);
        } else {
          restoreBuildArtifacts(artifactBackup);
        }
      } catch {
        console.error('Could not restore or clean up the temporary build backup; inspect .pico-deploy-backup-* in the project root.');
      }
    }
    if (oldSession) await revokeSession(baseUrl, oldSession);
    if (newSession) await revokeSession(baseUrl, newSession);
  }
}

async function main() {
  const lock = acquireDeploymentLock();
  try {
    recoverInterruptedBuilds();
    await deploy();
  } finally {
    releaseDeploymentLock(lock);
  }
}

main().catch((error) => {
  console.error(`部署未完成：${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
