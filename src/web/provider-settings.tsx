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
  onAdd(type: ProviderTypeContribution): Promise<void> | void;
  onRefresh(id: string): Promise<void>;
  onDelete(id: string): Promise<void>;
  onRename(id: string, label: string): Promise<void>;
  renderPage?: (type: ProviderTypeContribution, instance?: ProviderInstance) => ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  async function action(run: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      await run();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="provider-settings" aria-label="Providers">
      <p className="form-intro">Manage model provider connections for this Runtime.</p>
      {instances.length === 0 && <p className="field-note">No Providers added yet.</p>}
      {instances.map((instance) => {
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
              {editing === instance.id ? (
                <input
                  className="provider-title-input"
                  aria-label="Provider name"
                  value={label}
                  maxLength={120}
                  disabled={busy}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => setLabel(event.target.value)}
                />
              ) : (
                <span>{instance.label}</span>
              )}
              <span className="field-note">{type?.label ?? instance.typeId}</span>
            </summary>
            <div className="provider-instance-content">
              <div className="provider-instance-actions">
                <button
                  type="button"
                  className="button button-soft"
                  disabled={busy || (editing === instance.id && !label.trim())}
                  onClick={() => {
                    if (editing !== instance.id) {
                      setEditing(instance.id);
                      setLabel(instance.label);
                    } else
                      void action(() => onRename(instance.id, label.trim())).then((ok) => {
                        if (ok) setEditing(null);
                      });
                  }}
                >
                  {editing === instance.id ? 'Save name' : 'Edit name'}
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${instance.label}?`)) void action(() => onDelete(instance.id));
                  }}
                >
                  Remove
                </button>
              </div>
              {expanded.has(instance.id) &&
                (type && renderPage && type.editPage ? (
                  renderPage(type, instance)
                ) : (
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() => void action(() => onRefresh(instance.id))}
                  >
                    Refresh models
                  </button>
                ))}
            </div>
          </details>
        );
      })}
      <button type="button" className="button button-soft" onClick={() => setAdding(!adding)} aria-expanded={adding}>
        Add Provider
      </button>
      {adding && (
        <div className="provider-types" aria-label="Provider types">
          {types.map((type) => (
            <button
              type="button"
              className="button button-quiet"
              key={type.id}
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await onAdd(type);
                }).then((ok) => {
                  if (ok) setAdding(false);
                })
              }
            >
              <strong>{type.label}</strong>
              {type.description && <span>{type.description}</span>}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
