/** Browser-local image used behind the main interface, never sent to Runtime. */
const DATABASE_NAME = 'pico.local-appearance';
const STORE_NAME = 'background';
const IMAGE_KEY = 'main';
export const MAX_BACKGROUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const BACKGROUND_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'] as const;
export const BACKGROUND_SETTINGS_KEY = 'pico.background-settings';
export const BACKGROUND_SETTINGS_V2_KEY = 'pico.background-settings.v2';
export type BackgroundMode = 'theme' | 'none' | 'image';
export interface BackgroundSettings {
  mode: BackgroundMode;
  themeBlur: number;
  imageBlur: number;
}
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = { mode: 'none', themeBlur: 0, imageBlur: 4 };

export function parseBackgroundSettings(value: string | null): BackgroundSettings {
  try {
    const saved: unknown = value ? JSON.parse(value) : null;
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_BACKGROUND_SETTINGS };
    const record = saved as Record<string, unknown>;
    const blur = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.min(20, Math.max(0, Math.round(value))) : fallback;
    return {
      mode: record.mode === 'theme' || record.mode === 'image' ? record.mode : 'none',
      themeBlur: blur(record.themeBlur, 0),
      imageBlur: blur(record.imageBlur, 4),
    };
  } catch {
    return { ...DEFAULT_BACKGROUND_SETTINGS };
  }
}

interface BackgroundPreferences {
  themes: Record<string, BackgroundSettings>;
  legacyImageOwner?: string;
}

function readPreferences(storage: Pick<Storage, 'getItem'>): BackgroundPreferences | null {
  try {
    const raw = storage.getItem(BACKGROUND_SETTINGS_V2_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (!record.themes || typeof record.themes !== 'object' || Array.isArray(record.themes)) return null;
    return {
      themes: record.themes as Record<string, BackgroundSettings>,
      ...(typeof record.legacyImageOwner === 'string' ? { legacyImageOwner: record.legacyImageOwner } : {}),
    };
  } catch {
    return null;
  }
}

/** Upgrade the previous single background without discarding its image or settings. */
export function themeBackgroundPreferences(storage: Pick<Storage, 'getItem' | 'setItem'>, themeId: string) {
  let saved = readPreferences(storage);
  if (!saved) {
    const legacy = storage.getItem(BACKGROUND_SETTINGS_KEY);
    saved = { themes: {} };
    if (legacy) {
      saved.themes[themeId] = parseBackgroundSettings(legacy);
      saved.legacyImageOwner = themeId;
    }
    storage.setItem(BACKGROUND_SETTINGS_V2_KEY, JSON.stringify(saved));
  }
  // A development hot reload can briefly mount the new hook before its caller
  // passes a theme ID. Recover that interim migration without losing the image.
  if (!saved.legacyImageOwner && Object.hasOwn(saved.themes, 'undefined')) {
    if (!Object.hasOwn(saved.themes, themeId)) saved.themes[themeId] = saved.themes.undefined!;
    delete saved.themes.undefined;
    saved.legacyImageOwner = themeId;
    storage.setItem(BACKGROUND_SETTINGS_V2_KEY, JSON.stringify(saved));
  }
  const value = Object.hasOwn(saved.themes, themeId) ? JSON.stringify(saved.themes[themeId]) : null;
  return { settings: parseBackgroundSettings(value), ownsLegacyImage: saved.legacyImageOwner === themeId };
}

export function saveThemeBackgroundSettings(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  themeId: string,
  settings: BackgroundSettings,
): void {
  themeBackgroundPreferences(storage, themeId);
  const saved = readPreferences(storage) ?? { themes: {} };
  saved.themes[themeId] = settings;
  storage.setItem(BACKGROUND_SETTINGS_V2_KEY, JSON.stringify(saved));
}

export function validateBackgroundImage(file: Pick<Blob, 'type' | 'size'>): string | null {
  if (!BACKGROUND_IMAGE_TYPES.includes(file.type as (typeof BACKGROUND_IMAGE_TYPES)[number])) {
    return 'Choose a PNG, JPEG, WebP, AVIF, or GIF image.';
  }
  if (file.size === 0 || file.size > MAX_BACKGROUND_IMAGE_BYTES) {
    return 'Choose a non-empty image no larger than 10 MB.';
  }
  return null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Browser storage is unavailable.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    let settled = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error('Could not open browser storage.'));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('Browser storage is blocked.'));
    };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
  });
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage was interrupted.'));
    });
  } finally {
    db.close();
  }
}

export async function readBackgroundImage(themeId?: string): Promise<Blob | null> {
  const image: unknown = await runTransaction('readonly', (store) =>
    store.get(themeId ? `theme:${themeId}` : IMAGE_KEY),
  );
  return image instanceof Blob && !validateBackgroundImage(image) ? image : null;
}

export async function writeBackgroundImage(image: Blob, themeId?: string): Promise<void> {
  const validationError = validateBackgroundImage(image);
  if (validationError) throw new Error(validationError);
  await runTransaction('readwrite', (store) => store.put(image, themeId ? `theme:${themeId}` : IMAGE_KEY));
}

export async function clearBackgroundImage(themeId?: string): Promise<void> {
  await runTransaction('readwrite', (store) => store.delete(themeId ? `theme:${themeId}` : IMAGE_KEY));
}
