import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type {
  AdapterContribution,
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

/** Anchor to the trigger while keeping both panes inside the visible viewport. */
export function modelSelectionPosition(
  rect: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
): CSSProperties {
  const margin = 16;
  const width = Math.min(720, Math.max(0, viewport.width - margin * 2));
  const left = Math.max(margin, Math.min(rect.right - width, viewport.width - width - margin));
  const above = Math.max(0, rect.top - margin - 8);
  const below = Math.max(0, viewport.height - rect.bottom - margin - 8);
  const upward = above >= below;
  return {
    left,
    width,
    maxHeight: Math.min(viewport.height * 0.75, upward ? above : below),
    ...(upward ? { bottom: viewport.height - rect.top + 8 } : { top: rect.bottom + 8 }),
  };
}

/** Shared chooser for Thread and plugin model selections. */
export function ModelSelection({ models, instances, selection, loadAdapters, onSave }: ModelSelectionProps) {
  const [model, setModel] = useState<CatalogModel | null>(null);
  const [adapters, setAdapters] = useState<AdapterContribution[]>([]);
  const [adapter, setAdapter] = useState<AdapterContribution | null>(null);
  const [temperature, setTemperature] = useState('');
  const [options, setOptions] = useState<Record<string, ModelOptionValue>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(new LatestModelRequest());
  useEffect(
    () => () => {
      request.current.invalidate();
    },
    [],
  );
  const [validAdapter, setValidAdapter] = useState(false);
  useEffect(() => {
    let alive = true;
    setValidAdapter(false);
    if (selection)
      void loadAdapters(selection.modelId)
        .then((items) => {
          if (alive) setValidAdapter(items.some((item) => item.id === selection.adapterId));
        })
        .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selection?.modelId, selection?.adapterId, loadAdapters]);
  const selectedModel = models.find((item) => item.modelId === selection?.modelId);
  const activeLabel =
    selectedModel && selectedModel.availability !== 'unavailable' && validAdapter && !selection?.unavailableReason
      ? selectedModel.label
      : 'Choose model';
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
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
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  async function chooseModel(next: CatalogModel) {
    const isCurrent = request.current.begin();
    setModel(next);
    setAdapter(null);
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

  function chooseAdapter(next: AdapterContribution) {
    setAdapter(next);
    const same = selection !== null && selection.modelId === model?.modelId && selection.adapterId === next.id;
    setTemperature(
      next.temperature.fixedValue === undefined && same && selection?.parameters.temperature != null
        ? String(selection.parameters.temperature)
        : '',
    );
    setOptions(same ? { ...selection?.parameters.options } : {});
    setError('');
  }

  async function save() {
    if (!model || !adapter) return;
    let next: CatalogSelection;
    try {
      next = selectionForAdapter(model, adapter, temperature, options);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(next);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="model-selection">
      <button
        type="button"
        ref={triggerRef}
        className="setup-caption composer-model-name"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {activeLabel}
      </button>
      {selection?.unavailableReason ? (
        <span className="field-note" role="status">
          {selection.unavailableReason}
        </span>
      ) : null}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              style={position}
              className="model-selection-panel"
              role="dialog"
              aria-label="Choose model"
            >
              <div className="model-selection-heading">
                <strong>Choose model</strong>
                <button type="button" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
              {models.length === 0 ? (
                <p className="field-note">No models available. Add a Provider in settings.</p>
              ) : null}
              <div className="model-selection-layout">
                <div className="model-selection-models">
                  {models.map((item) => (
                    <button
                      type="button"
                      key={item.modelId}
                      disabled={item.availability === 'unavailable' || saving}
                      aria-pressed={model?.modelId === item.modelId}
                      onClick={() => void chooseModel(item)}
                    >
                      <span>
                        {item.label} ·{' '}
                        {instances.find((instance) => instance.id === item.instanceId)?.label ?? item.instanceId}
                      </span>
                      <span>{item.availability === 'unavailable' ? 'Unavailable' : 'Choose adapter ›'}</span>
                    </button>
                  ))}
                </div>
                <div className="model-selection-detail">
                  {model ? (
                    <section aria-label={`Adapters for ${model.label}`}>
                      <strong>Adapter for {model.label}</strong>
                      {loading ? (
                        <p>Loading adapters…</p>
                      ) : adapters.length === 0 ? (
                        <p className="field-note">No matching adapters.</p>
                      ) : (
                        adapters.map((item) => (
                          <button
                            type="button"
                            className="model-selection-adapter"
                            key={item.id}
                            aria-pressed={adapter?.id === item.id}
                            onClick={() => chooseAdapter(item)}
                          >
                            <span>
                              <span>{item.label}</span>
                              <small className="model-selection-adapter-source">{item.owner ?? item.id}</small>
                              {item.description ? <small>{item.description}</small> : null}
                            </span>
                          </button>
                        ))
                      )}
                    </section>
                  ) : null}
                  {adapter ? (
                    <section className="model-selection-parameters" aria-label="Model parameters">
                      <strong>Parameters</strong>
                      {adapter.temperature.supported ? (
                        <label>
                          Temperature
                          <input
                            type="number"
                            value={
                              adapter.temperature.fixedValue === undefined
                                ? temperature
                                : String(adapter.temperature.fixedValue)
                            }
                            step={adapter.temperature.step ?? 'any'}
                            disabled={adapter.temperature.fixedValue !== undefined}
                            min={adapter.temperature.min}
                            max={adapter.temperature.max}
                            placeholder="Default"
                            onChange={(event) => setTemperature(event.target.value)}
                          />
                        </label>
                      ) : null}
                      {adapter.controls.map((control) => (
                        <label key={control.id}>
                          {control.label}
                          {control.description ? <span className="field-note">{control.description}</span> : null}
                          {control.choices ? (
                            <select
                              value={String(options[control.id] ?? '')}
                              onChange={(event) => {
                                const value = control.choices?.find((choice) => String(choice) === event.target.value);
                                setOptions((current) => {
                                  const next = { ...current };
                                  if (value === undefined) delete next[control.id];
                                  else next[control.id] = value;
                                  return next;
                                });
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
                          ) : control.type === 'boolean' ? (
                            <select
                              value={options[control.id] === undefined ? '' : String(options[control.id])}
                              onChange={(event) =>
                                setOptions((current) => {
                                  const next = { ...current };
                                  if (event.target.value === '') delete next[control.id];
                                  else next[control.id] = event.target.value === 'true';
                                  return next;
                                })
                              }
                            >
                              <option value="">Default</option>
                              <option value="true">On</option>
                              <option value="false">Off</option>
                            </select>
                          ) : (
                            <input
                              type={control.type === 'number' ? 'number' : 'text'}
                              step={control.type === 'number' ? (control.step ?? 'any') : undefined}
                              min={control.min}
                              max={control.max}
                              value={String(options[control.id] ?? '')}
                              placeholder={
                                control.defaultValue === undefined
                                  ? 'Default'
                                  : `Default (${String(control.defaultValue)})`
                              }
                              onChange={(event) => {
                                const value = event.target.value;
                                setOptions((current) => {
                                  const next = { ...current };
                                  if (!value) delete next[control.id];
                                  else next[control.id] = control.type === 'number' ? Number(value) : value;
                                  return next;
                                });
                              }}
                            />
                          )}
                        </label>
                      ))}
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={saving}
                        onClick={() => void save()}
                      >
                        {saving ? 'Saving…' : 'Confirm selection'}
                      </button>
                    </section>
                  ) : null}
                </div>
              </div>
              {error ? <p role="alert">{error}</p> : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
