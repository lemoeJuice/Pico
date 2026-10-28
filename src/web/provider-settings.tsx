import { useState, type ReactNode } from 'react';
import type { ProviderInstance, ProviderTypeContribution } from '../contracts/model-catalog.js';

export function ProviderSettings({
  types,
  instances,
  onAdd,
  onRefresh,
  onDelete,
  onRename,
  renderPage,
}: {
  types: ProviderTypeContribution[];
  instances: ProviderInstance[];
  onAdd(type: ProviderTypeContribution): void;
  onRefresh(id: string): Promise<void>;
  onDelete(id: string): Promise<void>;
  onRename(id: string, label: string): Promise<void>;
  renderPage?: (type: ProviderTypeContribution, instance?: ProviderInstance) => ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  async function action(id: string, run: (id: string) => Promise<void>) {
    setBusy(id);
    setError('');
    try {
      await run(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }
  const selectedType = types.find((type) => type.id === addType);
  return (
    <section className="provider-settings" aria-label="Providers">
      <p className="form-intro">Manage model provider connections for this Runtime.</p>
      {instances.length === 0 ? (
        <p className="field-note">No Providers added yet.</p>
      ) : (
        instances.map((instance) => {
          const type = types.find((item) => item.id === instance.typeId);
          return (
            <details
              className="provider-instance"
              key={instance.id}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (open) next.add(instance.id);
                  else next.delete(instance.id);
                  return next;
                });
              }}
            >
              <summary>
                <strong>{instance.label}</strong> <span className="field-note">{type?.label ?? instance.typeId}</span>
              </summary>
              <div className="provider-instance-content">
                {expanded.has(instance.id) &&
                  (type && renderPage && type.editPage ? (
                    renderPage(type, instance)
                  ) : (
                    <FallbackProviderSettings
                      instance={instance}
                      busy={busy !== null}
                      onRename={onRename}
                      onRefresh={onRefresh}
                      action={action}
                    />
                  ))}
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Remove ${instance.label}?`)) void action(instance.id, onDelete);
                  }}
                >
                  Remove
                </button>
              </div>
            </details>
          );
        })
      )}
      <button
        type="button"
        className="button button-soft"
        onClick={() => {
          setAdding(!adding);
          setAddType(null);
        }}
        aria-expanded={adding}
      >
        Add Provider
      </button>
      {adding && !selectedType ? (
        <div className="provider-types" aria-label="Provider types">
          {types.map((type) => (
            <button
              type="button"
              className="button button-quiet"
              key={type.id}
              onClick={() => (renderPage ? setAddType(type.id) : onAdd(type))}
            >
              <strong>{type.label}</strong>
              {type.description ? <span>{type.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {adding && selectedType && renderPage ? (
        <div>
          <button type="button" className="button button-quiet" onClick={() => setAddType(null)}>
            Back
          </button>
          {renderPage(selectedType)}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function FallbackProviderSettings({
  instance,
  busy,
  onRename,
  onRefresh,
  action,
}: {
  instance: ProviderInstance;
  busy: boolean;
  onRename(id: string, label: string): Promise<void>;
  onRefresh(id: string): Promise<void>;
  action(id: string, run: (id: string) => Promise<void>): Promise<void>;
}) {
  const [label, setLabel] = useState(instance.label);
  return (
    <>
      <label className="provider-instance-name">
        Name
        <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} disabled={busy} />
      </label>
      <button
        type="button"
        className="button button-soft"
        disabled={busy || !label.trim() || label.trim() === instance.label}
        onClick={() => void action(instance.id, (id) => onRename(id, label.trim()))}
      >
        Save name
      </button>
      <button
        type="button"
        className="button button-quiet"
        disabled={busy}
        onClick={() => void action(instance.id, onRefresh)}
      >
        Refresh models
      </button>
    </>
  );
}
