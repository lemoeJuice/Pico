import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ResolvedAppearance = 'light' | 'dark';

export const BUILT_IN_THEMES = [
  { id: 'pico.light', label: 'Light', appearance: 'light' },
  { id: 'pico.dark', label: 'Dark', appearance: 'dark' },
] as const;

export type BuiltInThemeId = (typeof BUILT_IN_THEMES)[number]['id'];
export type AppearancePreference = 'system' | BuiltInThemeId;

export const APPEARANCE_OPTIONS: Array<{ value: AppearancePreference; label: string }> = [
  { value: 'system', label: 'System' },
  ...BUILT_IN_THEMES.map(({ id, label }) => ({ value: id, label })),
];

export const APPEARANCE_STORAGE_KEY = 'pico.appearance';

const BOOT_PREFERENCE_ATTRIBUTE = 'data-pico-appearance-preference';
const LIGHT_THEME_COLOR = '#f5f7f4';
const DARK_THEME_COLOR = '#171f1a';
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function parseAppearancePreference(value: string | null | undefined): AppearancePreference | null {
  if (value === 'system') return value;
  return BUILT_IN_THEMES.some((theme) => theme.id === value) ? (value as BuiltInThemeId) : null;
}

export function resolveAppearance(preference: AppearancePreference, systemDark: boolean): ResolvedAppearance {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return BUILT_IN_THEMES.find((theme) => theme.id === preference)?.appearance ?? 'light';
}

export function resolveThemeId(preference: AppearancePreference, systemDark: boolean): BuiltInThemeId {
  const resolved = resolveAppearance(preference, systemDark);
  return BUILT_IN_THEMES.find((theme) => theme.appearance === resolved)?.id ?? 'pico.light';
}

export function nextExplicitAppearance(current: ResolvedAppearance): Exclude<AppearancePreference, 'system'> {
  return current === 'light' ? 'pico.dark' : 'pico.light';
}

export function themeColorForAppearance(resolved: ResolvedAppearance): string {
  return resolved === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

export function subscribeToAppearanceStorage(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  localStorage: Storage,
  onPreference: (preference: AppearancePreference) => void,
): () => void {
  const onStorage = (event: Event): void => {
    const change = event as StorageEvent;
    if ((change.key !== APPEARANCE_STORAGE_KEY && change.key !== null) || change.storageArea !== localStorage) return;
    onPreference(parseAppearancePreference(change.newValue) ?? 'pico.light');
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

function readBootPreference(): AppearancePreference | null {
  if (typeof document === 'undefined') return null;
  return parseAppearancePreference(document.documentElement.getAttribute(BOOT_PREFERENCE_ATTRIBUTE));
}

function readAppearancePreference(): AppearancePreference {
  try {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return parseAppearancePreference(stored) ?? readBootPreference() ?? 'pico.light';
  } catch {
    return readBootPreference() ?? 'pico.light';
  }
}

function persistAppearancePreference(preference: AppearancePreference): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Keep the chosen appearance for this session when browser storage is unavailable.
  }
}

function readSystemDark(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.(SYSTEM_DARK_QUERY).matches === true;
  } catch {
    return false;
  }
}

function applyAppearance(
  preference: AppearancePreference,
  themeId: BuiltInThemeId,
  resolved: ResolvedAppearance,
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-pico-theme', themeId);
  root.setAttribute(BOOT_PREFERENCE_ATTRIBUTE, preference);
  root.style.colorScheme = resolved;
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute('content', themeColorForAppearance(resolved));
}

type AppearanceContextValue = {
  preference: AppearancePreference;
  resolved: ResolvedAppearance;
  themeId: BuiltInThemeId;
  setPreference(preference: AppearancePreference): void;
  toggleExplicitTheme(): void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readAppearancePreference);
  const [systemDark, setSystemDark] = useState(readSystemDark);
  const resolved = resolveAppearance(preference, systemDark);
  const themeId = resolveThemeId(preference, systemDark);

  const setPreference = useCallback((nextPreference: AppearancePreference) => {
    persistAppearancePreference(nextPreference);
    if (nextPreference === 'system') setSystemDark(readSystemDark());
    setPreferenceState(nextPreference);
  }, []);

  const toggleExplicitTheme = useCallback(() => {
    setPreference(nextExplicitAppearance(resolved));
  }, [resolved, setPreference]);

  useLayoutEffect(() => {
    applyAppearance(preference, themeId, resolved);
  }, [preference, resolved, themeId]);

  useEffect(() => {
    if (preference !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia(SYSTEM_DARK_QUERY);
    } catch {
      return;
    }
    setSystemDark(media.matches);
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    if (media.addEventListener) {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, [preference]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let localStorage: Storage;
    try {
      localStorage = window.localStorage;
    } catch {
      return;
    }
    return subscribeToAppearanceStorage(window, localStorage, (nextPreference) => {
      if (nextPreference === 'system') setSystemDark(readSystemDark());
      setPreferenceState(nextPreference);
    });
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, themeId, setPreference, toggleExplicitTheme }),
    [preference, resolved, themeId, setPreference, toggleExplicitTheme],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('useAppearance must be used inside AppearanceProvider.');
  return value;
}
