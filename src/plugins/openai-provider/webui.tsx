import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createPluginUiClient,
  PLUGIN_UI_PROTOCOL_VERSION,
  type PluginUiInitMessage,
  type PluginUiNode,
} from '../ui-protocol.js';
import { providerInstanceRequest } from './form.js';

const pluginId = 'pico.openai-provider';
const element = document.getElementById('root');
if (!element) throw new Error('Provider UI root is missing.');
const root = createRoot(element);
type Client = ReturnType<typeof createPluginUiClient>;
function AddProvider({ init, client }: { init: PluginUiInitMessage; client: Client }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState('openai-chat-completions');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const instanceId = init.context.providerInstanceId;
  useEffect(() => {
    if (!instanceId) return;
    setBusy(true);
    void client
      .props(init.settings, init.context)
      .api<Array<{ id: string; label: string; config: { baseUrl: string; protocol: string; models: string[] } }>>(
        '/api/plugins/pico.openai-provider/instances',
      )
      .then((items) => {
        const item = items.find((entry) => entry.id === instanceId);
        if (!item) throw new Error('Provider instance unavailable.');
        setBaseUrl(item.config.baseUrl ?? '');
        setProtocol(item.config.protocol ?? 'openai-chat-completions');
        setModels((item.config.models ?? []).join('\n'));
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false));
  }, [client, init, instanceId]);
  useEffect(() => {
    client.ready(init.attemptId);
    return () => client.close();
  }, [client, init.attemptId]);
  useEffect(
    () =>
      client.subscribeActions((action) => {
        if (action.actionId === 'baseUrl') setBaseUrl(String(action.value ?? ''));
        if (action.actionId === 'protocol') setProtocol(String(action.value ?? ''));
        if (action.actionId === 'apiKey') setApiKey(String(action.value ?? ''));
        if (action.actionId === 'models') setModels(String(action.value ?? ''));
        if (action.actionId === 'save' && instanceId && !busy) {
          setBusy(true);
          setError('');
          setSaved(false);
          setRefreshFailed(false);
          void client
            .props(init.settings, init.context)
            .api<{ refreshFailed?: boolean }>(
              `/api/plugins/pico.openai-provider/instances?instanceId=${encodeURIComponent(instanceId)}`,
              {
                method: 'PUT',
                body: JSON.stringify(providerInstanceRequest({ baseUrl, protocol, apiKey, models })),
              },
            )
            .then((result) => {
              setRefreshFailed(result.refreshFailed === true);
              setApiKey('');
              setSaved(true);
              client.props(init.settings, init.context).onNotice('Provider saved.');
            })
            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setBusy(false));
        }
      }),
    [client, init, instanceId, baseUrl, protocol, apiKey, models, busy],
  );
  const nodes: PluginUiNode[] = !instanceId
    ? [{ type: 'paragraph', text: 'Add a Provider in Settings, then expand its card to configure it.' }]
    : [
        { type: 'heading', text: 'Edit OpenAI-compatible Provider' },
        {
          type: 'textInput',
          label: 'API base URL',
          value: baseUrl,
          actionId: 'baseUrl',
          placeholder: 'https://api.openai.com/v1',
          disabled: busy,
        },
        {
          type: 'select',
          label: 'Protocol',
          value: protocol,
          actionId: 'protocol',
          options: [
            { label: 'Chat Completions', value: 'openai-chat-completions' },
            { label: 'Responses', value: 'openai-responses' },
          ],
          disabled: busy,
        },
        {
          type: 'textInput',
          label: 'API key',
          value: apiKey,
          actionId: 'apiKey',
          inputType: 'password',
          placeholder: 'Leave blank to keep current key',
          disabled: busy,
        },
        { type: 'textArea', label: 'Models (one per line)', value: models, actionId: 'models', disabled: busy },
        {
          type: 'button',
          label: busy ? 'Saving…' : 'Save Provider',
          actionId: 'save',
          tone: 'primary',
          disabled: busy || !baseUrl.trim() || !models.trim(),
        },
      ];
  if (saved) nodes.push({ type: 'status', text: 'Provider saved.', tone: 'success' });
  if (refreshFailed)
    nodes.push({
      type: 'paragraph',
      text: 'Provider settings were saved, but model refresh failed. Save again to retry the refresh.',
    });
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
    init.viewType !== 'page' ||
    typeof init.viewId !== 'string' ||
    !init.settings ||
    event.ports.length !== 1
  )
    return;
  const client = createPluginUiClient(event.ports[0]!, init.settings);
  root.render(<AddProvider init={init as PluginUiInitMessage} client={client} />);
});
