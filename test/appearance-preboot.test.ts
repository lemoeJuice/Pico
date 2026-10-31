import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const preboot = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function runPreboot({
  stored,
  systemDark,
  storageThrows = false,
}: {
  stored?: string;
  systemDark?: boolean;
  storageThrows?: boolean;
}) {
  const attributes = new Map<string, string>();
  const themeColor = {
    content: '',
    setAttribute(_name: string, value: string) {
      this.content = value;
    },
  };
  const documentElement = {
    style: {} as { colorScheme?: string },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
  const localStorage = {
    getItem() {
      if (storageThrows) throw new Error('Storage unavailable');
      return stored ?? null;
    },
  };
  runInNewContext(preboot ?? '', {
    document: {
      documentElement,
      querySelector: () => themeColor,
    },
    localStorage,
    window: { matchMedia: () => ({ matches: systemDark === true }) },
  });
  return { attributes, documentElement, themeColor };
}

describe('appearance preboot', () => {
  it('sets the stored theme before the application module runs', () => {
    const result = runPreboot({ stored: 'pico.dark' });
    expect(result.attributes.get('data-pico-theme')).toBe('pico.dark');
    expect(result.attributes.get('data-pico-appearance-preference')).toBe('pico.dark');
    expect(result.attributes.get('data-pico-color-scheme')).toBe('dark');
    expect(result.documentElement.style.colorScheme).toBe('dark');
    expect(result.themeColor.content).toBe('#171f1a');
  });

  it('restores the legacy dark palette and browser chrome before rendering', () => {
    const result = runPreboot({ stored: 'pico.dark-legacy' });
    expect(result.attributes.get('data-pico-theme')).toBe('pico.dark-legacy');
    expect(result.attributes.get('data-pico-appearance-preference')).toBe('pico.dark-legacy');
    expect(result.attributes.get('data-pico-color-scheme')).toBe('dark');
    expect(result.documentElement.style.colorScheme).toBe('dark');
    expect(result.themeColor.content).toBe('#171f1a');
  });

  it('uses system appearance and falls back to light when browser storage is unavailable', () => {
    const systemDark = runPreboot({ stored: 'system', systemDark: true });
    expect(systemDark.attributes.get('data-pico-theme')).toBe('pico.dark');
    expect(systemDark.attributes.get('data-pico-color-scheme')).toBe('dark');
    const fallback = runPreboot({ storageThrows: true, systemDark: true });
    expect(fallback.attributes.get('data-pico-theme')).toBe('pico.light');
    expect(fallback.attributes.get('data-pico-appearance-preference')).toBe('pico.light');
    expect(fallback.attributes.get('data-pico-color-scheme')).toBe('light');
    expect(fallback.themeColor.content).toBe('#f5f7f4');

    const pluginFallback = runPreboot({ stored: 'pico.reader:midnight', systemDark: true });
    expect(pluginFallback.attributes.get('data-pico-appearance-preference')).toBe('pico.reader:midnight');
    expect(pluginFallback.attributes.get('data-pico-theme')).toBe('pico.light');
    expect(pluginFallback.attributes.get('data-pico-color-scheme')).toBe('light');
  });
});
