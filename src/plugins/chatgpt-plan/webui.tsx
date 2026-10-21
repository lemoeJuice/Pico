import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { PluginUiProps } from '../ui-protocol.js';
import type { ChatGptModelChoice } from './types.js';

const apiRoot = '/api/plugins/pico.chatgpt-plan';

type AccountStatus = { connected: boolean; accountLabel: string | null };
type SignInResponse = { authorizationUrl: string; callbackOrigin: string; operationId: string };
type ManualCallbackResponse = {
  status: 'connected' | 'failed';
  message: string;
  retryable: boolean;
  retryExchange: boolean;
};
type SignInMessage = {
  type: 'pico:plugin-auth';
  pluginId: 'pico.chatgpt-plan';
  operationId: string;
  status: 'connected' | 'failed';
  message: string;
  retryable: boolean;
  retryExchange: boolean;
};
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AccountPage({ api, onError, onNotice }: PluginUiProps): ReactElement {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [models, setModels] = useState<ChatGptModelChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [callbackOperationId, setCallbackOperationId] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [submittingCallback, setSubmittingCallback] = useState(false);
  const [retryExchangeAvailable, setRetryExchangeAvailable] = useState(false);
  const [retrySubmitted, setRetrySubmitted] = useState(false);
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
        if (!result.retryable) {
          setCallbackOperationId(null);
          setCallbackUrl('');
        }
        if (result.retryExchange) {
          setRetryExchangeAvailable(true);
          setRetrySubmitted(false);
          setCallbackUrl('');
        } else if (!result.retryable) {
          setRetryExchangeAvailable(false);
          setRetrySubmitted(false);
        }
        return;
      }
      setCallbackOperationId(null);
      setCallbackUrl('');
      setRetryExchangeAvailable(false);
      setRetrySubmitted(false);
      onNotice(result.message || 'ChatGPT account connected.');
      void refresh();
    };
    window.addEventListener('message', receiveOAuthMessage);
    return () => window.removeEventListener('message', receiveOAuthMessage);
  }, [onError, onNotice, refresh]);

  const connect = async (): Promise<void> => {
    setError('');
    setCallbackOperationId(null);
    setCallbackUrl('');
    setRetryExchangeAvailable(false);
    setRetrySubmitted(false);
    popupRef.current?.close();
    popupRef.current = null;
    signInRef.current = null;
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
      setCallbackOperationId(result.operationId);
      setRetryExchangeAvailable(false);
      setRetrySubmitted(false);
      popup.location.replace(result.authorizationUrl);
    } catch (caught) {
      popupRef.current = null;
      popup.close();
      const message = errorMessage(caught);
      setError(message);
      onError(message);
    }
  };

  const completeManualSignIn = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const operationId = callbackOperationId;
    const pastedUrl = callbackUrl.trim();
    if (!operationId || !pastedUrl) return;

    setSubmittingCallback(true);
    setError('');
    try {
      const result = await api<ManualCallbackResponse>(`${apiRoot}/sign-in/complete`, {
        method: 'POST',
        body: JSON.stringify({ operationId, callbackUrl: pastedUrl }),
      });
      if (result.status === 'connected') {
        setCallbackOperationId(null);
        setCallbackUrl('');
        setRetryExchangeAvailable(false);
        setRetrySubmitted(false);
        popupRef.current?.close();
        popupRef.current = null;
        signInRef.current = null;
        onNotice(result.message);
        await refresh();
      } else {
        setError(result.message);
        onError(result.message);
        if (result.retryExchange) {
          setRetryExchangeAvailable(true);
          setRetrySubmitted(false);
          setCallbackUrl('');
          popupRef.current?.close();
          popupRef.current = null;
          signInRef.current = null;
        } else if (!result.retryable) {
          setCallbackOperationId(null);
          setCallbackUrl('');
          setRetryExchangeAvailable(false);
          setRetrySubmitted(false);
          popupRef.current?.close();
          popupRef.current = null;
          signInRef.current = null;
        }
      }
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      onError(message);
    } finally {
      setSubmittingCallback(false);
    }
  };

  const retryTokenExchange = async (): Promise<void> => {
    const operationId = callbackOperationId;
    if (!operationId || submittingCallback || retrySubmitted) return;

    setSubmittingCallback(true);
    setRetrySubmitted(true);
    setError('');
    try {
      const result = await api<ManualCallbackResponse>(`${apiRoot}/sign-in/retry`, {
        method: 'POST',
        body: JSON.stringify({ operationId }),
      });
      if (result.status === 'connected') {
        setCallbackOperationId(null);
        setCallbackUrl('');
        setRetryExchangeAvailable(false);
        setRetrySubmitted(false);
        onNotice(result.message);
        await refresh();
      } else {
        setError(result.message);
        onError(result.message);
        if (!result.retryExchange) {
          setCallbackOperationId(null);
          setCallbackUrl('');
          setRetryExchangeAvailable(false);
          setRetrySubmitted(false);
        }
      }
    } catch (caught) {
      let statusChecked = false;
      let connectionConfirmed = false;
      try {
        const account = await api<AccountStatus>(`${apiRoot}/status`);
        statusChecked = true;
        setStatus(account);
        connectionConfirmed = account.connected;
        if (account.connected) {
          try {
            setModels(await api<ChatGptModelChoice[]>(`${apiRoot}/models`));
          } catch {
            setModels([]);
          }
        } else {
          setModels([]);
        }
      } catch {
        // The token retry and the follow-up status check can both lose their response.
      }
      setCallbackOperationId(null);
      setCallbackUrl('');
      setRetryExchangeAvailable(false);
      setRetrySubmitted(false);
      if (connectionConfirmed) {
        onNotice('The retry response was lost, but Runtime confirms ChatGPT is connected.');
      } else {
        const statusMessage = statusChecked
          ? 'Runtime currently reports the account as disconnected; start a new ChatGPT sign-in.'
          : 'The retry result could not be confirmed; start a new ChatGPT sign-in.';
        const message = `${errorMessage(caught)} ${statusMessage}`;
        setError(message);
        onError(message);
      }
    } finally {
      setSubmittingCallback(false);
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
          Sign in with ChatGPT to use models available to your account. OAuth returns to 127.0.0.1. If the browser
          cannot reach Pico Runtime there, copy the full callback URL from the browser address bar and paste it below.
          Credentials remain with the Runtime.
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
      {callbackOperationId ? (
        retryExchangeAvailable ? (
          <div className="form-stack chatgpt-manual-callback">
            <p className="field-note">
              Pico received the callback, but the token request did not return a response. Retry that request once
              without repeating sign-in. If ChatGPT already used the one-time code, the retry will fail and you will
              need to start a new sign-in.
            </p>
            <button
              type="button"
              className="button button-soft pico-ui-button"
              onClick={() => void retryTokenExchange()}
              disabled={submittingCallback || retrySubmitted}
            >
              {submittingCallback ? 'Retrying…' : retrySubmitted ? 'Retry request sent' : 'Retry token exchange'}
            </button>
          </div>
        ) : (
          <form className="form-stack chatgpt-manual-callback" onSubmit={(event) => void completeManualSignIn(event)}>
            <p className="field-note">
              If the sign-in popup shows a connection error, copy its full address bar URL and paste it here. The URL
              contains a one-time authorization code; do not share it.
            </p>
            <label className="field-label" htmlFor="chatgpt-callback-url">
              Callback URL
            </label>
            <textarea
              id="chatgpt-callback-url"
              rows={3}
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={submittingCallback}
            />
            <div className="form-actions pico-ui-actions">
              <button
                type="submit"
                className="button button-soft pico-ui-button"
                disabled={submittingCallback || !callbackUrl.trim()}
              >
                {submittingCallback ? 'Completing…' : 'Complete sign-in'}
              </button>
            </div>
          </form>
        )
      ) : null}
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
  context,
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

  const selectedProvider = context.modelSelection?.provider ?? settings.provider;
  const selectedModel = context.modelSelection?.model ?? settings.model;
  useEffect(() => {
    if (selectedProvider === 'chatgpt-plan') void loadProviderData();
  }, [selectedProvider, loadProviderData]);

  const selectModel = async (model: string): Promise<void> => {
    try {
      await updateModelSettings({ provider: 'chatgpt-plan', model }, context.thread?.id);
    } catch (caught) {
      onError(errorMessage(caught));
    }
  };

  if (selectedProvider !== 'chatgpt-plan') {
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
        value={models.some((choice) => choice.slug === selectedModel) ? selectedModel : ''}
        onChange={(event) => void selectModel(event.target.value)}
        disabled={loading}
      >
        {!models.some((choice) => choice.slug === selectedModel) ? (
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
