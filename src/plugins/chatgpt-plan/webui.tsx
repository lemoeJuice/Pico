import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { PluginUiProps } from '../ui-protocol.js';
import type { ChatGptModelChoice } from './types.js';

const apiRoot = '/api/plugins/pico.chatgpt-plan';

type AccountStatus = { connected: boolean; accountLabel: string | null };
type SignInResponse = { authorizationUrl: string; callbackOrigin: string; operationId: string };
type SignInMessage = {
  type: 'pico:plugin-auth';
  pluginId: 'pico.chatgpt-plan';
  operationId: string;
  status: 'connected' | 'failed';
  message: string;
};
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AccountPage({ api, onError, onNotice }: PluginUiProps): ReactElement {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [models, setModels] = useState<ChatGptModelChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const popupRef = useRef<Window | null>(null);
  const signInRef = useRef<{ callbackOrigin: string; operationId: string } | null>(null);

  const refresh = useCallback(
    async (refreshModels = false): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const account = await api<AccountStatus>(`${apiRoot}/status`);
        setStatus(account);
        setModels(
          account.connected
            ? await api<ChatGptModelChoice[]>(refreshModels ? `${apiRoot}/models/refresh` : `${apiRoot}/models`)
            : [],
        );
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        onError(message);
      } finally {
        setLoading(false);
      }
    },
    [api, onError],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const receiveOAuthMessage = (event: MessageEvent<unknown>): void => {
      const attempt = signInRef.current;
      const popup = popupRef.current;
      const result = event.data as Partial<SignInMessage> | null;
      if (
        !attempt ||
        !popup ||
        event.origin !== attempt.callbackOrigin ||
        event.source !== popup ||
        !result ||
        result.type !== 'pico:plugin-auth' ||
        result.pluginId !== 'pico.chatgpt-plan' ||
        result.operationId !== attempt.operationId
      ) {
        return;
      }
      signInRef.current = null;
      popupRef.current = null;
      if (result.status !== 'connected') {
        const message = result.message || 'ChatGPT sign-in failed.';
        setError(message);
        onError(message);
        return;
      }
      onNotice(result.message || 'ChatGPT account connected.');
      void refresh();
    };
    window.addEventListener('message', receiveOAuthMessage);
    return () => window.removeEventListener('message', receiveOAuthMessage);
  }, [onError, onNotice, refresh]);

  const connect = async (): Promise<void> => {
    setError('');
    const popup = window.open('about:blank', 'pico-chatgpt-sign-in', 'popup,width=520,height=720');
    if (!popup) {
      const message = 'Allow pop-up windows for Pico to continue with ChatGPT.';
      setError(message);
      onError(message);
      return;
    }
    popupRef.current = popup;
    try {
      const result = await api<SignInResponse>(`${apiRoot}/sign-in`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      signInRef.current = { callbackOrigin: result.callbackOrigin, operationId: result.operationId };
      popup.location.replace(result.authorizationUrl);
    } catch (caught) {
      popupRef.current = null;
      popup.close();
      const message = errorMessage(caught);
      setError(message);
      onError(message);
    }
  };

  const disconnect = async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ remoteRevoked: boolean }>(`${apiRoot}/account`, { method: 'DELETE' });
      setStatus({ connected: false, accountLabel: null });
      setModels([]);
      onNotice(
        result.remoteRevoked
          ? 'ChatGPT account disconnected.'
          : 'Signed out locally; remote revocation was not confirmed.',
      );
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="form-stack">
      <div className="chatgpt-account-card pico-ui-card">
        <strong>CHATGPT ACCOUNT</strong>
        <p className="field-note">
          Sign in with ChatGPT to use models available to your account. OAuth returns to 127.0.0.1, so the browser and
          Pico Runtime must run on the same machine. Credentials remain with the Runtime.
        </p>
        {status?.connected ? (
          <>
            <span className="chatgpt-account-label pico-ui-status" data-status="success">
              Connected as {status.accountLabel ?? 'ChatGPT account'}
            </span>
            <span className="field-note">
              {models.length} available model{models.length === 1 ? '' : 's'}
            </span>
            <div className="form-actions pico-ui-actions chatgpt-account-actions">
              <button
                type="button"
                className="button button-soft pico-ui-button"
                onClick={() => void refresh(true)}
                disabled={loading}
              >
                {loading ? 'Refreshing…' : 'Refresh models'}
              </button>
              <button
                type="button"
                className="button button-quiet pico-ui-button"
                onClick={() => void disconnect()}
                disabled={loading}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="button button-primary pico-ui-button pico-ui-button--primary"
            onClick={() => void connect()}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Continue with ChatGPT'}
          </button>
        )}
      </div>
      {error ? (
        <p className="pico-ui-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ChatGptPlanComposerModel({
  api,
  settings,
  updateModelSettings,
  openPage,
  onError,
}: PluginUiProps): ReactElement | null {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [models, setModels] = useState<ChatGptModelChoice[]>([]);
  const [loading, setLoading] = useState(false);

  const loadProviderData = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const account = await api<AccountStatus>(`${apiRoot}/status`);
      setStatus(account);
      if (account.connected) {
        try {
          setModels(await api<ChatGptModelChoice[]>(`${apiRoot}/models`));
        } catch (caught) {
          onError(errorMessage(caught));
        }
      } else {
        setModels([]);
      }
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [api, onError]);

  useEffect(() => {
    if (settings.provider === 'chatgpt-plan') void loadProviderData();
  }, [settings.provider, loadProviderData]);

  const selectModel = async (model: string): Promise<void> => {
    try {
      await updateModelSettings({ provider: 'chatgpt-plan', model });
    } catch (caught) {
      onError(errorMessage(caught));
    }
  };

  if (settings.provider !== 'chatgpt-plan') {
    return null;
  }

  if (!status?.connected) {
    return (
      <div className="chatgpt-composer-controls">
        <select className="pico-ui-control" aria-label="Model" disabled>
          <option>{loading ? 'Loading models…' : 'Connect ChatGPT account'}</option>
        </select>
        <button
          type="button"
          className="button button-quiet pico-ui-button"
          onClick={() => openPage('pico.chatgpt-plan', 'account')}
        >
          Connect
        </button>
      </div>
    );
  }

  return (
    <div className="chatgpt-composer-controls">
      <select
        className="chatgpt-model-select pico-ui-control"
        aria-label="Model"
        value={models.some((choice) => choice.slug === settings.model) ? settings.model : ''}
        onChange={(event) => void selectModel(event.target.value)}
        disabled={loading}
      >
        {!models.some((choice) => choice.slug === settings.model) ? (
          <option value="" disabled>
            {loading ? 'Loading models…' : 'Choose model'}
          </option>
        ) : null}
        {models.map((model) => (
          <option key={model.slug} value={model.slug}>
            {model.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}

export const pluginWebUi = {
  pages: { account: AccountPage },
  components: { ChatGptPlanComposerModel },
};
