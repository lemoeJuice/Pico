import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdapterContribution, CatalogModel } from '../src/contracts/model-catalog.js';
import {
  LatestModelRequest,
  ModelSelection,
  modelSelectionPosition,
  selectionForActiveThread,
  selectionForAdapter,
} from '../src/web/model-selection.js';
import { providerInstanceRequest } from '../src/plugins/openai-provider/form.js';
import { ProviderSettings } from '../src/web/provider-settings.js';

const model: CatalogModel = {
  id: 'id',
  modelId: 'connection/model',
  name: 'model',
  label: 'Model',
  protocol: 'protocol',
  supportsImages: false,
  endpoint: '',
  instanceId: 'connection',
  providerTypeId: 'provider',
  availability: 'available',
};
const adapter: AdapterContribution = {
  id: 'adapter',
  label: 'Adapter',
  match: {},
  temperature: { supported: true, min: 0, max: 2 },
  controls: [{ id: 'effort', label: 'Effort', type: 'string', choices: ['low', 'high'] }],
};

describe('model selection UI', () => {
  it('keeps both panes inside the viewport at either edge and opens into the available space', () => {
    const right = modelSelectionPosition(
      { left: 1100, right: 1200, top: 680, bottom: 700 },
      { width: 1280, height: 720 },
    );
    expect(Number(right.left)).toBeGreaterThanOrEqual(16);
    expect(Number(right.left) + Number(right.width)).toBeLessThanOrEqual(1264);
    expect(right.bottom).toBe(48);
    const narrow = modelSelectionPosition({ left: 0, right: 50, top: 20, bottom: 40 }, { width: 360, height: 640 });
    expect(narrow.left).toBe(16);
    expect(narrow.width).toBe(328);
    expect(narrow.top).toBe(48);
  });
  it('saves the selected model, explicit adapter and validated parameters together', () => {
    expect(selectionForAdapter(model, adapter, '1.5', { effort: 'high' })).toEqual({
      modelId: 'connection/model',
      adapterId: 'adapter',
      parameters: { temperature: 1.5, options: { effort: 'high' } },
    });
    expect(() => selectionForAdapter(model, adapter, '3', {})).toThrow('temperature');
    expect(() => selectionForAdapter(model, adapter, '', { effort: 'unknown' })).toThrow('Effort');
  });
  it('invalidates a previous asynchronous model request when another starts or the view unmounts', () => {
    const guard = new LatestModelRequest();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    guard.invalidate();
    expect(second()).toBe(false);
  });
  it('does not apply a completed save to another Thread after navigation', () => {
    const selected = { thread: { id: 'second' }, modelSelection: 'second-model' };
    expect(selectionForActiveThread(selected, 'second', 'first', 'first-model')).toBe(selected);
    const first = { thread: { id: 'first' }, modelSelection: 'old-model' };
    expect(selectionForActiveThread(first, 'first', 'first', 'new-model')?.modelSelection).toBe('new-model');
  });
  it('builds a provider request with a model list and omits an empty key', () => {
    expect(
      providerInstanceRequest({
        label: ' Work ',
        baseUrl: ' https://example.test/v1 ',
        protocol: 'openai-responses',
        apiKey: '',
        models: ' first \n\nsecond\n',
      }),
    ).toEqual({
      label: 'Work',
      baseUrl: 'https://example.test/v1',
      protocol: 'openai-responses',
      models: ['first', 'second'],
    });
  });
  it('shows the server reason for an unavailable saved selection', () => {
    const markup = renderToStaticMarkup(
      <ModelSelection
        models={[model]}
        instances={[]}
        selection={{
          modelId: model.modelId,
          adapterId: adapter.id,
          parameters: { options: {} },
          unavailableReason: 'Adapter or parameters unavailable; select again.',
        }}
        loadAdapters={async () => [adapter]}
        onSave={async () => undefined}
      />,
    );
    expect(markup).toContain('Choose model');
    expect(markup).toContain('Adapter or parameters unavailable; select again.');
  });
  it('starts with an explicit model choice and lists provider instances without their config', () => {
    const chooser = renderToStaticMarkup(
      <ModelSelection
        models={[model]}
        instances={[]}
        selection={null}
        loadAdapters={async () => [adapter]}
        onSave={async () => undefined}
      />,
    );
    expect(chooser).toContain('Choose model');
    const providers = renderToStaticMarkup(
      <ProviderSettings
        types={[{ id: 'provider', label: 'Provider type', addPage: { pluginId: 'p', pageId: 'add' } }]}
        instances={[
          {
            id: 'connection',
            typeId: 'provider',
            owner: 'p',
            label: 'Work',
            config: { token: 'secret-value' },
            createdAt: '',
          },
        ]}
        onAdd={() => undefined}
        onRefresh={async () => undefined}
        onDelete={async () => undefined}
        onRename={async () => undefined}
      />,
    );
    expect(providers).toContain('Work');
    expect(providers).toContain('Provider type');
    expect(providers).toContain('Add Provider');
    expect(providers).not.toContain('secret-value');
  });
});
