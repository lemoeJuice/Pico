import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultAgentPath = '/opt/pico/executor-agent.mjs';
const restartDelayMs = 250;

/**
 * Keep the Executor agent as a supervised child. An idle message ends PID 1 so
 * the container can stop; an update message only restarts the child process.
 */
export function runContainerSupervisor({
  agentPath = process.env.PICO_EXECUTOR_INSTALL_PATH || defaultAgentPath,
  env = process.env,
  spawnImpl = spawn,
  exit = (code) => process.exit(code),
  signalSource = process,
  onError = (message) => console.error(message),
  restartDelay = restartDelayMs,
} = {}) {
  if (typeof env.PICO_EXECUTOR_TOKEN !== 'string' || Buffer.byteLength(env.PICO_EXECUTOR_TOKEN) < 32) {
    throw new Error('PICO_EXECUTOR_TOKEN must be configured before starting the Executor supervisor.');
  }
  if (!Number.isFinite(restartDelay) || restartDelay < 0) {
    throw new Error('Executor supervisor restart delay must be a non-negative number.');
  }

  let child;
  let childEnv = { ...env };
  let restartTimer;
  let stopping = false;
  let exitStarted = false;

  const finish = (code) => {
    if (exitStarted) return;
    exitStarted = true;
    if (restartTimer) clearTimeout(restartTimer);
    exit(code);
  };

  const scheduleRestart = () => {
    if (stopping || exitStarted || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      startAgent();
    }, restartDelay);
  };

  const startAgent = () => {
    if (stopping || exitStarted) return;
    try {
      child = spawnImpl(process.execPath, [agentPath], {
        cwd: process.cwd(),
        env: { ...childEnv, PICO_EXECUTOR_SUPERVISED: '1' },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
    } catch (error) {
      onError(`Could not start Remote Executor agent: ${error instanceof Error ? error.message : String(error)}`);
      return scheduleRestart();
    }

    const current = child;
    let restartRequested = false;
    current.on('message', (message) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'idle') {
        stopping = true;
        // PID 1 exit stops the container; the data volume remains mounted.
        finish(0);
      } else if (message.type === 'restart') {
        if (typeof message.version === 'string' && message.version.length > 0 && message.version.length <= 200) {
          childEnv = {
            ...childEnv,
            PICO_EXECUTOR_VERSION: message.version,
            PICO_EXECUTOR_VERSION_FILE: childEnv.PICO_EXECUTOR_VERSION_FILE || `${agentPath}.version`,
          };
        }
        restartRequested = true;
      }
    });
    current.once('error', (error) => {
      onError(`Remote Executor agent failed: ${error.message}`);
    });
    current.once('exit', (code, signal) => {
      if (child === current) child = undefined;
      if (stopping || exitStarted) return finish(0);
      if (!restartRequested && (code !== 0 || signal)) {
        onError(`Remote Executor agent exited unexpectedly (${signal ?? code ?? 'unknown'}); restarting it.`);
      }
      scheduleRestart();
    });
  };

  const stop = () => {
    if (stopping || exitStarted) return;
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (child) {
      const current = child;
      const forceExit = setTimeout(() => {
        current.kill('SIGKILL');
        finish(0);
      }, 5_000);
      forceExit.unref?.();
      current.once('exit', () => {
        clearTimeout(forceExit);
        finish(0);
      });
      current.kill('SIGTERM');
    } else {
      finish(0);
    }
  };

  signalSource.once('SIGTERM', stop);
  signalSource.once('SIGINT', stop);
  startAgent();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runContainerSupervisor();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
