import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import './webui.css';
import {
  createPluginUiClient,
  PLUGIN_UI_PROTOCOL_VERSION,
  type PluginUiContext,
  type PluginUiInitMessage,
} from '../ui-protocol.js';
import { pluginWebUi } from './webui.js';

const pluginId = 'pico.chatgpt-plan';
const entry = 'webui';
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('ChatGPT plugin UI root element is missing.');
const root = createRoot(rootElement);

function PluginView({
  init,
  client,
}: {
  init: PluginUiInitMessage;
  client: ReturnType<typeof createPluginUiClient>;
}): ReactElement {
  const [settings, setSettings] = useState(init.settings);
  const [context, setContext] = useState(init.context);
  const Component =
    init.viewType === 'page'
      ? pluginWebUi.pages[init.viewId as keyof typeof pluginWebUi.pages]
      : pluginWebUi.components[init.viewId as keyof typeof pluginWebUi.components];

  useEffect(() => () => client.close(), [client]);
  useEffect(() => client.ready(init.attemptId), [client, init.attemptId]);
  useEffect(() => client.subscribeSettings(setSettings), [client]);
  useEffect(() => client.subscribeContext(setContext), [client]);
  useEffect(() => {
    const reportSize = (): void => client.resize(document.documentElement.scrollHeight);
    const observer = new ResizeObserver(reportSize);
    observer.observe(document.documentElement);
    reportSize();
    return () => observer.disconnect();
  }, [client]);

  if (!Component) return <p>This ChatGPT plugin view is not available.</p>;
  return (
    <div
      className={`plugin-ui plugin-ui-${init.viewType}`}
      data-pico-ui-slot={init.uiSlot}
      style={
        init.controlHeightPx === undefined
          ? undefined
          : ({ '--pico-composer-control-height': `${init.controlHeightPx}px` } as CSSProperties)
      }
    >
      <Component {...client.props(settings, context as PluginUiContext)} />
    </div>
  );
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const init = event.data as Partial<PluginUiInitMessage> | null;
  if (
    event.source !== window.parent ||
    !init ||
    init.type !== 'pico:plugin-ui:init' ||
    init.protocolVersion !== PLUGIN_UI_PROTOCOL_VERSION ||
    init.pluginId !== pluginId ||
    init.entry !== entry ||
    (init.viewType !== 'page' && init.viewType !== 'component') ||
    typeof init.viewId !== 'string' ||
    (init.uiSlot !== undefined &&
      !['thread.toolbar', 'composer.action', 'composer.model', 'sidebar.panel'].includes(init.uiSlot)) ||
    (init.controlHeightPx !== undefined &&
      (init.uiSlot !== 'composer.model' ||
        typeof init.controlHeightPx !== 'number' ||
        !Number.isFinite(init.controlHeightPx) ||
        init.controlHeightPx < 24 ||
        init.controlHeightPx > 64)) ||
    !init.settings ||
    event.ports.length !== 1
  ) {
    return;
  }
  const client = createPluginUiClient(event.ports[0]!, init.settings);
  root.render(<PluginView init={init as PluginUiInitMessage} client={client} />);
});
