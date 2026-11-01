import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runContainerSupervisor } from '../src/executor/container-supervisor.mjs';

const token = 'container-supervisor-test-token-that-is-long-enough';
const pause = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
}

function setup() {
  const child = new FakeChild();
  const spawnCalls: SpawnOptions[] = [];
  const spawnImpl = vi.fn((_command: string, _args: string[], options: SpawnOptions): ChildProcess => {
    spawnCalls.push(options);
    return child as unknown as ChildProcess;
  });
  const exit = vi.fn();
  const signalSource = new EventEmitter();
  runContainerSupervisor({
    agentPath: '/opt/pico/executor-agent.mjs',
    env: { PICO_EXECUTOR_TOKEN: token, PICO_EXECUTOR_INSTALL_PATH: '/opt/pico/executor-agent.mjs' },
    spawnImpl,
    exit,
    signalSource: signalSource as unknown as Pick<NodeJS.Process, 'once'>,
    restartDelay: 1,
  });
  return { child, spawnImpl, spawnCalls, exit, signalSource };
}

describe('Container Executor supervisor', () => {
  it('restarts only the agent after a supervised update and keeps its token in the child environment', async () => {
    const { child, spawnImpl, spawnCalls, exit } = setup();
    expect(spawnCalls[0]?.env).toMatchObject({
      PICO_EXECUTOR_TOKEN: token,
      PICO_EXECUTOR_SUPERVISED: '1',
    });

    child.emit('message', { type: 'restart', version: '1.2.3' });
    child.emit('exit', 0, null);
    await pause();

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
    expect(spawnCalls[1]?.env).toMatchObject({
      PICO_EXECUTOR_TOKEN: token,
      PICO_EXECUTOR_VERSION: '1.2.3',
      PICO_EXECUTOR_VERSION_FILE: '/opt/pico/executor-agent.mjs.version',
    });
  });

  it('exits PID 1 on idle without restarting the child', async () => {
    const { child, spawnImpl, exit } = setup();
    child.emit('message', { type: 'idle' });
    expect(exit).toHaveBeenCalledWith(0);
    child.emit('exit', 0, null);
    await pause();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('stops its child when the container receives SIGTERM', () => {
    const { child, exit, signalSource } = setup();
    signalSource.emit('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0, null);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('refuses to start without a token and does not echo the token', () => {
    const onError = vi.fn();
    expect(() => runContainerSupervisor({ env: {}, onError })).toThrow(/PICO_EXECUTOR_TOKEN/);
    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining(token));
  });
});
