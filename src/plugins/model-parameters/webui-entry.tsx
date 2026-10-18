import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import './webui.css';
import { createPluginUiClient, PLUGIN_UI_PROTOCOL_VERSION, type PluginUiInitMessage } from '../ui-protocol.js';
import { pluginWebUi } from './webui.js';

const pluginId = 'pico.model-parameters';
const entry = 'webui';
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Model parameters plugin UI root is missing.');
const root = createRoot(rootElement);

function PluginView({
  init,
  client,
}: {
  init: PluginUiInitMessage;
  client: ReturnType<typeof createPluginUiClient>;
}): ReactElement {
  const [settings, setSettings] = useState(init.settings);
  const wrapper = useRef<HTMLDivElement>(null);
  const Component = pluginWebUi.components[init.viewId as keyof typeof pluginWebUi.components];

  useEffect(() => () => client.close(), [client]);
  useEffect(() => client.subscribeSettings(setSettings), [client]);
  useEffect(() => {
    document.body.classList.toggle('pico-plugin-popover', init.popover === true);
    return () => document.body.classList.remove('pico-plugin-popover');
  }, [init.popover]);
  useEffect(() => {
    const reportSize = (): void => client.resize(document.documentElement.scrollHeight);
    const observer = new ResizeObserver(reportSize);
    observer.observe(document.documentElement);
    reportSize();
    return () => observer.disconnect();
  }, [client]);

  if (!Component) return <p>This model parameter view is not available.</p>;
  return (
    <div
      ref={wrapper}
      className={`plugin-ui plugin-ui-${init.viewType}${init.popover ? ' plugin-ui-popover' : ''}`}
      data-pico-ui-slot={init.uiSlot}
      style={
        init.controlHeightPx === undefined
          ? undefined
          : ({ '--pico-composer-control-height': `${init.controlHeightPx}px` } as CSSProperties)
      }
    >
      <Component {...client.props(settings)} />
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
    init.viewType !== 'component' ||
    typeof init.viewId !== 'string' ||
    init.uiSlot !== 'composer.model' ||
    (init.popover !== undefined && typeof init.popover !== 'boolean') ||
    (init.controlHeightPx !== undefined &&
      (init.popover === true ||
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
