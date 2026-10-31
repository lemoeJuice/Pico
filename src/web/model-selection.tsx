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
import { PluginUiSelect } from './plugin-ui-select.js';

export interface ModelSelectionProps {
  models: CatalogModel[];
  instances: ProviderInstance[];
  selection: (CatalogSelection & { unavailableReason?: string }) | null;
  selectionStatus?: 'loading' | 'error' | 'ready';
  selectionError?: string;
  onRetrySelection?(): void;
  loadAdapters(modelId: string): Promise<AdapterContribution[]>;
  onSave(selection: CatalogSelection): Promise<void>;
  convenient?: boolean;
  rightTarget?: HTMLElement | null;
  convenientTarget?: HTMLElement | null;
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
  if (className === 'model-selection-primary-inline' && control.type === 'boolean') {
    return (
      <label className="model-selection-switch">
        <span>{control.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value ?? control.defaultValue)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="model-selection-switch-track" aria-hidden="true" />
      </label>
    );
  }
  if (control.choices) {
    const options = [
      {
        label:
          control.defaultValue === undefined
            ? 'Default'
            : `Default (${control.choiceLabels?.[String(control.defaultValue)] ?? String(control.defaultValue)})`,
        value: '',
      },
      ...control.choices.map((choice) => ({
        label: control.choiceLabels?.[String(choice)] ?? String(choice),
        value: String(choice),
      })),
    ];
    return (
      <label className={`model-selection-parameter ${className}`}>
        <span>{control.label}</span>
        <PluginUiSelect
          label={control.label}
          value={String(value ?? '')}
          options={options}
          disabled={disabled}
          compact={className === 'model-selection-primary-inline'}
          onChange={(selectedValue) => {
            if (selectedValue === '') {
              onChange(undefined);
              return;
            }
            const selected = control.choices?.find((choice) => String(choice) === selectedValue);
            if (selected !== undefined) onChange(selected);
          }}
        />
      </label>
    );
  }
  if (control.type === 'boolean') {
    const options = [
      { label: 'Default', value: '' },
      { label: 'On', value: 'true' },
      { label: 'Off', value: 'false' },
    ];
    return (
      <label className={`model-selection-parameter ${className}`}>
        <span>{control.label}</span>
        <PluginUiSelect
          label={control.label}
          value={value === undefined ? '' : String(value)}
          options={options}
          disabled={disabled}
          compact={className === 'model-selection-primary-inline'}
          onChange={(selectedValue) => onChange(selectedValue === '' ? undefined : selectedValue === 'true')}
        />
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
export function ModelSelection({
  models,
  instances,
  selection,
  selectionStatus = 'ready',
  selectionError,
  onRetrySelection,
  loadAdapters,
  onSave,
  convenient = true,
  rightTarget,
  convenientTarget,
}: ModelSelectionProps) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [mode, setMode] = useState<'convenient' | 'full'>('convenient');
  const [draftAdapter, setDraftAdapter] = useState<AdapterContribution | null>(null);
  const [draftTemperature, setDraftTemperature] = useState('');
  const [draftOptions, setDraftOptions] = useState<Record<string, ModelOptionValue>>({});
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties>({});
  const [model, setModel] = useState<CatalogModel | null>(null);
  const [adapters, setAdapters] = useState<AdapterContribution[]>([]);
  const [selectedAdapters, setSelectedAdapters] = useState<{ modelId: string; items: AdapterContribution[] } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adapterStatus, setAdapterStatus] = useState<'checking' | 'available' | 'unavailable'>('checking');
  const [position, setPosition] = useState<CSSProperties>({});
  const request = useRef(new LatestModelRequest());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rightTriggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const modelItemRef = useRef<HTMLElement | null>(null);
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
          setSelectedAdapters({ modelId: selection.modelId, items });
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
  const selectedAdapter =
    selectedAdapters && selectedAdapters.modelId === selection?.modelId
      ? (selectedAdapters.items.find((item) => item.id === selection?.adapterId) ?? null)
      : null;
  const [temperatureDraft, setTemperatureDraft] = useState('');
  useEffect(
    () => setTemperatureDraft(String(selection?.parameters.temperature ?? '')),
    [selection?.modelId, selection?.adapterId, selection?.parameters.temperature],
  );
  const activeLabel = selectionStatus === 'loading' && !selection
    ? 'Loading model…'
    : selectedModel &&
    selectedModel.availability !== 'unavailable' &&
    adapterStatus !== 'unavailable' &&
    !selection?.unavailableReason
      ? selectedModel.label
      : 'Choose model...';
  const activeSource =
    selectedModel && activeLabel !== 'Choose model...'
      ? (instances.find((instance) => instance.id === selectedModel.instanceId)?.label ?? selectedModel.instanceId)
      : null;

  useLayoutEffect(() => {
    if (!modelsOpen) return;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const base = modelSelectionPosition(rect, { width: window.innerWidth, height: window.innerHeight });
        const width = Math.min(mode === 'full' ? 720 : 300, Math.max(0, window.innerWidth - 32));
        const availableHeight = 'bottom' in base ? rect.top - 24 : window.innerHeight - rect.bottom - 24;
        const maxHeight =
          mode === 'full' ? Math.max(0, Math.min(window.innerHeight * 0.75, availableHeight)) : base.maxHeight;
        setPosition({
          ...base,
          width,
          maxHeight,
          left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
        });
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [modelsOpen, mode]);

  useLayoutEffect(() => {
    if (!modelsOpen || mode !== 'convenient' || !model) return;
    const placeSubmenu = () => {
      const anchor = modelItemRef.current;
      const submenu = submenuRef.current;
      if (!anchor || !submenu) return;
      const rect = anchor.getBoundingClientRect();
      const margin = Math.min(12, window.innerWidth / 2, window.innerHeight / 2);
      const width = Math.max(0, Math.min(240, window.innerWidth - 2 * margin));
      const maxHeight = Math.max(0, Math.min(360, window.innerHeight - 2 * margin));
      const height = Math.min(submenu.getBoundingClientRect().height, maxHeight);
      const preferredLeft =
        rect.right + 4 + width <= window.innerWidth - margin ? rect.right + 4 : rect.left - width - 4;
      const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - margin - width));
      const top = Math.max(margin, Math.min(rect.top, window.innerHeight - margin - height));
      setSubmenuPosition((current) =>
        current.left === left && current.top === top && current.width === width && current.maxHeight === maxHeight
          ? current
          : { left, top, width, maxHeight },
      );
    };
    placeSubmenu();
    window.addEventListener('resize', placeSubmenu);
    window.addEventListener('scroll', placeSubmenu, true);
    return () => {
      window.removeEventListener('resize', placeSubmenu);
      window.removeEventListener('scroll', placeSubmenu, true);
    };
  }, [modelsOpen, mode, model, loading, adapters, submenuPosition]);

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
        rightTriggerRef.current?.contains(event.target) ||
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
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [modelsOpen, parametersOpen]);

  async function chooseModel(next: CatalogModel, target?: HTMLElement) {
    modelItemRef.current = target ?? null;
    setDraftAdapter(null);
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
    if (mode === 'full') {
      const same = selection?.modelId === model.modelId && selection.adapterId === next.id;
      setDraftAdapter(next);
      setDraftTemperature(same ? String(selection?.parameters.temperature ?? '') : '');
      setDraftOptions(same ? { ...selection.parameters.options } : {});
      return;
    }
    const sameSelection = selection?.modelId === model.modelId && selection.adapterId === next.id;
    const temperature =
      sameSelection && selection.parameters.temperature != null ? String(selection.parameters.temperature) : '';
    const options = sameSelection ? { ...selection.parameters.options } : {};
    try {
      await save(selectionForAdapter(model, next, temperature, options));
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

  function openChooser(nextMode: 'convenient' | 'full', target: HTMLButtonElement) {
    anchorRef.current = target;
    setMode(nextMode);
    setModelsOpen((current) => mode !== nextMode || !current);
    setModel(null);
    setAdapters([]);
    setDraftAdapter(null);
    setError('');
  }

  const primaryControls = selectedAdapter?.controls.filter((control) => control.group === 'primary') ?? [];
  const otherControls = selectedAdapter?.controls.filter((control) => control.group !== 'primary') ?? [];
  const hasOtherParameters = Boolean(otherControls.length || selectedAdapter?.temperature.supported);

  const convenientContent = (
    <div className="model-selection">
      {convenient ? (
        <button
          type="button"
          ref={triggerRef}
          className="composer-model-name"
          onClick={(event) => openChooser('convenient', event.currentTarget)}
          aria-label={activeSource ? `${activeLabel} — ${activeSource}` : activeLabel}
          aria-expanded={modelsOpen && mode === 'convenient'}
          aria-haspopup="dialog"
        >
          <span className="model-selection-trigger-label">
            {activeLabel}
            {activeSource ? <small>{activeSource}</small> : null}
          </span>
          <span
            className={`plugin-ui-select-chevron${modelsOpen && mode === 'convenient' ? ' is-open' : ''}`}
            aria-hidden="true"
          />
        </button>
      ) : null}
      {selection?.unavailableReason || (adapterStatus === 'unavailable' && selection?.adapterId) ? (
        <span className="model-selection-unavailable" role="status">
          {selection.unavailableReason ?? 'Saved model or adapter is unavailable. Choose again.'}
        </span>
      ) : null}
      {selectionStatus === 'loading' ? <span className="model-selection-status" role="status">Loading model selection…</span> : null}
      {selectionStatus === 'error' ? (
        <span className="model-selection-error" role="alert">
          Model selection could not be loaded{selectionError ? `: ${selectionError}` : '.'}{' '}
          <button type="button" onClick={onRetrySelection}>Retry</button>
        </span>
      ) : null}
      {convenient && selectedAdapter?.temperature.supported ? (
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
      {convenient &&
        primaryControls.map((control) => (
          <ParameterField
            key={control.id}
            control={control}
            value={selection?.parameters.options[control.id]}
            disabled={saving}
            className="model-selection-primary-inline"
            onChange={(value) => saveOption(control, value)}
          />
        ))}
      {convenient && (hasOtherParameters || primaryControls.length) ? (
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
    </div>
  );

  return (
    <>
      {convenientTarget ? createPortal(convenientContent, convenientTarget) : rightTarget ? null : convenientContent}
      {rightTarget
        ? createPortal(
            <>
              {!convenientTarget &&
              (selection?.unavailableReason || (adapterStatus === 'unavailable' && selection?.adapterId)) ? (
                <span className="model-selection-unavailable" role="status">
                  {selection?.unavailableReason ?? 'Saved model or adapter is unavailable. Choose again.'}
                </span>
              ) : null}
              {!convenientTarget && error ? (
                <span className="model-selection-error" role="alert">
                  {error}
                </span>
              ) : null}
              {!convenientTarget && selectionStatus === 'loading' ? (
                <span className="model-selection-status" role="status">Loading model selection…</span>
              ) : null}
              {!convenientTarget && selectionStatus === 'error' ? (
                <span className="model-selection-error" role="alert">
                  Model selection could not be loaded{selectionError ? `: ${selectionError}` : '.'}{' '}
                  <button type="button" onClick={onRetrySelection}>Retry</button>
                </span>
              ) : null}
              <button
                type="button"
                ref={rightTriggerRef}
                className="setup-caption composer-model-name composer-model-name-right"
                onClick={(event) => openChooser('full', event.currentTarget)}
                aria-expanded={modelsOpen && mode === 'full'}
                aria-haspopup="dialog"
              >
                <span>{activeLabel}</span>
              </button>
            </>,
            rightTarget,
          )
        : null}
      {modelsOpen
        ? createPortal(
            <div
              ref={menuRef}
              style={position}
              className={`model-selection-panel ${mode === 'full' ? 'model-selection-full' : 'model-selection-compact'}`}
              role="dialog"
              aria-label="Choose model"
            >
              {mode === 'full' ? (
                <div className="model-selection-heading">
                  <strong>Choose model</strong>
                  <button type="button" onClick={() => setModelsOpen(false)}>
                    Close
                  </button>
                </div>
              ) : null}
              <div className="model-selection-layout">
                <div className="model-selection-models">
                  {mode === 'convenient' ? (
                    <div className="model-selection-placeholder" aria-hidden="true">
                      Choose model...
                    </div>
                  ) : null}
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
                        onClick={(event) => void chooseModel(item, event.currentTarget)}
                      >
                        <span className="model-selection-model-label">{item.label}</span>
                        <span className="model-selection-model-source">{source}</span>
                      </button>
                    );
                  })}
                </div>
                {model ? (
                  <div
                    ref={mode === 'convenient' ? submenuRef : undefined}
                    className={mode === 'full' ? 'model-selection-adapters' : 'model-selection-submenu'}
                    style={mode === 'convenient' ? submenuPosition : undefined}
                    aria-live="polite"
                  >
                    <div className="model-selection-adapter-heading">
                      {mode === 'full' ? `Adapter for ${model.label}` : model.label}
                    </div>
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
                        aria-pressed={draftAdapter?.id === item.id}
                        aria-label={`Use ${item.label}${item.owner ? ` by ${item.owner}` : ''}`}
                        onClick={() => void chooseAdapter(item)}
                      >
                        <span>
                          {item.label}
                          <small>{item.owner ?? item.id}</small>
                        </span>
                      </button>
                    ))}
                    {mode === 'full' && draftAdapter ? (
                      <section className="model-selection-full-parameters" aria-label="Model parameters">
                        <strong>Parameters</strong>
                        {draftAdapter.temperature.supported ? (
                          <label>
                            Temperature
                            <input
                              type="number"
                              value={
                                draftAdapter.temperature.fixedValue === undefined
                                  ? draftTemperature
                                  : String(draftAdapter.temperature.fixedValue)
                              }
                              step={draftAdapter.temperature.step ?? 'any'}
                              disabled={draftAdapter.temperature.fixedValue !== undefined}
                              min={draftAdapter.temperature.min}
                              max={draftAdapter.temperature.max}
                              placeholder="Default"
                              onChange={(event) => setDraftTemperature(event.target.value)}
                            />
                          </label>
                        ) : null}
                        {draftAdapter.controls.map((control) => (
                          <ParameterField
                            key={control.id}
                            control={control}
                            value={draftOptions[control.id]}
                            disabled={saving}
                            onChange={(value) =>
                              setDraftOptions((current) => {
                                const next = { ...current };
                                if (value === undefined) delete next[control.id];
                                else next[control.id] = value;
                                return next;
                              })
                            }
                          />
                        ))}
                        <button
                          type="button"
                          className="model-selection-confirm"
                          disabled={saving}
                          onClick={() => {
                            try {
                              void save(selectionForAdapter(model, draftAdapter, draftTemperature, draftOptions));
                            } catch (caught) {
                              setError(caught instanceof Error ? caught.message : String(caught));
                            }
                          }}
                        >
                          {saving ? 'Saving…' : 'Confirm selection'}
                        </button>
                      </section>
                    ) : null}
                  </div>
                ) : mode === 'full' ? (
                  <div className="model-selection-adapters">
                    <p className="model-selection-empty">Select a model to see matching adapters.</p>
                  </div>
                ) : null}
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
    </>
  );
}
