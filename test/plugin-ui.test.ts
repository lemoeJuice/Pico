import { describe, expect, it } from 'vitest';
import {
  isPluginApiPath,
  isPluginModelSettingsUpdate,
  isPluginUiRequest,
  pluginUiUrl,
} from '../src/plugins/ui-protocol.js';

describe('dynamic plugin UI boundary', () => {
  it('builds semantic entry URLs without exposing a host component contract', () => {
    expect(pluginUiUrl('pico.example', 'settings', 'page', 'account')).toBe(
      '/_pico/plugin-ui/pico.example/settings/index.html?viewType=page&viewId=account',
    );
    expect(pluginUiUrl('pico.example', 'web ui', 'component', 'model/picker')).toContain(
      'pico.example/web%20ui/index.html?viewType=component&viewId=model%2Fpicker',
    );
  });

  it('limits iframe API calls to the owning plugin and its registered API prefix', () => {
    expect(isPluginApiPath('/api/plugins/pico.example/preferences?view=1', 'pico.example')).toBe(true);
    expect(isPluginApiPath('/api/plugins/other/preferences', 'pico.example')).toBe(false);
    expect(isPluginApiPath('https://elsewhere.test/api/plugins/pico.example/preferences', 'pico.example')).toBe(false);
    expect(isPluginApiPath('//pico.invalid/api/plugins/pico.example/preferences', 'pico.example')).toBe(false);
    expect(isPluginApiPath('/api/plugins/pico.example/../other/preferences', 'pico.example')).toBe(false);
  });

  it('allows non-secret model selector updates and rejects arbitrary settings', () => {
    expect(isPluginModelSettingsUpdate({ provider: 'pico.example', model: 'gpt-6' })).toBe(true);
    expect(isPluginModelSettingsUpdate({ temperature: 0.3 })).toBe(true);
    expect(isPluginModelSettingsUpdate({ apiKey: 'secret' })).toBe(false);
    expect(isPluginModelSettingsUpdate({ provider: 'pico/example' })).toBe(false);
    expect(isPluginModelSettingsUpdate({ unexpected: true })).toBe(false);
  });

  it('validates the narrow MessagePort request protocol', () => {
    expect(
      isPluginUiRequest({
        type: 'pico:plugin-ui:request',
        id: 'plugin-ui-1',
        action: 'api',
        path: '/api/plugins/pico.example/status',
        init: { method: 'GET' },
      }),
    ).toBe(true);
    expect(
      isPluginUiRequest({
        type: 'pico:plugin-ui:request',
        id: 'plugin-ui-2',
        action: 'update-model-settings',
        update: { apiKey: 'secret' },
      }),
    ).toBe(false);
    expect(isPluginUiRequest({ type: 'pico:plugin-ui:request', id: 'x', action: 'invoke-host-function' })).toBe(false);
  });
});
