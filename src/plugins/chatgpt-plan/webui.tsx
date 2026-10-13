import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { PluginUiProps } from '../ui-protocol.js';
import type { ChatGptModelChoice, ChatGptReasoningEffort } from './types.js';

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
type Preferences = { reasoningEffort: ChatGptReasoningEffort; fastMode: boolean };

const defaultPreferences: Preferences = { reasoningEffort: 'auto', fastMode: false };
const reasoningEffortLabels: Record<ChatGptReasoningEffort, string> = {
  auto: 'Default',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};

function reasoningEffortsFor(model: ChatGptModelChoice | undefined): ChatGptReasoningEffort[] {
  if (!model) return ['auto'];
  const slug = model.slug.toLowerCase();
  if (slug.includes('gpt-6.1-sol')) return ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (slug.includes('gpt-6-astra')) return ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (slug.startsWith('gpt-6-')) return ['auto', 'low', 'medium', 'high'];
  return ['auto', 'low', 'medium', 'high'];
}

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
      <div className="chatgpt-account-card">
        <strong>CHATGPT ACCOUNT</strong>
        <p className="field-note">
          Sign in with ChatGPT to use models available to your account. OAuth returns to 127.0.0.1, so the browser and
          Pico Runtime must run on the same machine. Credentials remain with the Runtime.
        </p>
        {status?.connected ? (
          <>
            <span className="chatgpt-account-label">Connected as {status.accountLabel ?? 'ChatGPT account'}</span>
            <span className="field-note">
              {models.length} available model{models.length === 1 ? '' : 's'}
            </span>
            <div className="form-actions chatgpt-account-actions">
              <button
                type="button"
                className="button button-soft"
                onClick={() => void refresh(true)}
                disabled={loading}
              >
                {loading ? 'Refreshing…' : 'Refresh models'}
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => void disconnect()}
                disabled={loading}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="button button-primary" onClick={() => void connect()} disabled={loading}>
            {loading ? 'Loading…' : 'Continue with ChatGPT'}
          </button>
        )}
      </div>
      {error ? (
        <p className="field-note" role="alert">
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
}: PluginUiProps): ReactElement {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [models, setModels] = useState<ChatGptModelChoice[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadProviderData = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [accountResult, preferencesResult] = await Promise.allSettled([
        api<AccountStatus>(`${apiRoot}/status`),
        api<Preferences>(`${apiRoot}/preferences`),
      ]);
      if (accountResult.status === 'rejected') onError(errorMessage(accountResult.reason));
      else if (preferencesResult.status === 'rejected') onError(errorMessage(preferencesResult.reason));
      if (preferencesResult.status === 'fulfilled') {
        setPreferences({ ...defaultPreferences, ...preferencesResult.value });
      }
      if (accountResult.status === 'fulfilled') {
        const account = accountResult.value;
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

  const savePreferences = async (next: Preferences): Promise<void> => {
    setPreferences(next);
    setSaving(true);
    try {
      const saved = await api<Preferences>(`${apiRoot}/preferences`, {
        method: 'PUT',
        body: JSON.stringify(next),
      });
      setPreferences({ ...defaultPreferences, ...saved });
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const selectModel = async (model: string): Promise<void> => {
    const supportedEfforts = reasoningEffortsFor(models.find((choice) => choice.slug === model));
    const resetEffort = !supportedEfforts.includes(preferences.reasoningEffort);
    try {
      await updateModelSettings({ provider: 'chatgpt-plan', model });
      if (resetEffort) await savePreferences({ ...preferences, reasoningEffort: 'auto' });
    } catch (caught) {
      onError(errorMessage(caught));
    }
  };

  if (settings.provider !== 'chatgpt-plan') {
    return (
      <button
        type="button"
        className="button button-quiet"
        onClick={() =>
          void updateModelSettings({ provider: 'chatgpt-plan' }).catch((caught: unknown) =>
            onError(errorMessage(caught)),
          )
        }
      >
        Use ChatGPT account
      </button>
    );
  }

  if (!status?.connected) {
    return (
      <div className="chatgpt-composer-controls">
        <select aria-label="Model" disabled>
          <option>{loading ? 'Loading models…' : 'Connect ChatGPT account'}</option>
        </select>
        <button type="button" className="button button-quiet" onClick={() => openPage('pico.chatgpt-plan', 'account')}>
          Connect
        </button>
      </div>
    );
  }

  const supportedEfforts = reasoningEffortsFor(models.find((choice) => choice.slug === settings.model));
  return (
    <div className="chatgpt-composer-controls">
      <select
        className="chatgpt-model-select"
        aria-label="Model"
        value={settings.model}
        onChange={(event) => void selectModel(event.target.value)}
        disabled={loading}
      >
        {!settings.model ? (
          <option value="" disabled>
            {loading ? 'Loading models…' : 'Choose model'}
          </option>
        ) : null}
        {settings.model && !models.some((choice) => choice.slug === settings.model) ? (
          <option value={settings.model}>{settings.model} · saved</option>
        ) : null}
        {models.map((model) => (
          <option key={model.slug} value={model.slug}>
            {model.displayName}
          </option>
        ))}
      </select>
      <select
        className="chatgpt-reasoning-select"
        aria-label="Reasoning effort"
        value={preferences.reasoningEffort}
        onChange={(event) =>
          void savePreferences({
            ...preferences,
            reasoningEffort: event.target.value as Preferences['reasoningEffort'],
          })
        }
        disabled={saving}
      >
        {supportedEfforts.map((effort) => (
          <option key={effort} value={effort}>
            {reasoningEffortLabels[effort]}
          </option>
        ))}
      </select>
      <button
        type="button"
        role="switch"
        aria-label="Fast mode"
        aria-checked={preferences.fastMode}
        className={`chatgpt-fast-control ${preferences.fastMode ? 'enabled' : ''}`}
        onClick={() => void savePreferences({ ...preferences, fastMode: !preferences.fastMode })}
        disabled={saving}
      >
        <span>Fast mode</span>
        <i aria-hidden="true" />
      </button>
    </div>
  );
}

export const pluginWebUi = {
  pages: { account: AccountPage },
  components: { ChatGptPlanComposerModel },
};
