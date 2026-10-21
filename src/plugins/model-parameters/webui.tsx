import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { PublicSettings } from '../../core/types.js';
import type { PluginUiProps } from '../ui-protocol.js';
import type {
  ModelParameterControl,
  ModelParameterSelection,
  ModelParameterTarget,
  ModelParameterValue,
  ModelParameterProfileView,
} from './types.js';
import { modelParameterTargetFromSettings } from './target.js';

const apiRoot = '/api/plugins/pico.model-parameters';

function targetFromSettings(settings: PublicSettings): ModelParameterTarget {
  return modelParameterTargetFromSettings(settings);
}

function profilePath(target: ModelParameterTarget, threadId: string): string {
  const query = new URLSearchParams();
  query.set('provider', target.provider);
  query.set('endpoint', target.endpoint);
  query.set('protocol', target.protocol);
  query.set('model', target.model);
  query.set('threadId', threadId);
  return `${apiRoot}/profile?${query.toString()}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Control({
  control,
  value,
  disabled,
  onChange,
}: {
  control: ModelParameterControl;
  value: ModelParameterValue | undefined;
  disabled: boolean;
  onChange(value: ModelParameterValue): void;
}): ReactElement {
  const isPrimaryReasoningChoice = control.id === 'reasoningEffort' && control.group === 'primary';

  if (control.kind === 'select') {
    return (
      <label className="model-parameter-control">
        {isPrimaryReasoningChoice ? null : <span>{control.label}</span>}
        <select
          className={`pico-ui-control${isPrimaryReasoningChoice ? ' model-parameter-reasoning' : ''}`}
          aria-label={control.label}
          value={typeof value === 'string' ? value : String(control.defaultValue ?? '')}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {isPrimaryReasoningChoice ? (
            <option value="" disabled>
              reasoning...
            </option>
          ) : null}
          {control.options?.map((option) => (
            <option value={option.value} key={option.value}>
              {isPrimaryReasoningChoice ? option.value.toLowerCase() : option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (control.kind === 'range') {
    const numericValue =
      typeof value === 'number' ? value : ((control.defaultValue as number | undefined) ?? control.min ?? 0);
    return (
      <label className="model-parameter-range">
        <span>{control.label}</span>
        <strong>{numericValue}</strong>
        <input
          type="range"
          aria-label={control.label}
          min={control.min}
          max={control.max}
          step={control.step}
          value={numericValue}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    );
  }

  const checked = value === true;
  return (
    <label className="model-parameter-toggle">
      <span>{control.label}</span>
      <button
        type="button"
        role="switch"
        aria-label={control.label}
        aria-checked={checked}
        disabled={disabled}
        className={`model-parameter-switch ${checked ? 'enabled' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <i aria-hidden="true" />
      </button>
    </label>
  );
}

function useProfile(props: PluginUiProps): {
  target: ModelParameterTarget;
  profile: ModelParameterProfileView | null;
  loading: boolean;
  saving: boolean;
  saveSelection(control: ModelParameterControl, value: ModelParameterValue): Promise<void>;
} {
  const { api, onError, settings } = props;
  const [profile, setProfile] = useState<ModelParameterProfileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const threadId = props.context.thread?.id ?? '';
  const selection = props.context.modelSelection;
  const target = {
    ...targetFromSettings(settings),
    ...(selection ? { provider: selection.provider, model: selection.model } : {}),
  };
  const requestSequence = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current;
    if (!threadId || !target.endpoint || !target.model) {
      setProfile(null);
      return;
    }
    setLoading(true);
    try {
      const loaded = await api<ModelParameterProfileView>(profilePath(target, threadId));
      if (sequence === requestSequence.current) setProfile(loaded);
    } catch (error) {
      if (sequence === requestSequence.current) {
        setProfile(null);
        onError(errorText(error));
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [api, onError, threadId, target.provider, target.endpoint, target.protocol, target.model]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveSelection = async (control: ModelParameterControl, value: ModelParameterValue): Promise<void> => {
    if (!profile || !threadId) return;
    const savedThreadId = threadId;
    const sequence = requestSequence.current;
    const selection: ModelParameterSelection = { ...profile.values, [control.id]: value };
    setSaving(true);
    try {
      const updated = await api<ModelParameterProfileView>(`${apiRoot}/selection`, {
        method: 'PUT',
        body: JSON.stringify({ target, selection, threadId: savedThreadId }),
      });
      if (props.context.thread?.id !== savedThreadId || requestSequence.current !== sequence) return;
      setProfile(updated);
    } catch (error) {
      onError(errorText(error));
      await reload();
    } finally {
      setSaving(false);
    }
  };

  return { target, profile, loading, saving, saveSelection };
}

function ParameterControls({
  props,
  group,
}: {
  props: PluginUiProps;
  group: 'primary' | 'others';
}): ReactElement | null {
  const { target, profile, loading, saving, saveSelection } = useProfile(props);
  const { settings, updateModelSettings, onError } = props;
  const selectedTemperature = props.context.modelSelection?.parameters.temperature ?? settings.temperature;
  const [temperatureDraft, setTemperatureDraft] = useState(selectedTemperature);

  useEffect(() => setTemperatureDraft(selectedTemperature), [selectedTemperature, props.context.thread?.id]);
  useEffect(() => {
    const temperature = profile?.temperature;
    if (!temperature || group !== 'others' || temperature.mode !== 'adjustable') return;
    if (temperatureDraft === selectedTemperature) return;
    const timer = window.setTimeout(() => {
      void updateModelSettings({ temperature: temperatureDraft }, props.context.thread?.id).catch((error: unknown) => {
        onError(errorText(error));
        setTemperatureDraft(selectedTemperature);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [group, onError, profile?.temperature, selectedTemperature, temperatureDraft, updateModelSettings]);

  if (!profile)
    return group === 'others' ? <p className="model-parameter-empty">Choose a model to view its settings.</p> : null;
  const controls = profile.controls.filter((control) => control.group === group);
  if (group === 'primary' && controls.length === 0) return null;

  return (
    <div className={`model-parameter-controls model-parameter-controls-${group}`} aria-busy={loading || saving}>
      {controls.map((control) => (
        <Control
          control={control}
          value={profile.values[control.id]}
          disabled={loading || saving}
          onChange={(value) => void saveSelection(control, value)}
          key={control.id}
        />
      ))}
      {group === 'others' ? (
        profile.temperature.mode === 'adjustable' ? (
          <label className="model-parameter-range">
            <span>Temperature</span>
            <strong>{Number(temperatureDraft).toFixed(1)}</strong>
            <input
              type="range"
              min={profile.temperature.min}
              max={profile.temperature.max}
              step={profile.temperature.step}
              value={Math.max(profile.temperature.min, Math.min(profile.temperature.max, temperatureDraft))}
              onChange={(event) => setTemperatureDraft(Number(event.target.value))}
            />
          </label>
        ) : profile.temperature.mode === 'fixed' ? (
          <p className="model-parameter-fixed">Temperature · fixed at {profile.temperature.value}</p>
        ) : null
      ) : null}
      {group === 'others' && controls.length === 0 && profile.temperature.mode === 'unsupported' ? (
        <p className="model-parameter-empty">No additional settings are available for {target.model}.</p>
      ) : null}
    </div>
  );
}

export function ModelParameterComposer(props: PluginUiProps): ReactElement | null {
  return <ParameterControls props={props} group="primary" />;
}

export function ModelParameterOthers(props: PluginUiProps): ReactElement {
  return <ParameterControls props={props} group="others" />;
}

export const pluginWebUi = {
  components: { ModelParameterComposer, ModelParameterOthers },
};
