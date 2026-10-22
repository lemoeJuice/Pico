import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createPluginUiClient,
  PLUGIN_UI_PROTOCOL_VERSION,
  type PluginUiContext,
  type PluginUiInitMessage,
  type PluginUiNode,
} from '../ui-protocol.js';
import { modelParameterTargetFromSettings } from './target.js';
import type { ModelParameterControl, ModelParameterProfileView, ModelParameterSelection, ModelParameterTarget, ModelParameterValue } from './types.js';

const pluginId = 'pico.model-parameters';
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Model parameters plugin UI root is missing.');
const root = createRoot(rootElement);
const apiRoot = '/api/plugins/pico.model-parameters';
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function Controller({ init, client }: { init: PluginUiInitMessage; client: ReturnType<typeof createPluginUiClient> }): ReactElement | null {
  const [settings, setSettings] = useState(init.settings);
  const [context, setContext] = useState(init.context as PluginUiContext);
  const [profile, setProfile] = useState<ModelParameterProfileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [temperatureDraft, setTemperatureDraft] = useState(context.modelSelection?.parameters.temperature ?? settings.temperature);
  const [error, setError] = useState('');
  const actions = useMemo(() => new Map<string, { kind: 'profile'; control?: ModelParameterControl }>(), []);
  const target = useMemo<ModelParameterTarget>(() => {
    const selected = context.modelSelection;
    return { ...modelParameterTargetFromSettings(settings), ...(selected ? { provider: selected.provider, model: selected.model } : {}) };
  }, [settings, context.modelSelection]);
  const threadId = context.thread?.id ?? '';
  const profileUrl = useMemo(() => {
    const query = new URLSearchParams({ provider: target.provider, endpoint: target.endpoint, protocol: target.protocol, model: target.model, threadId });
    return `${apiRoot}/profile?${query}`;
  }, [target.provider, target.endpoint, target.protocol, target.model, threadId]);
  useEffect(() => client.subscribeSettings(setSettings), [client]);
  useEffect(() => client.subscribeContext((value) => setContext(value as PluginUiContext)), [client]);
  useEffect(() => () => client.close(), [client]);
  useEffect(() => { client.ready(init.attemptId); }, [client, init.attemptId]);
  useEffect(() => { let live = true; if (!threadId || !target.endpoint || !target.model) { setProfile(null); return; } setLoading(true); void client.props(settings, context).api<ModelParameterProfileView>(profileUrl).then((value) => { if (live) { setProfile(value); setError(''); } }).catch((reason: unknown) => { if (live) { setProfile(null); setError(errorText(reason)); client.props(settings, context).onError(errorText(reason)); } }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [client, profileUrl, threadId, target.endpoint, target.model, settings, context]);
  useEffect(() => setTemperatureDraft(context.modelSelection?.parameters.temperature ?? settings.temperature), [settings.temperature, context.modelSelection?.parameters.temperature, threadId]);
  useEffect(() => {
    if (!profile || init.viewId !== 'ModelParameterOthers' || profile.temperature.mode !== 'adjustable' || temperatureDraft === (context.modelSelection?.parameters.temperature ?? settings.temperature)) return;
    const timer = window.setTimeout(() => { void client.props(settings, context).updateModelSettings({ temperature: temperatureDraft }, threadId).catch((reason: unknown) => { setError(errorText(reason)); setTemperatureDraft(context.modelSelection?.parameters.temperature ?? settings.temperature); }); }, 180);
    return () => window.clearTimeout(timer);
  }, [client, profile, init.viewId, temperatureDraft, context, settings, threadId]);
  useEffect(() => client.subscribeActions((action) => {
    if (action.actionId === 'temperature') {
      const next = Number(action.value);
      if (Number.isFinite(next)) setTemperatureDraft(next);
      return;
    }
    const control = actions.get(action.actionId)?.control;
    if (!control || !profile || !threadId) return;
    const value: ModelParameterValue =
      control.kind === 'toggle'
        ? action.value === 'true'
        : control.kind === 'range'
          ? Number(action.value)
          : String(action.value ?? '');
    if (control.kind === 'range' && !Number.isFinite(value as number)) return;
    const selection: ModelParameterSelection = { ...profile.values, [control.id]: value };
    setSaving(true); setError('');
    void client.props(settings, context).api<ModelParameterProfileView>(`${apiRoot}/selection`, { method: 'PUT', body: JSON.stringify({ target, selection, threadId }) }).then(setProfile).catch((reason: unknown) => { setError(errorText(reason)); client.props(settings, context).onError(errorText(reason)); }).finally(() => setSaving(false));
  }), [client, actions, profile, threadId, settings, context, target]);
  if (!profile) {
    client.render(
      init.viewId === 'ModelParameterOthers'
        ? [{ type: 'text', text: error || (loading ? 'Loading model settings…' : 'Choose a model to view its settings.') }]
        : [],
    );
    return null;
  }
  const group = init.viewId === 'ModelParameterComposer' ? 'primary' : 'others';
  const nodes: PluginUiNode[] = [];
  for (const control of profile.controls.filter((item) => item.group === group)) {
    const actionId = `control:${control.id}`;
    actions.set(actionId, { kind: 'profile', control });
    const value = profile.values[control.id] ?? control.defaultValue;
    const disabled = loading || saving;
    if (control.kind === 'select') {
      nodes.push({
        type: 'select',
        label: control.label,
        value: typeof value === 'string' ? value : '',
        actionId,
        disabled,
        options: (control.options ?? []).map((option) => ({ label: option.label, value: option.value })),
      });
    } else if (control.kind === 'toggle') {
      nodes.push({ type: 'switch', label: control.label, checked: value === true, actionId, disabled });
    } else if (control.kind === 'range') {
      const min = control.min ?? 0;
      const max = control.max ?? 100;
      const numericValue = typeof value === 'number' ? value : Number(control.defaultValue ?? min);
      nodes.push({
        type: 'range',
        label: control.label,
        value: Math.min(max, Math.max(min, numericValue)),
        min,
        max,
        step: control.step ?? 1,
        actionId,
        disabled,
      });
    }
  }
  if (group === 'others') {
    if (profile.temperature.mode === 'adjustable') {
      const { min, max, step } = profile.temperature;
      const boundedTemperature = Math.min(max, Math.max(min, temperatureDraft));
      nodes.push({
        type: 'range',
        label: 'Temperature',
        value: boundedTemperature,
        min,
        max,
        step,
        valueLabel: boundedTemperature.toFixed(1),
        actionId: 'temperature',
        disabled: loading || saving,
      });
    }
    else if (profile.temperature.mode === 'fixed') nodes.push({ type: 'text', text: `Temperature · fixed at ${profile.temperature.value}` });
    else if (!nodes.length) nodes.push({ type: 'text', text: `No additional settings are available for ${target.model}.` });
  }
  if (error && group === 'others') nodes.push({ type: 'text', text: error });
  client.render(nodes);
  return null;
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const init = event.data as Partial<PluginUiInitMessage> | null;
  if (event.source !== window.parent || !init || init.type !== 'pico:plugin-ui:init' || init.protocolVersion !== PLUGIN_UI_PROTOCOL_VERSION || init.pluginId !== pluginId || init.entry !== 'webui' || init.viewType !== 'component' || typeof init.viewId !== 'string' || init.uiSlot !== 'composer.model' || !init.settings || event.ports.length !== 1) return;
  const client = createPluginUiClient(event.ports[0]!, init.settings);
  root.render(<Controller init={init as PluginUiInitMessage} client={client} />);
});
