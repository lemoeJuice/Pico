import { describe, expect, it } from 'vitest';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import { assertSystemdTokenSource as assertSystemdTokenSourceUntyped } from '../scripts/deploy/systemd-credentials.mjs';

const TOKEN = 'test-access-token-that-must-never-appear-in-errors';
const TOKEN_ENV = `PICO_ACCESS_TOKEN=${TOKEN}`;

type Input = {
  unitEnvironment: string;
  managerEnvironment: string;
  unsetEnvironment: string;
  environmentFiles: string;
  execStart: string;
  userManager: boolean;
  token: string;
};

const assertSystemdTokenSource = assertSystemdTokenSourceUntyped as unknown as (input: Input) => void;

function input(overrides: Partial<Input> = {}): Input {
  return {
    unitEnvironment: TOKEN_ENV,
    managerEnvironment: '',
    unsetEnvironment: '',
    environmentFiles: '',
    execStart: '/usr/bin/node /opt/pico/server.js',
    userManager: false,
    token: TOKEN,
    ...overrides,
  };
}

function expectRejectedWithoutToken(value: Input) {
  let caught: unknown;
  try {
    assertSystemdTokenSource(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toContain(TOKEN);
}

describe('assertSystemdTokenSource', () => {
  it('accepts the matching token set in the unit Environment', () => {
    expect(() => assertSystemdTokenSource(input())).not.toThrow();
  });

  it('accepts a matching manager Environment only for a user manager', () => {
    const value = input({ unitEnvironment: '', managerEnvironment: TOKEN_ENV, userManager: true });
    expect(() => assertSystemdTokenSource(value)).not.toThrow();
  });

  it('rejects manager-only token configuration for a system manager', () => {
    expectRejectedWithoutToken(input({ unitEnvironment: '', managerEnvironment: TOKEN_ENV, userManager: false }));
  });

  it.each([
    ['missing from both environments', { unitEnvironment: '', managerEnvironment: '' }],
    ['different in the unit', { unitEnvironment: 'PICO_ACCESS_TOKEN=another-token' }],
    [
      'different in the user manager',
      {
        unitEnvironment: '',
        managerEnvironment: 'PICO_ACCESS_TOKEN=another-token',
        userManager: true,
      },
    ],
    [
      'conflicting in the unit',
      {
        unitEnvironment: `${TOKEN_ENV} PICO_ACCESS_TOKEN=another-token`,
      },
    ],
    [
      'conflicting in the user manager',
      {
        unitEnvironment: '',
        managerEnvironment: `${TOKEN_ENV}\nPICO_ACCESS_TOKEN=another-token`,
        userManager: true,
      },
    ],
    ['removed by UnsetEnvironment', { unsetEnvironment: 'PICO_ACCESS_TOKEN' }],
    ['removed by a wildcard UnsetEnvironment', { unsetEnvironment: '*' }],
    ['provided through EnvironmentFiles', { environmentFiles: '/etc/pico/runtime.env' }],
    ['included in ExecStart', { execStart: `/usr/bin/node --token=${TOKEN} /opt/pico/server.js` }],
  ] as const)('rejects a token source that is %s without exposing the token', (_reason, overrides) => {
    expectRejectedWithoutToken(input(overrides));
  });
});
