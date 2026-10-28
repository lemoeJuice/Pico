import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type {
  AdapterContribution,
  AdapterControl,
  CatalogModel,
  CatalogSelection,
  ModelOptionValue,
  ProviderInstance,
} from '../contracts/model-catalog.js';

export interface ModelSelectionProps {
  models: CatalogModel[];
  instances: ProviderInstance[];
  selection: (CatalogSelection & { unavailableReason?: string }) | null;
  loadAdapters(modelId: string): Promise<AdapterContribution[]>;
  onSave(selection: CatalogSelection): Promise<void>;
}

export function selectionForAdapter(
  model: CatalogModel,
  adapter: AdapterContribution,
  temperature: string,
  options: Record<string, ModelOptionValue>,
): CatalogSelection {
  const value = temperature === '' ? undefined : Number(temperature);
  if (
    value !== undefined &&
    (!adapter.temperature.supported ||
      (adapter.temperature.fixedValue !== undefined && value !== adapter.temperature.fixedValue) ||
      !Number.isFinite(value) ||
      (adapter.temperature.min !== undefined && value < adapter.temperature.min) ||
      (adapter.temperature.max !== undefined && value > adapter.temperature.max))
  )
    throw new Error('Enter a valid temperature within the supported range.');
  for (const control of adapter.controls) {
    const option = options[control.id];
    if (option === undefined) continue;
    if (
      typeof option !== control.type ||
      (control.choices && !control.choices.includes(option)) ||
      (typeof option === 'number' &&
        (!Number.isFinite(option) ||
          (control.min !== undefined && option < control.min) ||
          (control.max !== undefined && option > control.max)))
    )
      throw new Error(`Enter a valid ${control.label}.`);
  }
  return {
    modelId: model.modelId,
    adapterId: adapter.id,
    parameters: { ...(value === undefined ? {} : { temperature: value }), options: { ...options } },
  };
}

export function selectionForActiveThread<T extends { thread: { id: string }; modelSelection: S }, S>(
  snapshot: T | null,
  activeThreadId: string | null,
  targetThreadId: string,
  selection: S,
): T | null {
  return activeThreadId === targetThreadId && snapshot?.thread.id === targetThreadId
    ? { ...snapshot, modelSelection: selection }
    : snapshot;
}

export class LatestModelRequest {
  private generation = 0;
  begin(): () => boolean {
    const generation = ++this.generation;
    return () => this.generation === generation;
  }
  invalidate(): void {
    this.generation += 1;
  }
}

/** Anchor the compact chooser to its trigger and keep it inside the viewport. */
export function modelSelectionPosition(
  rect: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
): CSSProperties {
  const margin = 16;
  const width = Math.min(536, Math.max(0, viewport.width - margin * 2));
  const left = Math.max(margin, Math.min(rect.left, viewport.width - width - margin));
  const above = Math.max(0, rect.top - margin - 8);
  const below = Math.max(0, viewport.height - rect.bottom - margin - 8);
  const upward = above >= below;
  return {
    left,
    width,
    maxHeight: Math.min(420, upward ? above : below),
    ...(upward ? { bottom: viewport.height - rect.top + 8 } : { top: rect.bottom + 8 }),
  };
}

