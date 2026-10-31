import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_SETTINGS_KEY,
  BACKGROUND_SETTINGS_V2_KEY,
  MAX_BACKGROUND_IMAGE_BYTES,
  parseBackgroundSettings,
  saveThemeBackgroundSettings,
  themeBackgroundPreferences,
  validateBackgroundImage,
} from '../src/web/background-image.js';

describe('browser background image selection', () => {
  it('accepts common raster images and rejects unsupported or oversized files', () => {
    expect(validateBackgroundImage({ type: 'image/png', size: 100 })).toBeNull();
    expect(validateBackgroundImage({ type: 'image/jpeg', size: MAX_BACKGROUND_IMAGE_BYTES })).toBeNull();
    expect(validateBackgroundImage({ type: 'image/svg+xml', size: 100 })).toMatch(/PNG, JPEG/);
    expect(validateBackgroundImage({ type: 'image/png', size: 0 })).toMatch(/non-empty/);
    expect(validateBackgroundImage({ type: 'image/png', size: MAX_BACKGROUND_IMAGE_BYTES + 1 })).toMatch(/10 MB/);
  });

  it('keeps theme backgrounds sharp by default and validates locally saved options', () => {
    expect(parseBackgroundSettings(null)).toEqual({ mode: 'none', themeBlur: 0, imageBlur: 4, imageSoftness: 0 });
    expect(parseBackgroundSettings('{bad')).toEqual({ mode: 'none', themeBlur: 0, imageBlur: 4, imageSoftness: 0 });
    expect(parseBackgroundSettings('{"mode":"image","themeBlur":-1,"imageBlur":99,"imageSoftness":200}')).toEqual({
      mode: 'image',
      themeBlur: 0,
      imageBlur: 20,
      imageSoftness: 100,
    });
    expect(parseBackgroundSettings('{"mode":"invalid","themeBlur":"4","imageBlur":2.7,"imageSoftness":-5}')).toEqual({
      mode: 'none',
      themeBlur: 0,
      imageBlur: 3,
      imageSoftness: 0,
    });
    expect(parseBackgroundSettings('{"imageSoftness":27.6}').imageSoftness).toBe(28);
    expect(parseBackgroundSettings('{"imageSoftness":"50"}').imageSoftness).toBe(0);
  });

  it('remembers each theme independently and preserves the previous image owner during migration', () => {
    const values = new Map([[BACKGROUND_SETTINGS_KEY, JSON.stringify({ mode: 'image', imageBlur: 7, themeBlur: 1 })]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(themeBackgroundPreferences(storage, 'plugin:blue')).toEqual({
      settings: { mode: 'image', imageBlur: 7, themeBlur: 1, imageSoftness: 0 },
      ownsLegacyImage: true,
    });
    expect(themeBackgroundPreferences(storage, 'pico.dark')).toEqual({
      settings: { mode: 'none', imageBlur: 4, themeBlur: 0, imageSoftness: 0 },
      ownsLegacyImage: false,
    });
    saveThemeBackgroundSettings(storage, 'pico.dark', { mode: 'theme', imageBlur: 5, themeBlur: 2, imageSoftness: 65 });
    expect(themeBackgroundPreferences(storage, 'pico.dark').settings.mode).toBe('theme');
    expect(themeBackgroundPreferences(storage, 'pico.dark').settings.imageSoftness).toBe(65);
    expect(themeBackgroundPreferences(storage, 'plugin:blue').settings.imageBlur).toBe(7);
    expect(themeBackgroundPreferences(storage, 'plugin:blue').settings.imageSoftness).toBe(0);
    expect(values.has(BACKGROUND_SETTINGS_KEY)).toBe(true);
  });

  it('recovers an interrupted development hot reload migration', () => {
    const values = new Map([
      [BACKGROUND_SETTINGS_V2_KEY, JSON.stringify({ themes: { undefined: { mode: 'image', imageBlur: 6 } } })],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(themeBackgroundPreferences(storage, 'plugin:blue')).toEqual({
      settings: { mode: 'image', imageBlur: 6, themeBlur: 0, imageSoftness: 0 },
      ownsLegacyImage: true,
    });
  });
});
