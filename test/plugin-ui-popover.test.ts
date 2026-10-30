import { describe, expect, it } from 'vitest';
import { pluginUiPopoverPathIncludesOwner } from '../src/web/plugin-ui-popover.js';

function element(owner: string | null): { getAttribute(name: string): string | null } {
  return { getAttribute: (name) => (name === 'data-plugin-ui-popover-owner' ? owner : null) };
}

describe('plugin UI popover outside dismissal', () => {
  it('keeps the owning popover open for a pointer event inside its portaled menu', () => {
    expect(
      pluginUiPopoverPathIncludesOwner([{ nodeType: 3 }, element('plugin:component:todo')], 'plugin:component:todo'),
    ).toBe(true);
  });

  it('does not treat outside targets or a different popover menu as inside', () => {
    expect(pluginUiPopoverPathIncludesOwner([{ nodeType: 1 }, { nodeType: 9 }], 'plugin:component:todo')).toBe(false);
    expect(pluginUiPopoverPathIncludesOwner([element('plugin:component:other')], 'plugin:component:todo')).toBe(false);
  });

  it('ignores non-element targets while walking a composed event path', () => {
    expect(pluginUiPopoverPathIncludesOwner([null, 'text target', 1], 'plugin:component:todo')).toBe(false);
  });
});
