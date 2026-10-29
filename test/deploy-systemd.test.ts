import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import { acquireSystemdUnitReference as acquireSystemdUnitReferenceUntyped } from '../scripts/deploy/systemd.mjs';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import { assertRestartableSystemdUnit as assertRestartableSystemdUnitUntyped } from '../scripts/deploy/systemd.mjs';

type Context = { supported: boolean; unit: string; args?: string[] };
type ReadProperty = (property: string) => string;
type IsUnitFile = (path: string) => boolean;
const assertRestartableSystemdUnit = assertRestartableSystemdUnitUntyped as unknown as (
  context: Context,
  readProperty: ReadProperty,
  isUnitFile: IsUnitFile,
) => void;
const acquireSystemdUnitReference = acquireSystemdUnitReferenceUntyped as unknown as (
  context: Context,
  options: { spawnProcess: typeof fakeSpawn },
) => Promise<{ check: () => Promise<boolean>; release: () => Promise<void> }>;

const context = { supported: true, unit: 'pico-runtime.service' };
const validProperties: Record<string, string> = {
  Transient: 'no',
  LoadState: 'loaded',
  CanStart: 'yes',
  FragmentPath: '/etc/systemd/system/pico-runtime.service',
};

function check(properties: Record<string, string>, isUnitFile: IsUnitFile = () => true) {
  return assertRestartableSystemdUnit(context, (property) => properties[property] ?? '', isUnitFile);
}

function expectNotStopped(action: () => void) {
  expect(action).toThrow(/(?:Runtime.*(?:not stopped|has not been stopped|尚未停止)|no Runtime was stopped)/i);
}

describe('assertRestartableSystemdUnit', () => {
  it('accepts a loaded, startable, non-transient unit file', () => {
    expect(() => check(validProperties)).not.toThrow();
  });

  it('accepts a loaded, startable transient unit without requiring a fragment', () => {
    const properties: Record<string, string> = { ...validProperties, Transient: 'yes', FragmentPath: '' };
    expect(() =>
      assertRestartableSystemdUnit(
        context,
        (property) => {
          if (property === 'FragmentPath') throw new Error('fragment should not be read');
          return properties[property] ?? '';
        },
        () => {
          throw new Error('unit file should not be checked');
        },
      ),
    ).not.toThrow();
  });

  it.each(['unknown', ''])('rejects unverified Transient=%s', (transient) => {
    expectNotStopped(() => check({ ...validProperties, Transient: transient }));
  });

  it.each([
    ['LoadState', 'not-found'],
    ['LoadState', 'unknown'],
    ['LoadState', ''],
    ['CanStart', 'no'],
    ['CanStart', 'unknown'],
    ['CanStart', ''],
  ])('rejects invalid %s=%s for a transient unit', (property, value) => {
    expectNotStopped(() => check({ ...validProperties, Transient: 'yes', [property]: value }));
  });

  it.each([
    ['FragmentPath', 'relative.service'],
    ['FragmentPath', ''],
  ])('rejects invalid persistent %s=%s', (property, value) => {
    expectNotStopped(() => check({ ...validProperties, [property]: value }));
  });

  it('rejects a fragment path that is not a unit file', () => {
    expectNotStopped(() => check(validProperties, () => false));
  });
});

type FakeMode = 'ready' | 'ref-failure' | 'early-exit';
let nextFakeMode: FakeMode = 'ready';
let lastFakeChild: FakeChild | undefined;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private commandBuffer = '';

  constructor(mode: FakeMode) {
    super();
    if (mode === 'early-exit') {
      setImmediate(() => this.exit(1));
      return;
    }
    setImmediate(() => this.stdout.write(`${mode === 'ready' ? 'READY' : 'ERROR ref-failed'}\n`));
    this.stdin.on('data', (chunk: Buffer) => {
      this.commandBuffer += chunk.toString();
      while (this.commandBuffer.includes('\n')) {
        const newline = this.commandBuffer.indexOf('\n');
        const command = this.commandBuffer.slice(0, newline);
        this.commandBuffer = this.commandBuffer.slice(newline + 1);
        if (command === 'PING') this.stdout.write('PONG\n');
        if (command === 'RELEASE') {
          this.stdout.write('RELEASED\n');
          setImmediate(() => this.exit(0));
        }
      }
    });
  }

  kill(signal: NodeJS.Signals) {
    this.exit(null, signal);
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit('exit', code, signal);
  }
}

function fakeSpawn(_command: string, _args: string[], _options: unknown): FakeChild {
  const child = new FakeChild(nextFakeMode);
  lastFakeChild = child;
  return child;
}

afterEach(() => {
  nextFakeMode = 'ready';
  lastFakeChild = undefined;
  vi.restoreAllMocks();
});

describe('acquireSystemdUnitReference', () => {
  it('holds the reference, answers health checks, releases it, and omits credentials from the child environment', async () => {
    const originalToken = process.env.PICO_ACCESS_TOKEN;
    process.env.PICO_ACCESS_TOKEN = 'test-only-secret';
    let spawnArguments: unknown[] = [];
    const reference = await acquireSystemdUnitReference(
      { ...context, args: ['--user'] },
      {
        spawnProcess: ((...args: unknown[]) => {
          spawnArguments = args;
          return fakeSpawn(args[0] as string, args[1] as string[], args[2]);
        }) as typeof fakeSpawn,
      },
    );

    expect(await reference.check()).toBe(true);
    await reference.release();
    await reference.release();
    expect(spawnArguments[1]).toEqual(expect.arrayContaining(['--user', context.unit]));
    expect(spawnArguments[2]).toMatchObject({ env: { PATH: expect.any(String) } });
    expect(spawnArguments[2]).not.toMatchObject({ env: { PICO_ACCESS_TOKEN: expect.anything() } });
    expect(lastFakeChild?.exitCode).toBe(0);
    if (originalToken === undefined) delete process.env.PICO_ACCESS_TOKEN;
    else process.env.PICO_ACCESS_TOKEN = originalToken;
  });

  it.each<FakeMode>(['ref-failure', 'early-exit'])('fails safely when helper reports %s', async (mode) => {
    nextFakeMode = mode;
    await expect(acquireSystemdUnitReference(context, { spawnProcess: fakeSpawn })).rejects.toThrow(
      /Cannot acquire a D-Bus reference.*no Runtime was stopped/,
    );
    if (mode === 'ref-failure') expect(lastFakeChild?.signalCode).toBe('SIGTERM');
    else expect(lastFakeChild?.exitCode).toBe(1);
  });

  it('detects if the reference helper exits while held', async () => {
    const reference = await acquireSystemdUnitReference(context, { spawnProcess: fakeSpawn });
    lastFakeChild?.kill('SIGTERM');
    await expect(reference.check()).rejects.toThrow(/reference helper exited/);
    await expect(reference.release()).rejects.toThrow(/reference helper exited/);
  });
});
