import { expect, it } from 'vitest';
import {
  validatePluginAuthPopupCallback,
  validatePluginAuthPopupNavigation,
  type PluginAuthPopupLease,
} from '../src/web/plugin-auth-popup.js';

function lease(
  port: object,
  popup: { closed: boolean },
  overrides: Partial<PluginAuthPopupLease> = {},
): PluginAuthPopupLease {
  return {
    pluginId: 'pico.example',
    entry: 'webui',
    viewId: 'account',
    actionId: 'connect',
    port,
    popup,
    expiresAt: 1000,
    ...overrides,
  };
}
const request = {
  pluginId: 'pico.example',
  entry: 'webui',
  viewId: 'account',
  leaseId: 'once',
  authorizationUrl: 'https://login.example.test/oauth?state=runtime',
  callbackOrigin: 'http://127.0.0.1:43210',
  operationId: 'operation-123',
};

it('binds authorization navigation to the current port and registered identity and allows one use', () => {
  const port = {},
    popup = { closed: false },
    current = lease(port, popup);
  expect(
    validatePluginAuthPopupNavigation(current, request, port, ['https://login.example.test'], 999)?.authorizationUrl
      .href,
  ).toBe(request.authorizationUrl);
  expect(validatePluginAuthPopupNavigation(current, request, {}, ['https://login.example.test'], 999)).toBeNull();
  expect(
    validatePluginAuthPopupNavigation(
      current,
      { ...request, entry: 'other' },
      port,
      ['https://login.example.test'],
      999,
    ),
  ).toBeNull();
  expect(
    validatePluginAuthPopupNavigation(
      lease(port, popup, { callbackOrigin: 'http://127.0.0.1:43210' }),
      request,
      port,
      ['https://login.example.test'],
      999,
    ),
  ).toBeNull();
  expect(
    validatePluginAuthPopupNavigation(
      lease(port, { closed: true }, { operationId: 'operation-123', callbackOrigin: request.callbackOrigin }),
      request,
      port,
      ['https://login.example.test'],
      999,
    ),
  ).toBeNull();
});

it('rejects unregistered origins, remote callback origins, closed and expired leases', () => {
  const port = {},
    popup = { closed: false },
    current = lease(port, popup);
  expect(
    validatePluginAuthPopupNavigation(
      current,
      { ...request, authorizationUrl: 'https://evil.example.test/' },
      port,
      ['https://login.example.test'],
      1000,
    ),
  ).toBeNull();
  expect(
    validatePluginAuthPopupNavigation(
      current,
      { ...request, callbackOrigin: 'https://127.0.0.1:43210' },
      port,
      ['https://login.example.test'],
      1000,
    ),
  ).toBeNull();
  expect(
    validatePluginAuthPopupNavigation(
      lease(port, { closed: true }),
      request,
      port,
      ['https://login.example.test'],
      1000,
    ),
  ).toBeNull();
  expect(
    validatePluginAuthPopupNavigation(
      lease(port, popup, { expiresAt: 999 }),
      request,
      port,
      ['https://login.example.test'],
      1000,
    ),
  ).toBeNull();
  expect(
    validatePluginAuthPopupNavigation(
      lease(port, popup, { expiresAt: 1000 }),
      request,
      port,
      ['https://login.example.test'],
      1000,
    ),
  ).toBeNull();
});

it('accepts a callback from the exact popup after it closes, while preserving callback bindings', () => {
  const port = {},
    popup = { closed: false };
  const current = lease(port, popup, {
    operationId: 'operation-123',
    callbackOrigin: 'http://127.0.0.1:43210',
  });
  popup.closed = true;
  expect(validatePluginAuthPopupCallback(current, popup, current.callbackOrigin!, 'operation-123', port, 999)).toBe(true);
  expect(validatePluginAuthPopupCallback(current, popup, current.callbackOrigin!, 'other-operation', port, 999)).toBe(false);
  expect(validatePluginAuthPopupCallback(current, popup, current.callbackOrigin!, undefined, port, 999)).toBe(false);
  expect(validatePluginAuthPopupCallback(current, {}, current.callbackOrigin!, 'operation-123', port, 999)).toBe(false);
  expect(validatePluginAuthPopupCallback(current, popup, 'http://127.0.0.1:43211', 'operation-123', port, 1000)).toBe(false);
  expect(validatePluginAuthPopupCallback(current, popup, current.callbackOrigin!, 'operation-123', {}, 1000)).toBe(false);
  expect(
    validatePluginAuthPopupCallback(
      lease(port, popup, { callbackOrigin: 'http://127.0.0.1:43210', expiresAt: 999 }),
      popup,
      current.callbackOrigin!,
      'operation-123',
      port,
      1000,
    ),
  ).toBe(false);
  expect(
    validatePluginAuthPopupCallback(
      lease(port, popup, {
        callbackOrigin: 'http://127.0.0.1:43210',
        operationId: 'operation-123',
        expiresAt: 1000,
      }),
      popup,
      current.callbackOrigin!,
      'operation-123',
      port,
      1000,
    ),
  ).toBe(false);
  current.callbackConsumed = true;
  expect(validatePluginAuthPopupCallback(current, popup, current.callbackOrigin!, 'operation-123', port, 999)).toBe(false);
});
