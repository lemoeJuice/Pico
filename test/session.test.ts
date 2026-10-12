import { describe, expect, it } from 'vitest';
import { isSessionExpired } from '../src/web/session.js';

describe('browser session recovery', () => {
  it('expires the session only when the server confirms authentication is required and absent', async () => {
    const response = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    await expect(isSessionExpired(async () => response({ authRequired: true, authenticated: false }))).resolves.toBe(
      true,
    );
    await expect(isSessionExpired(async () => response({ authRequired: true, authenticated: true }))).resolves.toBe(
      false,
    );
    await expect(isSessionExpired(async () => response({ authRequired: false, authenticated: false }))).resolves.toBe(
      false,
    );
  });

  it('keeps the current session when its status cannot be reached', async () => {
    await expect(
      isSessionExpired(async () => {
        throw new Error('network offline');
      }),
    ).resolves.toBe(false);
  });
});
