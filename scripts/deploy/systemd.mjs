import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SYSTEMD_REF_HELPER = fileURLToPath(new URL('./systemd-ref.py', import.meta.url));
const HANDSHAKE_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 3_000;
const EXIT_TIMEOUT_MS = 3_000;

export function assertRestartableSystemdUnit(context, readProperty, isUnitFile) {
  if (!context?.supported) {
    throw new Error('This systemd unit type cannot be safely restarted; no Runtime was stopped.');
  }

  const transient = readProperty('Transient');
  if (!['yes', 'no'].includes(transient)) {
    throw new Error(`Systemd unit ${context.unit} has an unverified persistence mode; no Runtime was stopped.`);
  }

  const loadState = readProperty('LoadState');
  const canStart = readProperty('CanStart');
  if (loadState !== 'loaded' || canStart !== 'yes') {
    throw new Error(`Systemd unit ${context.unit} is not loaded and startable; no Runtime was stopped.`);
  }

  if (transient === 'yes') return;

  const fragment = readProperty('FragmentPath');
  if (!path.isAbsolute(fragment) || !isUnitFile(fragment)) {
    throw new Error(
      `Systemd unit ${context.unit} does not have a verified reloadable unit file; no Runtime was stopped.`,
    );
  }
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function waitForAnyExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function stopHelper(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let exit = waitForAnyExit(child);
  child.kill('SIGTERM');
  try {
    await withTimeout(exit, EXIT_TIMEOUT_MS, 'The systemd reference helper did not exit.');
  } catch {
    exit = waitForAnyExit(child);
    child.kill('SIGKILL');
    await withTimeout(exit, EXIT_TIMEOUT_MS, 'The systemd reference helper could not be stopped.').catch(() => {});
  }
}

export async function acquireSystemdUnitReference(
  context,
  { pythonExecutable = 'python3', helperPath = SYSTEMD_REF_HELPER, spawnProcess = spawn } = {},
) {
  if (!context?.supported || typeof context.unit !== 'string' || !context.unit) {
    throw new Error('Cannot pin an unsupported systemd unit.');
  }

  // Pass only the bus location needed by the helper. In particular, never
  // inherit the Runtime environment, which may contain PICO_ACCESS_TOKEN.
  const helperEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const userManager = context.args?.includes('--user');
  if (userManager && process.env.XDG_RUNTIME_DIR) {
    helperEnvironment.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  }

  const child = spawnProcess(pythonExecutable, [helperPath, userManager ? '--user' : '--system', context.unit], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: helperEnvironment,
  });
  // A helper can disappear between a liveness check and a write; handle the
  // stream error through the write callback instead of crashing the deployer.
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  let wake;
  let exited;
  let observedExit;
  const exitPromise = new Promise((resolve) => {
    exited = resolve;
  });
  lines.on('line', (line) => {
    pending.push(line);
    wake?.();
    wake = undefined;
  });
  child.once('exit', (code, signal) => {
    observedExit = { code, signal };
    exited(observedExit);
    wake?.();
    wake = undefined;
  });
  child.once('error', () => {
    observedExit = { code: null, signal: 'spawn-error' };
    exited(observedExit);
    wake?.();
    wake = undefined;
  });

  const readLine = async (timeout, description) => {
    const response = await withTimeout(
      (async () => {
        while (!pending.length) {
          const exit = await Promise.race([
            new Promise((resolve) => {
              wake = resolve;
            }),
            exitPromise,
          ]);
          if (exit) throw new Error(`The systemd reference helper exited during ${description}.`);
        }
        return pending.shift();
      })(),
      timeout,
      `Timed out ${description} with the systemd reference helper.`,
    );
    return response;
  };

  const writeLine = (line) =>
    new Promise((resolve, reject) => {
      child.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });

  try {
    const ready = await readLine(HANDSHAKE_TIMEOUT_MS, 'acquiring the unit reference');
    if (ready !== 'READY') throw new Error('The systemd reference helper could not acquire the unit reference.');
  } catch {
    await stopHelper(child);
    lines.close();
    throw new Error('Cannot acquire a D-Bus reference to the systemd unit; no Runtime was stopped.');
  }

  let released = false;
  const request = async (command, expected) => {
    if (released) throw new Error('The systemd unit reference has been released.');
    if (observedExit) throw new Error('The systemd reference helper exited while the unit was pinned.');
    await writeLine(command);
    const response = await readLine(RESPONSE_TIMEOUT_MS, `waiting for ${command}`);
    if (response !== expected) throw new Error('The systemd reference helper returned an invalid response.');
  };

  return {
    async check() {
      await request('PING', 'PONG');
      return true;
    },
    async release() {
      if (released) return;
      try {
        await request('RELEASE', 'RELEASED');
        child.stdin.end();
        const exit = await withTimeout(
          observedExit ? Promise.resolve(observedExit) : exitPromise,
          EXIT_TIMEOUT_MS,
          'The systemd reference helper did not exit.',
        );
        if (exit.code !== 0) {
          throw new Error('The systemd reference helper exited unexpectedly after release.');
        }
      } finally {
        released = true;
        lines.close();
        await stopHelper(child);
      }
    },
  };
}
