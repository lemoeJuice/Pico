import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createPluginUiClient,
  PLUGIN_UI_PROTOCOL_VERSION,
  type PluginUiContext,
  type PluginUiInitMessage,
  type PluginUiNode,
} from '../ui-protocol.js';

const pluginId = 'pico.chatgpt-plan';
const apiRoot = '/api/plugins/pico.chatgpt-plan';
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('ChatGPT plugin UI root element is missing.');
const root = createRoot(rootElement);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
type ApiClient = ReturnType<typeof createPluginUiClient>;

function Controller({ init, client }: { init: PluginUiInitMessage; client: ApiClient }): ReactElement | null {
  const [settings, setSettings] = useState(init.settings);
  const [context, setContext] = useState(init.context as PluginUiContext);
  const [instanceId, setInstanceId] = useState(init.context.providerInstanceId ?? '');
  const [newLabel, setNewLabel] = useState('ChatGPT account');
  const refreshVersion = useRef(0);
  const [status, setStatus] = useState<{ connected: boolean; accountLabel?: string | null } | null>(null);
  const [models, setModels] = useState<Array<{ slug: string; displayName: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operationId, setOperationId] = useState<string | null>(null);
  const expectedOperationId = useRef<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [retryExchange, setRetryExchange] = useState(false);
  const [retrySent, setRetrySent] = useState(false);
  const api = useCallback(
    <T,>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: string }) =>
      client
        .props(settings, context)
        .api<T>(
          `${apiRoot}${path}${path === '/instances' ? '' : `${path.includes('?') ? '&' : '?'}instanceId=${encodeURIComponent(instanceId)}`}`,
          init,
        ),
    [client, settings, context, instanceId],
  );

  const refresh = useCallback(
    async (force = false) => {
      const version = ++refreshVersion.current;
      if (!instanceId) {
        setStatus(null);
        setModels([]);
        return;
      }
      setBusy(true);
      setError('');
      try {
        const next = await api<{ connected: boolean; accountLabel?: string | null }>('/status');
        const nextModels = next.connected
          ? await api<Array<{ slug: string; displayName: string }>>(
              force ? '/models/refresh' : '/models',
              force ? { method: 'POST' } : undefined,
            )
          : [];
        if (version !== refreshVersion.current) return;
        setStatus(next);
        setModels(nextModels);
      } catch (reason) {
        if (version !== refreshVersion.current) return;
        const message = errorText(reason);
        setError(message);
        client.props(settings, context).onError(message);
      } finally {
        if (version === refreshVersion.current) setBusy(false);
      }
    },
    [api, client, settings, context, instanceId],
  );
  useEffect(() => client.subscribeSettings(setSettings), [client]);
  useEffect(() => client.subscribeContext((value) => setContext(value as PluginUiContext)), [client]);
  useEffect(() => () => client.close(), [client]);
  useEffect(() => {
    client.ready(init.attemptId);
  }, [client, init.attemptId]);
  useEffect(() => {
    void api<Array<{ id: string; label: string }>>('/instances')
      .then((items) => {
        const selected = items.find((item) => item.id === init.context.providerInstanceId);
        if (selected) setNewLabel(selected.label);
        setInstanceId((current) => (items.some((item) => item.id === current) ? current : ''));
      })
      .catch((reason: unknown) => setError(errorText(reason)));
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      client.subscribeEvents((event) => {
        if (event.type !== 'external-auth-popup-result' || !event.data || typeof event.data !== 'object') return;
        const message = event.data as Record<string, unknown>;
        if (
          message.type !== 'pico:plugin-auth' ||
          message.pluginId !== pluginId ||
          typeof message.operationId !== 'string' ||
          message.operationId !== expectedOperationId.current ||
          !['connected', 'failed'].includes(String(message.status))
        )
          return;
        if (message.status === 'connected' || message.retryable !== true) {
          setOperationId(null);
          expectedOperationId.current = null;
        }
        setCallbackUrl('');
        setRetryExchange(false);
        setRetrySent(false);
        if (message.status === 'connected') {
          setError('');
          client
            .props(settings, context)
            .onNotice(typeof message.message === 'string' ? message.message : 'ChatGPT account connected.');
          void refresh();
        } else {
          const text = typeof message.message === 'string' ? message.message : 'ChatGPT sign-in failed.';
          setError(text);
          client.props(settings, context).onError(text);
          if (message.retryable !== true) setOperationId(null);
          if (message.retryExchange === true) setRetryExchange(true);
        }
      }),
    [client, settings, context, refresh],
  );

  useEffect(
    () =>
      client.subscribeActions((action) => {
        const id = action.actionId;
        if (id === 'instance.select') {
          setInstanceId(String(action.value ?? ''));
          setOperationId(null);
          expectedOperationId.current = null;
          setStatus(null);
          setModels([]);
          setError('');
          return;
        }
        if (id === 'instance.label') {
          setNewLabel(String(action.value ?? ''));
          return;
        }
        if (id === 'instance.create') {
          setBusy(true);
          setError('');
          void api<{ id: string; label: string }>('/instances', {
            method: 'POST',
            body: JSON.stringify({ label: newLabel }),
          })
            .then((instance) => {
              client.props(settings, context).onNotice('Provider added.');
              setInstanceId(instance.id);
              setStatus(null);
              setModels([]);
            })
            .catch((reason: unknown) => setError(errorText(reason)))
            .finally(() => setBusy(false));
          return;
        }
        if (id === 'instance.save') {
          setBusy(true);
          setError('');
          void api('/instances?edit=1', { method: 'PUT', body: JSON.stringify({ label: newLabel }) })
            .then(() => client.props(settings, context).onNotice('Provider saved.'))
            .catch((reason: unknown) => setError(errorText(reason)))
            .finally(() => setBusy(false));
          return;
        }
        if (id === 'account.refresh') {
          void refresh(true);
          return;
        }
        if (id === 'account.disconnect') {
          setBusy(true);
          void api('/account', { method: 'DELETE' })
            .then((result: any) => {
              setStatus({ connected: false, accountLabel: null });
              setModels([]);
              if (result.remoteRevoked) {
                client.props(settings, context).onNotice('ChatGPT account disconnected.');
              } else {
                client.props(settings, context).onError('Signed out locally; remote revocation was not confirmed.');
              }
            })
            .catch((reason: unknown) => {
              setError(errorText(reason));
              client.props(settings, context).onError(errorText(reason));
            })
            .finally(() => setBusy(false));
          return;
        }
        if (id === 'callback.url') {
          setCallbackUrl(String(action.value ?? ''));
          return;
        }
        if (id === 'callback.complete') {
          const operation = operationId,
            callback = callbackUrl.trim();
          if (!operation || !callback) return;
          setBusy(true);
          setError('');
          void api<any>('/sign-in/complete', {
            method: 'POST',
            body: JSON.stringify({ operationId: operation, callbackUrl: callback }),
          })
            .then(async (result) => {
              if (result.status === 'connected') {
                setOperationId(null);
                setCallbackUrl('');
                setRetryExchange(false);
                client.props(settings, context).onNotice(result.message);
                await refresh();
              } else {
                setError(result.message);
                if (result.retryExchange) setRetryExchange(true);
                else if (!result.retryable) setOperationId(null);
              }
            })
            .catch((reason: unknown) => {
              setError(errorText(reason));
              client.props(settings, context).onError(errorText(reason));
            })
            .finally(() => setBusy(false));
          return;
        }
        if (id === 'callback.retry') {
          if (!operationId || busy || retrySent) return;
          setBusy(true);
          setRetrySent(true);
          setRetryExchange(false);
          setError('');
          void api<any>('/sign-in/retry', { method: 'POST', body: JSON.stringify({ operationId }) })
            .then(async (result) => {
              if (result.status === 'connected') {
                setOperationId(null);
                client.props(settings, context).onNotice(result.message);
                await refresh();
              } else {
                setError(result.message);
                if (!result.retryExchange) setOperationId(null);
              }
            })
            .catch(async (reason: unknown) => {
              const message = errorText(reason);
              try {
                const state = await api<any>('/status');
                setStatus(state);
                if (state.connected) {
                  setModels(await api('/models'));
                  client
                    .props(settings, context)
                    .onNotice('The retry response was lost, but Runtime confirms ChatGPT is connected.');
                  return;
                }
              } catch {
                /* status could not confirm the lost response */
              }
              setError(`${message} The retry result could not be confirmed; start a new ChatGPT sign-in.`);
            })
            .finally(() => setBusy(false));
          return;
        }
        if (id === 'account.connect') {
          const leaseId = action.popupLeaseId;
          setBusy(true);
          setError('');
          setOperationId(null);
          expectedOperationId.current = null;
          setCallbackUrl('');
          setRetryExchange(false);
          setRetrySent(false);
          if (!leaseId) {
            setBusy(false);
            const message = 'The host could not open a secure sign-in popup. Try again.';
            setError(message);
            client.props(settings, context).onError(message);
            return;
          }
          void api<any>('/sign-in', { method: 'POST', body: '{}' })
            .then(async (result) => {
              if (typeof result.operationId !== 'string' || result.operationId.length === 0) {
                throw new Error('Runtime returned an invalid ChatGPT sign-in operation.');
              }
              expectedOperationId.current = result.operationId;
              setOperationId(result.operationId);
              await client.navigateAuthPopup(
                leaseId,
                result.authorizationUrl,
                result.callbackOrigin,
                result.operationId,
              );
            })
            .catch((reason: unknown) => {
              setError(errorText(reason));
              client.props(settings, context).onError(errorText(reason));
            })
            .finally(() => setBusy(false));
          return;
        }
      }),
    [client, api, refresh, settings, context, operationId, callbackUrl, busy, retrySent, newLabel],
  );

  const nodes: PluginUiNode[] = [];
  if (!instanceId)
    nodes.push(
      { type: 'textInput', label: 'Name', value: newLabel, actionId: 'instance.label', maxLength: 120, disabled: busy },
      { type: 'button', label: 'Add account', actionId: 'instance.create', disabled: busy || !newLabel.trim() },
    );
  if (init.context.providerInstanceId)
    nodes.push(
      { type: 'textInput', label: 'Name', value: newLabel, actionId: 'instance.label', maxLength: 120, disabled: busy },
      { type: 'button', label: 'Save name', actionId: 'instance.save', disabled: busy || !newLabel.trim() },
    );
  nodes.push({
    type: 'paragraph',
    text: 'Sign in with ChatGPT to use models available to your account. OAuth returns to 127.0.0.1. If the browser cannot reach Pico Runtime there, copy the full callback URL from the browser address bar and paste it below. Credentials remain with the Runtime.',
  });
  if (status?.connected)
    nodes.push(
      {
        type: 'status',
        text: `Connected as ${status.accountLabel ?? 'ChatGPT account'}`,
        tone: 'success',
      },
      { type: 'text', text: `${models.length} available model${models.length === 1 ? '' : 's'}` },
      ...(models.length
        ? [
            {
              type: 'list' as const,
              ordered: false,
              items: models.map((model) => ({ type: 'text' as const, text: model.displayName || model.slug })),
            },
          ]
        : []),
      {
        type: 'actions',
        children: [
          {
            type: 'button',
            label: busy ? 'Refreshing…' : 'Refresh models',
            actionId: 'account.refresh',
            tone: 'soft',
            disabled: busy,
          },
          {
            type: 'button',
            label: 'Reconnect',
            actionId: 'account.connect',
            tone: 'soft',
            disabled: busy,
            externalAuth: true,
          },
          { type: 'button', label: 'Disconnect', actionId: 'account.disconnect', tone: 'danger', disabled: busy },
        ],
      },
    );
  else if (instanceId)
    nodes.push({
      type: 'button',
      label: busy ? 'Loading…' : 'Continue with ChatGPT',
      actionId: 'account.connect',
      tone: 'primary',
      disabled: busy,
      externalAuth: true,
    });
  if (operationId) {
    if (retryExchange)
      nodes.push(
        {
          type: 'paragraph',
          text: 'Pico received the callback, but the token request did not return a response. Retry that request once without repeating sign-in. If ChatGPT already used the one-time code, the retry will fail and you will need to start a new sign-in.',
        },
        {
          type: 'button',
          label: busy ? 'Retrying…' : retrySent ? 'Retry request sent' : 'Retry token exchange',
          actionId: 'callback.retry',
          disabled: busy || retrySent,
        },
      );
    else
      nodes.push(
        {
          type: 'paragraph',
          text: 'If the sign-in popup shows a connection error, copy its full address bar URL and paste it here. The URL contains a one-time authorization code; do not share it.',
        },
        {
          type: 'textInput',
          label: 'Callback URL',
          value: callbackUrl,
          placeholder: 'Paste the full callback URL',
          actionId: 'callback.url',
          maxLength: 20000,
          disabled: busy,
        },
        {
          type: 'button',
          label: busy ? 'Completing…' : 'Complete sign-in',
          actionId: 'callback.complete',
          disabled: busy || !callbackUrl.trim(),
        },
      );
  }
  if (error) nodes.push({ type: 'paragraph', text: error });
  client.render(nodes);
  return null;
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const init = event.data as Partial<PluginUiInitMessage> | null;
  if (
    event.source !== window.parent ||
    !init ||
    init.type !== 'pico:plugin-ui:init' ||
    init.protocolVersion !== PLUGIN_UI_PROTOCOL_VERSION ||
    init.pluginId !== pluginId ||
    init.entry !== 'webui' ||
    (init.viewType !== 'page' && init.viewType !== 'component') ||
    typeof init.viewId !== 'string' ||
    (init.viewType === 'page' && init.viewId !== 'account') ||
    (init.viewType === 'component' && init.viewId !== 'ChatGptPlanComposerModel') ||
    !init.settings ||
    event.ports.length !== 1
  )
    return;
  const client = createPluginUiClient(event.ports[0]!, init.settings);
  root.render(<Controller init={init as PluginUiInitMessage} client={client} />);
});
