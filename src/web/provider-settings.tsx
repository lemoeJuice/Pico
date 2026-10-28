import { useState } from 'react';
import type { ProviderInstance, ProviderTypeContribution } from '../contracts/model-catalog.js';

export function ProviderSettings({
  types,
  instances,
  onAdd,
  onRefresh,
  onDelete,
}: {
  types: ProviderTypeContribution[];
  instances: ProviderInstance[];
  onAdd(type: ProviderTypeContribution): void;
  onRefresh(id: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
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
  return (
    <section className="provider-settings" aria-label="Providers">
      <p className="form-intro">Manage model provider connections for this Runtime.</p>
      {instances.length === 0 ? (
        <p className="field-note">No Providers added yet.</p>
      ) : (
        instances.map((instance) => (
          <article className="provider-instance" key={instance.id}>
            <div>
              <strong>{instance.label}</strong>
              <p className="field-note">
                {types.find((type) => type.id === instance.typeId)?.label ?? instance.typeId}
              </p>
            </div>
            <div>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy !== null}
                onClick={() => void action(instance.id, onRefresh)}
              >
                Refresh models
              </button>
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
          </article>
        ))
      )}
      <button type="button" className="button button-soft" onClick={() => setAdding(!adding)} aria-expanded={adding}>
        Add Provider
      </button>
      {adding ? (
        <div className="provider-types" aria-label="Provider types">
          {types.map((type) => (
            <button type="button" className="button button-quiet" key={type.id} onClick={() => onAdd(type)}>
              <strong>{type.label}</strong>
              {type.description ? <span>{type.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
