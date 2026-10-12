import { describe, expect, it } from 'vitest';
import {
  AccessSessions,
  isLoopbackHost,
  readSessionCookie,
  sameOrigin,
  sessionCookie,
  sessionMaxAgeSeconds,
} from '../src/server-auth.js';

describe('single-user access sessions', () => {
  it('expires, revokes, and bounds server-side browser sessions', () => {
    const sessions = new AccessSessions('a'.repeat(32));
    const id = sessions.login('a'.repeat(32), 100);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.authenticated(id, 101)).toBe(true);
    expect(sessions.authenticated(id, 100 + sessionMaxAgeSeconds * 1000)).toBe(false);

    const next = sessions.login('a'.repeat(32), 200);
    expect(sessions.authenticated(next, 201)).toBe(true);
    sessions.revoke(next);
    expect(sessions.authenticated(next, 201)).toBe(false);
    expect(sessions.login('wrong token'.repeat(4), 300)).toBeNull();
  });

  it('accepts only loopback binds without an access token', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.42.0.8')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.4')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });

  it('uses strict, HttpOnly cookies and compares WebSocket origins', () => {
    const cookie = sessionCookie('A'.repeat(43), true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(readSessionCookie(`other=value; ${cookie}`)).toBe('A'.repeat(43));
    expect(readSessionCookie('pico_session=short')).toBeNull();
    expect(sameOrigin('http://pico.example:4173', 'pico.example:4173', false)).toBe(true);
    expect(sameOrigin('https://pico.example:4173', 'pico.example:4173', false)).toBe(false);
    expect(sameOrigin('https://other.example', 'pico.example:4173', true)).toBe(false);
    expect(sameOrigin(undefined, 'pico.example:4173', false)).toBe(true);
  });
});