function ParameterField({
  control,
  value,
  disabled,
  className = '',
  onChange,
}: {
  control: AdapterControl;
  value: ModelOptionValue | undefined;
  disabled: boolean;
  className?: string;
  onChange(value: ModelOptionValue | undefined): void;
}) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => setDraft(String(value ?? '')), [value]);
  if (control.choices) {
    return (
      <label className={`model-selection-parameter ${className}`}>
        <span>{control.label}</span>
        <select
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(event) => {
            const selected = control.choices?.find((choice) => String(choice) === event.target.value);
            onChange(selected);
          }}
        >
          <option value="">
            {control.defaultValue === undefined
              ? 'Default'
              : `Default (${control.choiceLabels?.[String(control.defaultValue)] ?? String(control.defaultValue)})`}
          </option>
          {control.choices.map((choice) => (
            <option key={String(choice)} value={String(choice)}>
              {control.choiceLabels?.[String(choice)] ?? String(choice)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (control.type === 'boolean') {
    return (
      <label className={`model-selection-parameter ${className}`}>
        <span>{control.label}</span>
        <select
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
        >
          <option value="">Default</option>
          <option value="true">On</option>
          <option value="false">Off</option>
        </select>
      </label>
    );
  }
  return (
    <label className={`model-selection-parameter ${className}`}>
      <span>{control.label}</span>
      <input
        type={control.type === 'number' ? 'number' : 'text'}
        step={control.type === 'number' ? (control.step ?? 'any') : undefined}
        min={control.min}
        max={control.max}
        value={draft}
        placeholder={control.defaultValue === undefined ? 'Default' : `Default (${String(control.defaultValue)})`}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onChange(draft === '' ? undefined : control.type === 'number' ? Number(draft) : draft)}
      />
    </label>
  );
}

/** Shared chooser for Thread and plugin model selections. */
export function ModelSelection({ models, instances, selection, loadAdapters, onSave }: ModelSelectionProps) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [model, setModel] = useState<CatalogModel | null>(null);
  const [adapters, setAdapters] = useState<AdapterContribution[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adapterStatus, setAdapterStatus] = useState<'checking' | 'available' | 'unavailable'>('checking');
  const [position, setPosition] = useState<CSSProperties>({});
  const request = useRef(new LatestModelRequest());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      request.current.invalidate();
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    setAdapterStatus('checking');
    if (!selection?.modelId || !selection.adapterId) {
      setAdapterStatus('unavailable');
      return () => {
        alive = false;
      };
    }
    void loadAdapters(selection.modelId)
      .then((items) => {
        if (alive) {
          setAdapters(items);
          setAdapterStatus(items.some((item) => item.id === selection.adapterId) ? 'available' : 'unavailable');
        }
      })
      .catch(() => {
        if (alive) setAdapterStatus('checking');
      });
    return () => {
      alive = false;
    };
  }, [selection?.modelId, selection?.adapterId, loadAdapters]);

  const selectedModel = models.find((item) => item.modelId === selection?.modelId);
  const selectedAdapter = adapters.find((item) => item.id === selection?.adapterId) ?? null;
  const [temperatureDraft, setTemperatureDraft] = useState('');
  useEffect(
    () => setTemperatureDraft(String(selection?.parameters.temperature ?? '')),
    [selection?.modelId, selection?.adapterId, selection?.parameters.temperature],
  );
  const activeLabel =
    selectedModel &&
    selectedModel.availability !== 'unavailable' &&
    adapterStatus !== 'unavailable' &&
    !selection?.unavailableReason
      ? selectedModel.label
      : 'Choose model...';

  useLayoutEffect(() => {
    if (!modelsOpen) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPosition(modelSelectionPosition(rect, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [modelsOpen]);

  useEffect(() => {
    if (modelsOpen) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [modelsOpen]);

  useEffect(() => {
    if (!modelsOpen && !parametersOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        menuRef.current?.contains(event.target) ||
        triggerRef.current?.contains(event.target) ||
        moreMenuRef.current?.contains(event.target) ||
        moreRef.current?.contains(event.target)
      )
        return;
      setModelsOpen(false);
      setParametersOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (parametersOpen) setParametersOpen(false);
      else setModelsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [modelsOpen, parametersOpen]);

  async function chooseModel(next: CatalogModel) {
    const isCurrent = request.current.begin();
    setModel(next);
    setAdapters([]);
    setError('');
    setLoading(true);
    try {
      const result = await loadAdapters(next.modelId);
      if (isCurrent()) setAdapters(result);
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  async function save(next: CatalogSelection, closeOnSuccess = true) {
    setSaving(true);
    setError('');
    try {
      await onSave(next);
      if (closeOnSuccess) {
        setModelsOpen(false);
        setParametersOpen(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function chooseAdapter(next: AdapterContribution) {
    if (!model) return;
    const sameSelection = selection?.modelId === model.modelId && selection.adapterId === next.id;
    const temperature =
      sameSelection && selection.parameters.temperature != null ? String(selection.parameters.temperature) : '';
    const options = sameSelection ? { ...selection.parameters.options } : {};
    try {
      await save(selectionForAdapter(model, next, temperature, options));
      setAdapters((current) => (current.some((item) => item.id === next.id) ? current : [...current, next]));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function saveOption(control: AdapterControl, value: ModelOptionValue | undefined) {
    if (!selectedModel || !selectedAdapter || !selection) return;
    const options = { ...selection.parameters.options };
    if (value === undefined) delete options[control.id];
    else options[control.id] = value;
    try {
      void save(
        selectionForAdapter(selectedModel, selectedAdapter, String(selection.parameters.temperature ?? ''), options),
        false,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function saveTemperature(value: string) {
    if (!selectedModel || !selectedAdapter || !selection) return;
    try {
      void save(selectionForAdapter(selectedModel, selectedAdapter, value, selection.parameters.options), false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const primaryControls = selectedAdapter?.controls.filter((control) => control.group === 'primary') ?? [];
  const otherControls = selectedAdapter?.controls.filter((control) => control.group !== 'primary') ?? [];
  const hasOtherParameters = Boolean(otherControls.length || selectedAdapter?.temperature.supported);

  return (
    <div className="model-selection">
      <button
        type="button"
        ref={triggerRef}
        className="composer-model-name"
        onClick={() => setModelsOpen((current) => !current)}
        aria-expanded={modelsOpen}
        aria-haspopup="dialog"
      >
        <span>{activeLabel}</span>
        <span className="model-selection-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {selection?.unavailableReason || (adapterStatus === 'unavailable' && selection?.adapterId) ? (
        <span className="model-selection-unavailable" role="status">
          {selection.unavailableReason ?? 'Saved model or adapter is unavailable. Choose again.'}
        </span>
      ) : null}
      {selectedAdapter?.temperature.supported ? (
        <label className="model-selection-inline-parameter">
          <span>Temperature</span>
          <input
            aria-label="Temperature"
            type="number"
            value={
              selectedAdapter.temperature.fixedValue === undefined
                ? temperatureDraft
                : String(selectedAdapter.temperature.fixedValue)
            }
            step={selectedAdapter.temperature.step ?? 'any'}
            disabled={saving || selectedAdapter.temperature.fixedValue !== undefined}
            min={selectedAdapter.temperature.min}
            max={selectedAdapter.temperature.max}
            placeholder="Default"
            onChange={(event) => setTemperatureDraft(event.target.value)}
            onBlur={() => saveTemperature(temperatureDraft)}
          />
        </label>
      ) : null}
      {primaryControls.map((control) => (
        <ParameterField
          key={control.id}
          control={control}
          value={selection?.parameters.options[control.id]}
          disabled={saving}
          className="model-selection-primary-inline"
          onChange={(value) => saveOption(control, value)}
        />
      ))}
      {hasOtherParameters || primaryControls.length ? (
        <>
          <button
            type="button"
            ref={moreRef}
            className={`model-selection-more ${hasOtherParameters ? '' : 'model-selection-more-mobile-only'}`}
            aria-expanded={parametersOpen}
            onClick={() => setParametersOpen((current) => !current)}
          >
            More
          </button>
          {parametersOpen
            ? createPortal(
                <div
                  ref={moreMenuRef}
                  className="model-selection-more-menu"
                  role="group"
                  aria-label="More model parameters"
                >
                  {primaryControls.map((control) => (
                    <ParameterField
                      key={`mobile-${control.id}`}
                      control={control}
                      value={selection?.parameters.options[control.id]}
                      disabled={saving}
                      className="model-selection-primary-in-more"
                      onChange={(value) => saveOption(control, value)}
                    />
                  ))}
                  {otherControls.map((control) => (
                    <ParameterField
                      key={control.id}
                      control={control}
                      value={selection?.parameters.options[control.id]}
                      disabled={saving}
                      onChange={(value) => saveOption(control, value)}
                    />
                  ))}
                  {selectedAdapter?.temperature.supported ? (
                    <>
                      <label className="model-selection-parameter model-selection-mobile-temperature">
                        <span>Temperature</span>
                        <input
                          type="number"
                          value={
                            selectedAdapter.temperature.fixedValue === undefined
                              ? temperatureDraft
                              : String(selectedAdapter.temperature.fixedValue)
                          }
                          step={selectedAdapter.temperature.step ?? 'any'}
                          disabled={saving || selectedAdapter.temperature.fixedValue !== undefined}
                          min={selectedAdapter.temperature.min}
                          max={selectedAdapter.temperature.max}
                          placeholder="Default"
                          onChange={(event) => setTemperatureDraft(event.target.value)}
                          onBlur={() => saveTemperature(temperatureDraft)}
                        />
                      </label>
                      <p className="model-selection-parameter-note">
                        {selectedAdapter.temperature.description ??
                          'Temperature is available beside the model selector.'}
                      </p>
                    </>
                  ) : null}
                </div>,
                document.body,
              )
            : null}
        </>
      ) : null}
      {error ? (
        <span className="model-selection-error" role="alert">
          {error}
        </span>
      ) : null}
      {modelsOpen
        ? createPortal(
            <div
              ref={menuRef}
              style={position}
              className="model-selection-panel"
              role="dialog"
              aria-label="Choose model"
            >
              <div className="model-selection-models">
                <div className="model-selection-placeholder" aria-hidden="true">
                  Choose model...
                </div>
                {models.length === 0 ? (
                  <p className="model-selection-empty">No models available. Add a Provider in settings.</p>
                ) : null}
                {models.map((item) => {
                  const source =
                    instances.find((instance) => instance.id === item.instanceId)?.label ?? item.instanceId;
                  return (
                    <button
                      type="button"
                      key={item.modelId}
                      disabled={item.availability === 'unavailable' || saving}
                      aria-pressed={model?.modelId === item.modelId}
                      title={`${item.label} — ${source}`}
                      onClick={() => void chooseModel(item)}
                    >
                      <span className="model-selection-model-label">{item.label}</span>
                      <span className="model-selection-model-source">{source}</span>
                    </button>
                  );
                })}
              </div>
              <div className="model-selection-adapters" aria-live="polite">
                {model ? (
                  <>
                    <div className="model-selection-adapter-heading">{model.label}</div>
                    {loading ? <p className="model-selection-empty">Loading adapters…</p> : null}
                    {!loading && adapters.length === 0 ? (
                      <p className="model-selection-empty">No matching adapters.</p>
                    ) : null}
                    {adapters.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className="model-selection-adapter"
                        disabled={saving}
                        aria-label={`Use ${item.label}${item.owner ? ` by ${item.owner}` : ''}`}
                        onClick={() => void chooseAdapter(item)}
                      >
                        <span>{item.label}</span>
                        <small>{item.owner ?? item.id}</small>
                      </button>
                    ))}
                  </>
                ) : (
                  <p className="model-selection-empty">Select a model to see matching adapters.</p>
                )}
              </div>
              {error ? (
                <p className="model-selection-panel-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
