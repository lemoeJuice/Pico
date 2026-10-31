import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginUiSelect } from '../src/web/plugin-ui-select.js';

describe('theme selector control', () => {
  it('uses the shared accessible select for a long theme list', () => {
    const options = [
      { label: 'System', value: 'system' },
      ...Array.from({ length: 12 }, (_, index) => ({
        label: `Theme ${index + 1}`,
        value: `plugin.theme:${index + 1}`,
      })),
    ];
    const markup = renderToStaticMarkup(
      <PluginUiSelect
        label="Theme"
        value="plugin.theme:12"
        options={options}
        compact={false}
        onChange={() => {}}
      />,
    );

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-label="Theme"');
    expect(markup).toContain('Theme 12');
  });
});
