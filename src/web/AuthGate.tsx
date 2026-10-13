import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

type AuthStatus = { authRequired: boolean; authenticated: boolean };

async function fetchStatus(): Promise<AuthStatus> {
  const response = await fetch('/api/auth/status', { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Could not reach Pico (${response.status})`);
  return (await response.json()) as AuthStatus;
}

export function AuthGate({
  children,
}: {
  children: (auth: { authRequired: boolean; onSignOut(): Promise<void> }) => ReactNode;
}) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      setStatus(await fetchStatus());
      setError('');
      return true;
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let retryDelay = 750;
    let checking = false;
    const connect = async (): Promise<void> => {
      if (!alive || checking) return;
      checking = true;
      const connected = await refresh();
      checking = false;
      if (!alive) return;
      if (connected) {
        retryDelay = 750;
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        retryDelay = Math.min(retryDelay * 1.7, 12_000);
        void connect();
      }, retryDelay);
    };
    const expire = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      retryDelay = 750;
      void connect();
    };
    void connect();
    window.addEventListener('pico:auth-expired', expire);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('pico:auth-expired', expire);
    };
  }, [refresh]);

  const login = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(result?.error ?? `Sign in failed (${response.status})`);
      }
      setToken('');
      if (!(await refresh())) window.dispatchEvent(new Event('pico:auth-expired'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const logout = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/session', {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Sign out failed (${response.status})`);
      if (!(await refresh())) window.dispatchEvent(new Event('pico:auth-expired'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      window.dispatchEvent(new Event('pico:auth-expired'));
    }
  }, [refresh]);

  if (status?.authenticated) return <>{children({ authRequired: status.authRequired, onSignOut: logout })}</>;

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-mark">
          <Sparkles size={20} aria-hidden="true" />
        </div>
        <p className="eyebrow">PICO · PRIVATE WORKSPACE</p>
        <h1>{status?.authRequired ? 'Welcome back.' : 'Connecting to Pico…'}</h1>
        {status?.authRequired ? (
          <>
            <p className="auth-copy">Enter this Pico server’s access token to open its projects and Threads.</p>
            <form className="auth-form" onSubmit={(event) => void login(event)}>
              <label className="field">
                <span>Access token</span>
                <input
                  autoComplete="off"
                  autoFocus
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="PICO_ACCESS_TOKEN"
                  required
                  type="password"
                  value={token}
                />
              </label>
              {error ? (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              ) : null}
              <button className="button button-primary" disabled={busy || !token} type="submit">
                {busy ? 'Signing in…' : 'Open Pico'}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="auth-copy">
              {error ? `${error} Retrying automatically…` : 'Checking the local Runtime connection.'}
            </p>
            {error ? (
              <button className="button button-soft" onClick={() => void refresh()}>
                Retry
              </button>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
