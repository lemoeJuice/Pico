import { describe, expect, it } from 'vitest';
import {
  nextExplicitAppearance,
  parseAppearancePreference,
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
    dispatch('pico.appearance', 'system', otherStorage);
    dispatch('other.setting', 'pico.dark', localStorage);
    dispatch('pico.appearance', null, localStorage);
    dispatch(null, 'invalid', localStorage);
    unsubscribe();
    dispatch('pico.appearance', 'pico.dark', localStorage);

    expect(received).toEqual(['pico.dark', 'pico.light', 'pico.light']);
    expect(writes).toBe(0);
  });
});
