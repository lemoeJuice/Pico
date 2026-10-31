import { describe, expect, it } from 'vitest';
import {
  applyPluginThemeVariables,
  appearanceOptions,
  normalizePluginThemes,
  nextExplicitAppearance,
  parseAppearancePreference,
  pluginThemeBackgroundUrl,
  resolveAppearance,
  resolveThemeId,
  subscribeToAppearanceStorage,
  themeColorForAppearance,
} from '../src/web/appearance.js';

describe('built-in appearance preference', () => {
  it('accepts only system and built-in theme IDs', () => {
    expect(parseAppearancePreference('system')).toBe('system');
    expect(parseAppearancePreference('pico.light')).toBe('pico.light');
    expect(parseAppearancePreference('pico.dark')).toBe('pico.dark');
    expect(parseAppearancePreference('unknown')).toBeNull();
    expect(parseAppearancePreference(null)).toBeNull();
  });

  it('resolves system preference and makes the brand shortcut explicit', () => {
    expect(resolveAppearance('pico.light', true)).toBe('light');
    expect(resolveAppearance('pico.dark', false)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveThemeId('system', false)).toBe('pico.light');
    expect(resolveThemeId('system', true)).toBe('pico.dark');
    expect(nextExplicitAppearance('light')).toBe('pico.dark');
    expect(nextExplicitAppearance('dark')).toBe('pico.light');
    expect(themeColorForAppearance('dark')).toBe('#171f1a');
    expect(themeColorForAppearance('light')).toBe('#f5f7f4');
    expect(themeColorForAppearance('dark', '#123456')).toBe('#123456');
  });

  it('preserves plugin preferences while falling back until their themes are registered', () => {
    const preference = parseAppearancePreference('pico.reader:midnight');
    expect(preference).toBe('pico.reader:midnight');
    expect(resolveAppearance(preference!, true)).toBe('light');
    expect(resolveThemeId(preference!, true)).toBe('pico.light');

    const themes = normalizePluginThemes([
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:midnight',
        label: 'Midnight',
        appearance: 'dark',
        variables: { '--pico-page-bg': '#121714' },
        background: { entry: 'webui', path: 'assets/night.png' },
      },
    ]);
    expect(resolveAppearance(preference!, false, themes)).toBe('dark');
    expect(resolveThemeId(preference!, false, themes)).toBe('pico.reader:midnight');
    expect(appearanceOptions(themes).map((option) => option.value)).toContain('pico.reader:midnight');
    expect(themes[0]?.background).toEqual({ entry: 'webui', path: 'assets/night.png' });
    expect(pluginThemeBackgroundUrl(themes[0])).toBe(
      'url("/_pico/plugin-ui/pico.reader/webui/current/assets/night.png")',
    );
  });

  it('retains the full supported plugin palette without accepting an unbounded one', () => {
    const variables = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`--pico-role-${index}`, '#123456']));
    const [theme] = normalizePluginThemes([
      { pluginId: 'pico.reader', id: 'pico.reader:blue', label: 'Blue', appearance: 'light', variables },
    ]);
    expect(Object.keys(theme!.variables)).toHaveLength(128);
    expect(theme!.variables['--pico-role-127']).toBe('#123456');
  });

  it('filters unsafe theme data and only applies existing CSS variables', () => {
    const [theme] = normalizePluginThemes([
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:midnight',
        label: 'Midnight',
        appearance: 'dark',
        background: { entry: 'webui', path: 'assets/night.png' },
        variables: {
          '--pico-page-bg': '#121714',
          '--pico-page-bg; color': 'red',
          '--pico-surface-danger': 'url(javascript:alert(1))',
          '--pico-unregistered-role': '#fff',
        },
      },
      {
        pluginId: 'pico.reader',
        id: 'other.plugin:invalid-owner',
        label: 'Invalid owner',
        appearance: 'light',
        variables: {},
      },
    ]);
    expect(theme?.variables).toEqual({
      '--pico-page-bg': '#121714',
      '--pico-unregistered-role': '#fff',
    });

    const values = new Map([
      ['--pico-page-bg', '#f4f6f2'],
      ['--pico-text-primary', '#28332e'],
      ['--pico-theme-background-image', 'none'],
    ]);
    const priorities = new Map<string, string>();
    const style = {
      getPropertyValue: (name: string) => values.get(name) ?? '',
      getPropertyPriority: (name: string) => priorities.get(name) ?? '',
      setProperty: (name: string, value: string, priority = '') => {
        values.set(name, value);
        priorities.set(name, priority);
      },
      removeProperty: (name: string) => {
        const previous = values.get(name) ?? '';
        values.delete(name);
        return previous;
      },
    };
    const available = new Set(['--pico-page-bg', '--pico-text-primary', '--pico-theme-background-image']);
    const computed = () => ({ getPropertyValue: (name: string) => (available.has(name) ? values.get(name) ?? '' : '') });
    const prior = new Map<string, { value: string; priority: string }>();
    const firstTheme = {
      ...theme!,
      variables: { '--pico-page-bg': '#121714', '--pico-text-primary': '#eff3ef' },
    };
    applyPluginThemeVariables(style, computed, firstTheme, pluginThemeBackgroundUrl(firstTheme), prior);
    expect(values.get('--pico-page-bg')).toBe('#121714');
    expect(values.get('--pico-text-primary')).toBe('#eff3ef');
    expect(values.get('--pico-theme-background-image')).toBe(
      'url("/_pico/plugin-ui/pico.reader/webui/current/assets/night.png")',
    );

    const { background: _background, ...firstThemeWithoutBackground } = firstTheme;
    const nextTheme = { ...firstThemeWithoutBackground, variables: { '--pico-page-bg': '#090d0a' } };
    applyPluginThemeVariables(style, computed, nextTheme, pluginThemeBackgroundUrl(nextTheme), prior);
    expect(values.get('--pico-page-bg')).toBe('#090d0a');
    expect(values.get('--pico-text-primary')).toBe('#28332e');
    expect(values.get('--pico-theme-background-image')).toBe('none');
    applyPluginThemeVariables(style, computed, undefined, undefined, prior);
    expect(values.get('--pico-page-bg')).toBe('#f4f6f2');
    expect(values.get('--pico-text-primary')).toBe('#28332e');
  });

  it('syncs only local appearance storage changes, falls back to light, and cleans up', () => {
    const events = new EventTarget();
    let writes = 0;
    const localStorage = { setItem: () => writes++ } as unknown as Storage;
    const otherStorage = {} as Storage;
    const received: string[] = [];
    const unsubscribe = subscribeToAppearanceStorage(events, localStorage, (preference) => received.push(preference));
    const dispatch = (key: string | null, newValue: string | null, storageArea: Storage) => {
      const event = new Event('storage');
      Object.defineProperties(event, {
        key: { value: key },
        newValue: { value: newValue },
        storageArea: { value: storageArea },
      });
      events.dispatchEvent(event);
    };

    dispatch('pico.appearance', 'pico.dark', localStorage);
    dispatch('pico.appearance', 'pico.reader:midnight', localStorage);
    dispatch('pico.appearance', 'system', otherStorage);
    dispatch('other.setting', 'pico.dark', localStorage);
    dispatch('pico.appearance', null, localStorage);
    dispatch(null, 'invalid', localStorage);
    unsubscribe();
    dispatch('pico.appearance', 'pico.dark', localStorage);

    expect(received).toEqual(['pico.dark', 'pico.reader:midnight', 'pico.light', 'pico.light']);
    expect(writes).toBe(0);
  });
});
