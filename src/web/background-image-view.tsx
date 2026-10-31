import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { PluginUiSelect } from './plugin-ui-select.js';
import {
  BACKGROUND_IMAGE_TYPES,
  BACKGROUND_SETTINGS_V2_KEY,
  clearBackgroundImage,
  parseBackgroundSettings,
  readBackgroundImage,
  saveThemeBackgroundSettings,
  themeBackgroundPreferences,
  validateBackgroundImage,
  writeBackgroundImage,
  type BackgroundMode,
  type BackgroundSettings,
} from './background-image.js';

async function canDecodeImage(image: Blob): Promise<boolean> {
  const url = URL.createObjectURL(image);
  try {
    const preview = new Image();
    preview.src = url;
    await preview.decode();
    return preview.naturalWidth > 0 && preview.naturalHeight > 0;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readSettings(themeId: string): BackgroundSettings {
  try {
    return themeBackgroundPreferences(localStorage, themeId).settings;
  } catch {
    return parseBackgroundSettings(null);
  }
}

export function useMainBackgroundImage(themeId: string) {
  const [savedSettings, setSavedSettings] = useState(() => ({ themeId, settings: readSettings(themeId) }));
  const settings = savedSettings.themeId === themeId ? savedSettings.settings : readSettings(themeId);
  const [savedImage, setSavedImage] = useState<{ themeId: string; image: Blob | null }>({ themeId, image: null });
  const image = savedImage.themeId === themeId ? savedImage.image : null;
  const [savedUrl, setSavedUrl] = useState<{ themeId: string; url: string } | null>(null);
  const url = savedUrl?.themeId === themeId ? savedUrl.url : null;
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const channel = useRef<BroadcastChannel | null>(null);
  const operation = useRef(0);

  const updateSettings = (next: BackgroundSettings) => {
    setSavedSettings({ themeId, settings: next });
    try {
      saveThemeBackgroundSettings(localStorage, themeId, next);
    } catch {
      /* Session-only when storage is unavailable. */
    }
  };

  useEffect(() => {
    setSavedSettings({ themeId, settings: readSettings(themeId) });
    const onStorage = (event: StorageEvent) => {
      if (event.key === BACKGROUND_SETTINGS_V2_KEY || event.key === null)
        setSavedSettings({ themeId, settings: readSettings(themeId) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [themeId]);

  useLayoutEffect(() => {
    document.body.toggleAttribute(
      'data-pico-hide-theme-background',
      settings.mode !== 'theme' || settings.themeBlur > 0,
    );
    return () => document.body.removeAttribute('data-pico-hide-theme-background');
  }, [settings.mode, settings.themeBlur]);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    const load = async () => {
      const current = ++operation.current;
      try {
        let saved = await readBackgroundImage(themeId);
        const ownsLegacyImage = (() => {
          try {
            return themeBackgroundPreferences(localStorage, themeId).ownsLegacyImage;
          } catch {
            return false;
          }
        })();
        if (!saved && ownsLegacyImage) {
          saved = await readBackgroundImage();
          if (saved) await writeBackgroundImage(saved, themeId);
        }
        if (active && operation.current === current) setSavedImage({ themeId, image: saved });
      } catch {
        if (active && operation.current === current)
          setError('Could not access background image storage in this browser.');
      } finally {
        if (active && operation.current === current) setBusy(false);
      }
    };
    void load();
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel.current = new BroadcastChannel('pico.background-image');
        channel.current.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data === themeId) void load();
        };
      } catch {
        channel.current = null;
      }
    }
    return () => {
      active = false;
      operation.current += 1;
      channel.current?.close();
      channel.current = null;
    };
  }, [themeId]);

  useEffect(() => {
    if (!image) {
      setSavedUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(image);
    setSavedUrl({ themeId, url: nextUrl });
    return () => URL.revokeObjectURL(nextUrl);
  }, [image, themeId]);

  const choose = async (file: File): Promise<void> => {
    const validationError = validateBackgroundImage(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    const current = ++operation.current;
    setBusy(true);
    setError('');
    try {
      if (!(await canDecodeImage(file))) {
        if (operation.current === current) setError('This image could not be opened. Please choose another image.');
        return;
      }
      const imageBlob = file.slice(0, file.size, file.type);
      await writeBackgroundImage(imageBlob, themeId);
      if (operation.current !== current) return;
      setSavedImage({ themeId, image: imageBlob });
      updateSettings({ ...settings, mode: 'image' });
      try {
        channel.current?.postMessage(themeId);
      } catch {
        /* Local save already succeeded. */
      }
    } catch {
      if (operation.current === current)
        setError('Could not save the image in this browser. Please try another image.');
    } finally {
      if (operation.current === current) setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    const current = ++operation.current;
    setBusy(true);
    setError('');
    try {
      await clearBackgroundImage(themeId);
      if (themeBackgroundPreferences(localStorage, themeId).ownsLegacyImage) await clearBackgroundImage();
      if (operation.current !== current) return;
      setSavedImage({ themeId, image: null });
      if (settings.mode === 'image') updateSettings({ ...settings, mode: 'none' });
      try {
        channel.current?.postMessage(themeId);
      } catch {
        /* Local removal already succeeded. */
      }
    } catch {
      if (operation.current === current) setError('Could not remove the saved image from this browser.');
    } finally {
      if (operation.current === current) setBusy(false);
    }
  };

  const mode = settings.mode;
  const blur = mode === 'theme' ? settings.themeBlur : settings.imageBlur;
  return {
    url,
    hasImage: image !== null,
    busy,
    error,
    choose,
    remove,
    mode,
    blur,
    softness: settings.imageSoftness,
    setMode: (mode: BackgroundMode) => updateSettings({ ...settings, mode }),
    setBlur: (blur: number) => updateSettings({ ...settings, [mode === 'theme' ? 'themeBlur' : 'imageBlur']: blur }),
    setSoftness: (softness: number) => updateSettings({ ...settings, imageSoftness: softness }),
  };
}

export type MainBackgroundImage = ReturnType<typeof useMainBackgroundImage>;

export function BackgroundImageSetting({
  background,
  appearance,
}: {
  background: MainBackgroundImage;
  appearance: 'light' | 'dark';
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void background.choose(file);
  };
  return (
    <article className="native-tool-row general-setting-row background-image-setting">
      <div className="native-tool-copy">
        <div className="native-tool-title">
          <strong>Background image</strong>
        </div>
        <p>Choose a theme background or an image stored only in this browser.</p>
        {background.error ? (
          <p className="background-image-error" role="alert">
            {background.error}
          </p>
        ) : null}
      </div>
      <div className="background-image-actions">
        <PluginUiSelect
          label="Background"
          value={background.mode}
          compact={false}
          options={[
            { value: 'none', label: 'None' },
            { value: 'theme', label: 'Theme background' },
            { value: 'image', label: 'My image' },
          ]}
          onChange={(value) => background.setMode(value as BackgroundMode)}
        />
        <input
          ref={fileInput}
          type="file"
          accept={BACKGROUND_IMAGE_TYPES.join(',')}
          hidden
          onChange={onFileChange}
          aria-label="Choose background image"
        />
        <div className="background-image-buttons">
          <button
            type="button"
            className="button button-soft"
            disabled={background.busy}
            onClick={() => fileInput.current?.click()}
          >
            {background.hasImage ? 'Change image' : 'Choose image'}
          </button>
          {background.hasImage ? (
            <button
              type="button"
              className="button button-quiet"
              disabled={background.busy}
              onClick={() => void background.remove()}
            >
              Remove
            </button>
          ) : null}
        </div>
        {background.mode !== 'none' ? (
          <label className="background-image-adjustment">
            <span>Blur: {background.blur}px</span>
            <input
              aria-label="Background blur"
              type="range"
              min="0"
              max="20"
              step="1"
              value={background.blur}
              onChange={(event) => background.setBlur(Number(event.currentTarget.value))}
            />
          </label>
        ) : null}
        {background.mode === 'image' && background.hasImage ? (
          <label className="background-image-adjustment">
            <span>
              {appearance === 'dark' ? 'Dim' : 'Light'}: {background.softness}%
            </span>
            <input
              aria-label={appearance === 'dark' ? 'Dim background image' : 'Lighten background image'}
              type="range"
              min="0"
              max="100"
              step="1"
              value={background.softness}
              onChange={(event) => background.setSoftness(Number(event.currentTarget.value))}
            />
          </label>
        ) : null}
      </div>
    </article>
  );
}
