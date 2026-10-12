import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

type AuthStatus = { authRequired: boolean; authenticated: boolean };

async function fetchStatus(): Promise<AuthStatus> {
  const response = await fetch('/api/auth/status');
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

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchStatus());
      setError('');
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const expire = (): void => {
      void refresh();
    };
    window.addEventListener('pico:auth-expired', expire);
    return () => window.removeEventListener('pico:auth-expired', expire);
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
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const logout = useCallback(async () => {
    await fetch('/api/auth/session', { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  if (status?.authenticated) return <>{children({ authRequired: status.authRequired, onSignOut: logout })}</>;

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-mark">p</div>
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
                  placeholder="Paste PICO_ACCESS_TOKEN"
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
            <p className="auth-copy">{error || 'Checking the local Runtime connection.'}</p>
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
