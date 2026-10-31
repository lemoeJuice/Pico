import { describe, expect, it } from 'vitest';
import { MAX_THEME_VARIABLES } from '../src/contracts/plugin-theme.js';
import { THEME_ROLE_SCHEMA } from '../src/contracts/theme-role-schema.js';
import {
  applyPluginThemeVariables,
  appearanceOptions,
  appearanceSelectionState,
  normalizePluginThemes,
  nextExplicitAppearance,
  latestAvailableAppearancePreference,
  parseRecentAppearancePreferences,
  readRecentAppearancePreferencesFromStorage,
  RECENT_APPEARANCE_STORAGE_KEY,
  RECENT_APPEARANCE_STORAGE_KEYS,
  parseAppearancePreference,
  pluginThemeBackgroundUrl,
  pluginThemeBrandIconUrl,
  resolveAppearance,
  resolveThemeId,
  subscribeToAppearanceStorage,
  subscribeToRecentAppearanceStorage,
  themeColorForAppearance,
} from '../src/web/appearance.js';

describe('built-in appearance preference', () => {
  it('accepts only system and built-in theme IDs', () => {
    expect(parseAppearancePreference('system')).toBe('system');
    expect(parseAppearancePreference('pico.light')).toBe('pico.light');
    expect(parseAppearancePreference('pico.dark')).toBe('pico.dark');
    expect(parseAppearancePreference('pico.dark-legacy')).toBe('pico.dark-legacy');
    expect(parseAppearancePreference('unknown')).toBeNull();
    expect(parseAppearancePreference(null)).toBeNull();
  });

  it('resolves system preference and makes the brand shortcut explicit', () => {
    expect(resolveAppearance('pico.light', true)).toBe('light');
    expect(resolveAppearance('pico.dark', false)).toBe('dark');
    expect(resolveAppearance('pico.dark-legacy', false)).toBe('dark');
    expect(resolveThemeId('pico.dark-legacy', false)).toBe('pico.dark-legacy');
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveThemeId('system', false)).toBe('pico.light');
    expect(resolveThemeId('system', true)).toBe('pico.dark');
    expect(nextExplicitAppearance('light')).toBe('pico.dark');
    expect(nextExplicitAppearance('dark')).toBe('pico.light');
    expect(themeColorForAppearance('dark')).toBe('#1b2024');
    expect(themeColorForAppearance('dark', undefined, 'pico.dark-legacy')).toBe('#171f1a');
    expect(themeColorForAppearance('light')).toBe('#f5f7f4');
    expect(themeColorForAppearance('dark', '#123456')).toBe('#123456');
  });

  it('remembers legacy dark across light and dark toggles', () => {
    const recent = { light: 'pico.light' as const, dark: 'pico.dark-legacy' as const };
    expect(appearanceOptions([]).find((option) => option.value === 'pico.dark-legacy')?.label).toBe('Dark Legacy');
    expect(latestAvailableAppearancePreference('dark', recent, [])).toBe('pico.dark-legacy');
    expect(nextExplicitAppearance('light', undefined, [], recent)).toBe('pico.dark-legacy');
    expect(nextExplicitAppearance('dark', undefined, [], recent)).toBe('pico.light');
  });

  it('prefers an available paired theme, then recent matching themes, then built-ins', () => {
    const themes = normalizePluginThemes([
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:night',
        label: 'Night',
        appearance: 'dark',
        pairedThemeId: 'day',
        variables: {},
      },
      { pluginId: 'pico.reader', id: 'pico.reader:day', label: 'Day', appearance: 'light', variables: {} },
      { pluginId: 'pico.other', id: 'pico.other:mist', label: 'Mist', appearance: 'light', variables: {} },
    ]);
    const recent = { light: 'pico.other:mist' as const, dark: 'pico.reader:night' as const };
    const night = themes.find((theme) => theme.id === 'pico.reader:night');

    expect(nextExplicitAppearance('dark', night, themes, recent)).toBe('pico.reader:day');
    expect(nextExplicitAppearance('dark', undefined, themes, recent)).toBe('pico.other:mist');
    expect(nextExplicitAppearance('dark', night, [themes[0]!], recent)).toBe('pico.light');
    expect(nextExplicitAppearance('dark', undefined, [], recent)).toBe('pico.light');
    expect(latestAvailableAppearancePreference('dark', recent, [])).toBe('pico.dark');
    expect(latestAvailableAppearancePreference('light', recent, themes)).toBe('pico.other:mist');
  });

  it('retains recent choices through temporary theme unavailability and follows system appearance', () => {
    const stored = parseRecentAppearancePreferences(JSON.stringify({ light: 'pico.reader:day', dark: 'pico.dark' }));
    expect(latestAvailableAppearancePreference('light', stored, [])).toBe('pico.light');
    const restored = normalizePluginThemes([
      { pluginId: 'pico.reader', id: 'pico.reader:day', label: 'Day', appearance: 'light', variables: {} },
    ]);
    expect(latestAvailableAppearancePreference('light', stored, restored)).toBe('pico.reader:day');
    expect(resolveAppearance('system', true, restored)).toBe('dark');
    expect(nextExplicitAppearance(resolveAppearance('system', true, restored), undefined, restored, stored)).toBe(
      'pico.reader:day',
    );
    expect(parseRecentAppearancePreferences('{invalid')).toEqual({ light: null, dark: null });
  });

  it('preserves plugin preferences while falling back until their themes are registered', () => {
    const preference = parseAppearancePreference('pico.reader:midnight');
    expect(preference).toBe('pico.reader:midnight');
    expect(resolveAppearance(preference!, true)).toBe('light');
    expect(resolveThemeId(preference!, true)).toBe('pico.light');
    expect(appearanceSelectionState(preference!, 'pico.light', appearanceOptions([]))).toEqual({
      value: 'pico.light',
      unavailable: true,
    });

    const themes = normalizePluginThemes([
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:midnight',
        label: 'Midnight',
        appearance: 'dark',
        variables: { '--pico-page-bg': '#121714' },
        background: { entry: 'webui', path: 'assets/night.png' },
        brandIcon: { entry: 'webui', path: 'assets/whale.svg' },
        pairedThemeId: 'day',
        brandLabel: 'reader-theme',
      },
    ]);
    expect(resolveAppearance(preference!, false, themes)).toBe('dark');
    expect(resolveThemeId(preference!, false, themes)).toBe('pico.reader:midnight');
    expect(appearanceOptions(themes).map((option) => option.value)).toContain('pico.reader:midnight');
    expect(appearanceSelectionState(preference!, resolveThemeId(preference!, false, themes), appearanceOptions(themes))).toEqual({
      value: 'pico.reader:midnight',
      unavailable: false,
    });
    expect(themes[0]?.background).toEqual({ entry: 'webui', path: 'assets/night.png' });
    expect(pluginThemeBackgroundUrl(themes[0])).toBe(
      'url("/_pico/plugin-ui/pico.reader/webui/current/assets/night.png")',
    );
    expect(themes[0]?.brandIcon).toEqual({ entry: 'webui', path: 'assets/whale.svg' });
    expect(pluginThemeBrandIconUrl(themes[0])).toBe('/_pico/plugin-ui/pico.reader/webui/current/assets/whale.svg');
    expect(themes[0]).toMatchObject({ pairedThemeId: 'day', brandLabel: 'reader-theme' });
  });

  it('retains the full supported plugin palette without accepting an unbounded one', () => {
    const variables = Object.fromEntries(
      Array.from({ length: MAX_THEME_VARIABLES + 1 }, (_, index) => [`--pico-role-${index}`, '#123456']),
    );
    const [theme] = normalizePluginThemes([
      { pluginId: 'pico.reader', id: 'pico.reader:blue', label: 'Blue', appearance: 'light', variables },
    ]);
    expect(Object.keys(theme!.variables)).toHaveLength(MAX_THEME_VARIABLES);
    expect(theme!.variables[`--pico-role-${MAX_THEME_VARIABLES - 1}`]).toBe('#123456');
  });

  it('preserves complete coverage metadata and rejects malformed strict themes without truncating', () => {
    const [firstRole, ...inheritedRoles] = THEME_ROLE_SCHEMA;
    const [complete] = normalizePluginThemes([
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:complete',
        label: 'Complete',
        appearance: 'light',
        coverage: 'complete',
        variables: { [firstRole!]: '#123456' },
        inheritRoles: inheritedRoles,
      },
    ]);
    expect(complete).toMatchObject({
      coverage: 'complete',
      variables: { [firstRole!]: '#123456' },
      inheritRoles: inheritedRoles,
    });

    const malformed = normalizePluginThemes([
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:missing-role',
        label: 'Missing role',
        appearance: 'light',
        coverage: 'complete',
        variables: {},
        inheritRoles: inheritedRoles,
      },
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:unsafe-value',
        label: 'Unsafe value',
        appearance: 'light',
        coverage: 'complete',
        variables: Object.fromEntries(
          THEME_ROLE_SCHEMA.map((role) => [role, role === firstRole ? 'url(javascript:alert(1))' : 'initial']),
        ),
        inheritRoles: [],
      },
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:oversized',
        label: 'Oversized',
        appearance: 'light',
        coverage: 'complete',
        variables: Object.fromEntries([
          ...THEME_ROLE_SCHEMA.map((role) => [role, 'initial']),
          ['--pico-extra-role', 'initial'],
        ]),
        inheritRoles: [],
      },
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:oversized-inheritance',
        label: 'Oversized inheritance',
        appearance: 'light',
        coverage: 'complete',
        variables: {},
        inheritRoles: [...THEME_ROLE_SCHEMA, '--pico-extra-role'],
      },
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:unsafe-background',
        label: 'Unsafe background',
        appearance: 'light',
        coverage: 'complete',
        variables: Object.fromEntries(
          THEME_ROLE_SCHEMA.filter((role) => role !== '--pico-theme-background-image').map((role) => [role, 'initial']),
        ),
        inheritRoles: ['--pico-theme-background-image'],
        background: { entry: 'webui', path: '../outside.svg' },
      },
    ]);
    expect(malformed).toEqual([]);

    expect(
      normalizePluginThemes([
        {
          pluginId: 'pico.reader',
          id: 'pico.reader:legacy-inheritance',
          label: 'Legacy with invalid metadata',
          appearance: 'light',
          variables: {},
          inheritRoles: [],
        },
      ]),
    ).toEqual([]);
  });

  it('filters unsafe theme data and only applies existing CSS variables', () => {
    const [theme] = normalizePluginThemes([
      {
        pluginId: 'pico.reader',
        id: 'pico.reader:midnight',
        label: 'Midnight',
        appearance: 'dark',
        background: { entry: 'webui', path: 'assets/night.png' },
        brandIcon: { entry: 'webui', path: '../escape.svg' },
        pairedThemeId: 'other.plugin:day',
        brandLabel: 'safe <script>',
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
    expect(theme?.brandIcon).toBeUndefined();
    expect(theme?.pairedThemeId).toBeUndefined();
    expect(theme?.brandLabel).toBeUndefined();

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

  it('syncs recent explicit appearances across tabs and clears them with storage', () => {
    const events = new EventTarget();
    const values = new Map<string, string>([
      [RECENT_APPEARANCE_STORAGE_KEYS.light, 'pico.light'],
      [RECENT_APPEARANCE_STORAGE_KEYS.dark, 'pico.dark'],
    ]);
    const localStorage = { getItem: (key: string) => values.get(key) ?? null } as unknown as Storage;
    const received: string[] = [];
    const unsubscribe = subscribeToRecentAppearanceStorage(events, localStorage, (preferences) => {
      received.push(`${preferences.light ?? '-'}|${preferences.dark ?? '-'}`);
    });
    const dispatch = (key: string | null, newValue: string | null, storageArea: Storage) => {
      if (key === null) values.clear();
      else if (newValue === null) values.delete(key);
      else values.set(key, newValue);
      const event = new Event('storage');
      Object.defineProperties(event, {
        key: { value: key },
        newValue: { value: newValue },
        storageArea: { value: storageArea },
      });
      events.dispatchEvent(event);
    };
    dispatch(RECENT_APPEARANCE_STORAGE_KEYS.light, 'pico.reader:day', localStorage);
    dispatch(RECENT_APPEARANCE_STORAGE_KEYS.dark, 'pico.reader:night', localStorage);
    dispatch(RECENT_APPEARANCE_STORAGE_KEYS.light, 'system', localStorage);
    dispatch(null, null, localStorage);
    unsubscribe();
    dispatch(RECENT_APPEARANCE_STORAGE_KEYS.light, 'pico.light', localStorage);
    expect(received).toEqual([
      'pico.reader:day|pico.dark',
      'pico.reader:day|pico.reader:night',
      '-|pico.reader:night',
      '-|-',
    ]);
  });

  it('reads legacy combined history while preferring newer per-scheme values', () => {
    const values = new Map<string, string>([
      [RECENT_APPEARANCE_STORAGE_KEY, JSON.stringify({ light: 'pico.reader:day', dark: 'pico.reader:night' })],
      [RECENT_APPEARANCE_STORAGE_KEYS.light, 'system'],
      [RECENT_APPEARANCE_STORAGE_KEYS.dark, 'pico.dark'],
    ]);
    const storage = { getItem: (key: string) => values.get(key) ?? null } as unknown as Storage;

    expect(readRecentAppearancePreferencesFromStorage(storage)).toEqual({
      light: 'pico.reader:day',
      dark: 'pico.dark',
    });
  });
});
