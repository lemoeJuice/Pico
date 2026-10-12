import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const sessionCookieName = 'pico_session';
export const sessionMaxAgeSeconds = 12 * 60 * 60;

type Session = { expiresAt: number };

export class AccessSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly accessToken: string | undefined) {}

  get required(): boolean {
    return this.accessToken !== undefined;
  }

  login(candidate: unknown, now = Date.now()): string | null {
    if (!this.accessToken || typeof candidate !== 'string' || !safeEqual(candidate, this.accessToken)) return null;
    this.prune(now);
    while (this.sessions.size >= 256) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, { expiresAt: now + sessionMaxAgeSeconds * 1000 });
    return sessionId;
  }

  authenticated(sessionId: string | null, now = Date.now()): boolean {
    if (!this.required) return true;
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.expiresAt <= now) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  revoke(sessionId: string | null): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  private prune(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

function safeEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== sessionCookieName) continue;
    const value = item.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(sessionId: string, secure: boolean): string {
  return `${sessionCookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionMaxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function isLoopbackHost(host: string): boolean {
  const hostname = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (hostname === 'localhost') return true;
  if (isIP(hostname) === 4) return Number(hostname.split('.')[0]) === 127;
  if (isIP(hostname) === 6) return hostname === '::1' || hostname.toLowerCase() === '0:0:0:0:0:0:0:1';
  return false;
}

export function sameOrigin(origin: string | undefined, host: string | undefined, encrypted: boolean): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const expectedProtocol = encrypted ? 'https:' : 'http:';
    return parsed.protocol === expectedProtocol && parsed.host.toLowerCase() === host?.toLowerCase();
  } catch {
    return false;
  }
}
