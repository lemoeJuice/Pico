import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  MAX_THEME_VARIABLES,
  themeRoleCoverageErrors,
  type RegisteredTheme,
  type ThemeAssetReference,
} from '../contracts/plugin-theme.js';

export type ResolvedAppearance = 'light' | 'dark';

export type RegisteredThemeContribution = RegisteredTheme;

export type PluginThemeId = `${string}:${string}`;

export const BUILT_IN_THEMES = [
  { id: 'pico.light', label: 'Light', appearance: 'light' },
  { id: 'pico.dark', label: 'Dark', appearance: 'dark' },
] as const;

export type BuiltInThemeId = (typeof BUILT_IN_THEMES)[number]['id'];
export type AppearancePreference = 'system' | BuiltInThemeId | PluginThemeId;
export type ExplicitAppearancePreference = Exclude<AppearancePreference, 'system'>;
export type AppearanceOption = { value: AppearancePreference; label: string };
export type RecentAppearancePreferences = Record<ResolvedAppearance, ExplicitAppearancePreference | null>;

export const APPEARANCE_STORAGE_KEY = 'pico.appearance';
/** Legacy combined history key. New writes use the per-scheme keys below. */
export const RECENT_APPEARANCE_STORAGE_KEY = 'pico.appearance.recent';
export const RECENT_APPEARANCE_STORAGE_KEYS: Record<ResolvedAppearance, string> = {
  light: 'pico.appearance.recent.light',
  dark: 'pico.appearance.recent.dark',
};
const EMPTY_RECENT_APPEARANCE_PREFERENCES: RecentAppearancePreferences = { light: null, dark: null };

const BOOT_PREFERENCE_ATTRIBUTE = 'data-pico-appearance-preference';
const LIGHT_THEME_COLOR = '#f5f7f4';
const DARK_THEME_COLOR = '#171f1a';
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function parseAppearancePreference(value: string | null | undefined): AppearancePreference | null {
  if (value === 'system') return value;
  if (BUILT_IN_THEMES.some((theme) => theme.id === value)) return value as BuiltInThemeId;
  return typeof value === 'string' && isPluginThemeId(value) ? (value as PluginThemeId) : null;
}

export function isPluginThemeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function isExplicitAppearancePreference(value: unknown): value is ExplicitAppearancePreference {
  return typeof value === 'string' && value !== 'system' && parseAppearancePreference(value) !== null;
}

export function parseRecentAppearancePreferences(value: string | null | undefined): RecentAppearancePreferences {
  if (!value) return { ...EMPTY_RECENT_APPEARANCE_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_RECENT_APPEARANCE_PREFERENCES };
    const record = parsed as Record<string, unknown>;
    return {
      light: isExplicitAppearancePreference(record.light) ? record.light : null,
      dark: isExplicitAppearancePreference(record.dark) ? record.dark : null,
    };
  } catch {
    return { ...EMPTY_RECENT_APPEARANCE_PREFERENCES };
  }
}

function parseRecentPreference(value: string | null): ExplicitAppearancePreference | null {
  return isExplicitAppearancePreference(value) ? value : null;
}

export function readRecentAppearancePreferencesFromStorage(
  storage: Pick<Storage, 'getItem'>,
): RecentAppearancePreferences {
  let legacy: RecentAppearancePreferences = { ...EMPTY_RECENT_APPEARANCE_PREFERENCES };
  try {
    legacy = parseRecentAppearancePreferences(storage.getItem(RECENT_APPEARANCE_STORAGE_KEY));
    const light = storage.getItem(RECENT_APPEARANCE_STORAGE_KEYS.light);
    const dark = storage.getItem(RECENT_APPEARANCE_STORAGE_KEYS.dark);
    return {
      light: (light === null ? null : parseRecentPreference(light)) ?? legacy.light,
      dark: (dark === null ? null : parseRecentPreference(dark)) ?? legacy.dark,
    };
  } catch {
    return legacy;
  }
}

function isAvailableForAppearance(
  preference: ExplicitAppearancePreference | null,
  appearance: ResolvedAppearance,
  themes: RegisteredThemeContribution[],
): preference is ExplicitAppearancePreference {
  if (!preference) return false;
  const builtIn = BUILT_IN_THEMES.find((theme) => theme.id === preference);
  if (builtIn) return builtIn.appearance === appearance;
  return themes.some((theme) => theme.id === preference && theme.appearance === appearance);
}

export function latestAvailableAppearancePreference(
  appearance: ResolvedAppearance,
  recent: RecentAppearancePreferences,
  themes: RegisteredThemeContribution[],
): ExplicitAppearancePreference {
  const remembered = recent[appearance];
  if (isAvailableForAppearance(remembered, appearance, themes)) return remembered;
  return appearance === 'light' ? 'pico.light' : 'pico.dark';
}

function isSafePluginId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function safeThemeVariableValue(value: string): boolean {
  if (value.length === 0 || value.length > 256 || value.trim() !== value) return false;
  if (/(?:url|var|expression)\s*\(|javascript\s*:/i.test(value)) return false;
  if (/[;{}\\\u0000-\u001f\u007f<>]/.test(value) || !/^[a-zA-Z0-9#(),.%+/'"\s-]+$/.test(value)) return false;
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')' && --depth < 0) return false;
  }
  if (depth !== 0) return false;
  const functions = value.match(/[a-zA-Z-]+(?=\s*\()/g) ?? [];
  return functions.every((name) => /^(?:rgb|rgba|hsl|hsla|linear-gradient|radial-gradient|blur)$/i.test(name));
}

function normalizeThemeAssetReference(value: unknown): ThemeAssetReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.entry !== 'string' || typeof candidate.path !== 'string') return undefined;
  const { entry, path } = candidate as { entry: string; path: string };
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry) ||
    path.length > 256 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    !/^[a-zA-Z0-9._/-]+$/.test(path)
  ) {
    return undefined;
  }
  return { entry, path };
}

export function normalizePluginThemes(value: unknown): RegisteredThemeContribution[] {
  if (!Array.isArray(value)) return [];
  const result: RegisteredThemeContribution[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const source = candidate as Record<string, unknown>;
    const id = typeof source.id === 'string' ? source.id : '';
    const pluginId = source.pluginId;
    const label = typeof source.label === 'string' ? source.label.trim() : '';
    const appearance = source.appearance;
    if (
      !isSafePluginId(pluginId) ||
      !isPluginThemeId(id) ||
      !id.startsWith(`${pluginId}:`) ||
      !label ||
      label.length > 80 ||
      (appearance !== 'light' && appearance !== 'dark') ||
      seen.has(id)
    )
      continue;
    const variables: Record<string, string> = {};
    const strict = source.coverage !== undefined;
    if (strict && source.coverage !== 'complete') continue;
    if (!strict && source.inheritRoles !== undefined) continue;
    const sourceVariables = source.variables;
    if (sourceVariables && typeof sourceVariables === 'object' && !Array.isArray(sourceVariables)) {
      const entries = Object.entries(sourceVariables);
      if (strict && entries.length > MAX_THEME_VARIABLES) continue;
      let invalidStrictValue = false;
      for (const [name, variableValue] of strict ? entries : entries.slice(0, MAX_THEME_VARIABLES)) {
        const validName = /^--pico-[a-z0-9-]{1,120}$/.test(name);
        const validValue = typeof variableValue === 'string' && safeThemeVariableValue(variableValue);
        if (strict && (!validName || !validValue)) {
          invalidStrictValue = true;
          break;
        }
        if (validName && validValue) variables[name] = variableValue;
      }
      if (invalidStrictValue) continue;
    } else if (strict) {
      continue;
    }
    const inherited = source.inheritRoles;
    if (
      strict &&
      themeRoleCoverageErrors({
        coverage: source.coverage as 'complete',
        variables,
        ...(Array.isArray(inherited) ? { inheritRoles: inherited as string[] } : {}),
      }).length > 0
    )
      continue;
    const pairedThemeId = typeof source.pairedThemeId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(source.pairedThemeId)
      ? source.pairedThemeId
      : undefined;
    const brandLabel = typeof source.brandLabel === 'string' && source.brandLabel.trim() && source.brandLabel.length <= 40 && !/[\u0000-\u001f\u007f-\u009f<>]/.test(source.brandLabel)
      ? source.brandLabel
      : undefined;
    const background = normalizeThemeAssetReference(source.background);
    const brandIcon = normalizeThemeAssetReference(source.brandIcon);
    if (
      strict &&
      ((source.pairedThemeId !== undefined && pairedThemeId === undefined) ||
        (source.brandLabel !== undefined && brandLabel === undefined) ||
        (source.background !== undefined && background === undefined) ||
        (source.brandIcon !== undefined && brandIcon === undefined))
    )
      continue;
    result.push({
      id,
      pluginId,
      label,
      appearance,
      variables,
      ...(strict ? { coverage: 'complete' as const } : {}),
      ...(Array.isArray(inherited) ? { inheritRoles: [...(inherited as string[])] } : {}),
      ...(background ? { background } : {}),
      ...(brandIcon ? { brandIcon } : {}),
      ...(pairedThemeId ? { pairedThemeId } : {}),
      ...(brandLabel ? { brandLabel } : {}),
    });
    seen.add(id);
  }
  return result;
}

export function appearanceOptions(themes: RegisteredThemeContribution[]): AppearanceOption[] {
  return [
    { value: 'system', label: 'System' },
    ...BUILT_IN_THEMES.map(({ id, label }) => ({ value: id, label })),
    ...themes.map((theme) => ({
      value: theme.id as PluginThemeId,
      label: themes.filter((item) => item.label === theme.label).length > 1 ? `${theme.label} (${theme.pluginId})` : theme.label,
    })),
  ];
}

export function appearanceSelectionState(
  preference: AppearancePreference,
  effectiveThemeId: string,
  options: AppearanceOption[],
): { value: AppearancePreference; unavailable: boolean } {
  if (options.some((option) => option.value === preference)) return { value: preference, unavailable: false };
  return { value: effectiveThemeId as AppearancePreference, unavailable: true };
}

export function resolveAppearance(
  preference: AppearancePreference,
  systemDark: boolean,
  themes: RegisteredThemeContribution[] = [],
): ResolvedAppearance {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return (
    BUILT_IN_THEMES.find((theme) => theme.id === preference)?.appearance ??
    themes.find((theme) => theme.id === preference)?.appearance ??
    'light'
  );
}

export function resolveThemeId(
  preference: AppearancePreference,
  systemDark: boolean,
  themes: RegisteredThemeContribution[] = [],
): string {
  if (preference === 'system') return systemDark ? 'pico.dark' : 'pico.light';
  if (BUILT_IN_THEMES.some((theme) => theme.id === preference)) return preference;
  return themes.some((theme) => theme.id === preference) ? preference : 'pico.light';
}

export function nextExplicitAppearance(
  current: ResolvedAppearance,
  activeTheme?: RegisteredThemeContribution,
  themes: RegisteredThemeContribution[] = [],
  recent: RecentAppearancePreferences = EMPTY_RECENT_APPEARANCE_PREFERENCES,
): ExplicitAppearancePreference {
  const target: ResolvedAppearance = current === 'light' ? 'dark' : 'light';
  if (activeTheme?.pairedThemeId) {
    const paired = themes.find(
      (theme) => theme.pluginId === activeTheme.pluginId && theme.id === `${activeTheme.pluginId}:${activeTheme.pairedThemeId}`,
    );
    if (paired?.appearance === target) return paired.id as PluginThemeId;
  }
  return latestAvailableAppearancePreference(target, recent, themes);
}

export function themeColorForAppearance(resolved: ResolvedAppearance, pluginPageBackground?: string): string {
  const candidate = pluginPageBackground?.trim();
  if (candidate && (/^#[\da-f]{3,8}$/i.test(candidate) || globalThis.CSS?.supports?.('color', candidate))) {
    return candidate;
  }
  return resolved === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

function pluginThemeAssetUrl(theme: RegisteredThemeContribution | undefined, asset: ThemeAssetReference | undefined): string | undefined {
  if (!theme || !asset) return undefined;
  const pluginId = encodeURIComponent(theme.pluginId);
  const entry = encodeURIComponent(asset.entry);
  const path = asset.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/_pico/plugin-ui/${pluginId}/${entry}/current/${path}`;
}

export function pluginThemeBackgroundUrl(theme: RegisteredThemeContribution | undefined): string | undefined {
  const url = pluginThemeAssetUrl(theme, theme?.background);
  return url ? `url("${url}")` : undefined;
}

export function pluginThemeBrandIconUrl(theme: RegisteredThemeContribution | undefined): string | undefined {
  return pluginThemeAssetUrl(theme, theme?.brandIcon);
}

type MutableThemeStyle = Pick<CSSStyleDeclaration, 'getPropertyValue' | 'getPropertyPriority' | 'setProperty' | 'removeProperty'>;
type ComputedThemeStyle = Pick<CSSStyleDeclaration, 'getPropertyValue'>;

export function applyPluginThemeVariables(
  style: MutableThemeStyle,
  getComputed: () => ComputedThemeStyle,
  theme: RegisteredThemeContribution | undefined,
  backgroundImage: string | undefined,
  priorInlineVariables: Map<string, { value: string; priority: string }>,
): void {
  for (const [name, prior] of priorInlineVariables) {
    if (prior.value) style.setProperty(name, prior.value, prior.priority);
    else style.removeProperty(name);
  }
  priorInlineVariables.clear();
  if (!theme && !backgroundImage) return;
  const computed = getComputed();
  for (const [name, value] of Object.entries(theme?.variables ?? {})) {
    if (
      !/^--pico-[a-z0-9-]{1,120}$/.test(name) ||
      name === '--pico-theme-background-image' ||
      !safeThemeVariableValue(value) ||
      computed.getPropertyValue(name).trim() === ''
    )
      continue;
    priorInlineVariables.set(name, {
      value: style.getPropertyValue(name),
      priority: style.getPropertyPriority(name),
    });
    style.setProperty(name, value);
  }
  const backgroundName = '--pico-theme-background-image';
  if (backgroundImage && computed.getPropertyValue(backgroundName).trim() !== '') {
    priorInlineVariables.set(backgroundName, {
      value: style.getPropertyValue(backgroundName),
      priority: style.getPropertyPriority(backgroundName),
    });
    style.setProperty(backgroundName, backgroundImage);
  }
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

export function subscribeToRecentAppearanceStorage(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  localStorage: Storage,
  onPreferences: (preferences: RecentAppearancePreferences) => void,
): () => void {
  const onStorage = (event: Event): void => {
    const change = event as StorageEvent;
    if (
      (change.key !== RECENT_APPEARANCE_STORAGE_KEY &&
        change.key !== RECENT_APPEARANCE_STORAGE_KEYS.light &&
        change.key !== RECENT_APPEARANCE_STORAGE_KEYS.dark &&
        change.key !== null) ||
      change.storageArea !== localStorage
    ) return;
    onPreferences(
      change.key === null ? { ...EMPTY_RECENT_APPEARANCE_PREFERENCES } : readRecentAppearancePreferencesFromStorage(localStorage),
    );
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

function readRecentAppearancePreferences(): RecentAppearancePreferences {
  try {
    return typeof window === 'undefined'
      ? { ...EMPTY_RECENT_APPEARANCE_PREFERENCES }
      : readRecentAppearancePreferencesFromStorage(window.localStorage);
  } catch {
    return { ...EMPTY_RECENT_APPEARANCE_PREFERENCES };
  }
}

function persistRecentAppearancePreference(appearance: ResolvedAppearance, preference: ExplicitAppearancePreference): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(RECENT_APPEARANCE_STORAGE_KEYS[appearance], preference);
    }
  } catch {
    // Keep recent choices for this session when browser storage is unavailable.
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
  themeId: string,
  resolved: ResolvedAppearance,
  pluginTheme: RegisteredThemeContribution | undefined,
  priorInlineVariables: Map<string, { value: string; priority: string }>,
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-pico-theme', themeId);
  root.setAttribute('data-pico-color-scheme', resolved);
  root.setAttribute(BOOT_PREFERENCE_ATTRIBUTE, preference);
  root.style.colorScheme = resolved;
  applyPluginThemeVariables(
    root.style,
    () => getComputedStyle(root),
    pluginTheme,
    pluginThemeBackgroundUrl(pluginTheme),
    priorInlineVariables,
  );
  const pageBackground = pluginTheme?.variables['--pico-page-bg'];
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute('content', themeColorForAppearance(resolved, pageBackground));
}

type AppearanceContextValue = {
  preference: AppearancePreference;
  resolved: ResolvedAppearance;
  themeId: string;
  options: AppearanceOption[];
  activeTheme: RegisteredThemeContribution | undefined;
  setPreference(preference: AppearancePreference): void;
  setThemes(themes: unknown): void;
  toggleExplicitTheme(): void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readAppearancePreference);
  const [systemDark, setSystemDark] = useState(readSystemDark);
  const [themes, setThemesState] = useState<RegisteredThemeContribution[]>([]);
  const [recentPreferences, setRecentPreferences] = useState(readRecentAppearancePreferences);
  const recentPreferencesRef = useRef(recentPreferences);
  const priorInlineVariables = useRef(new Map<string, { value: string; priority: string }>());
  const resolved = resolveAppearance(preference, systemDark, themes);
  const themeId = resolveThemeId(preference, systemDark, themes);
  const activeTheme = themes.find((theme) => theme.id === preference);
  const options = useMemo(() => appearanceOptions(themes), [themes]);

  const rememberPreference = useCallback(
    (nextPreference: ExplicitAppearancePreference) => {
      const appearance = resolveAppearance(nextPreference, systemDark, themes);
      if (!isAvailableForAppearance(nextPreference, appearance, themes)) return;
      const current = recentPreferencesRef.current;
      if (current[appearance] === nextPreference) return;
      const next = { ...current, [appearance]: nextPreference };
      recentPreferencesRef.current = next;
      setRecentPreferences(next);
      persistRecentAppearancePreference(appearance, nextPreference);
    },
    [systemDark, themes],
  );

  const setPreference = useCallback(
    (nextPreference: AppearancePreference) => {
      persistAppearancePreference(nextPreference);
      if (nextPreference === 'system') {
        setSystemDark(readSystemDark());
      } else {
        rememberPreference(nextPreference);
      }
      setPreferenceState(nextPreference);
    },
    [rememberPreference],
  );

  const setThemes = useCallback((nextThemes: unknown) => {
    setThemesState(normalizePluginThemes(nextThemes));
  }, []);

  const toggleExplicitTheme = useCallback(() => {
    setPreference(nextExplicitAppearance(resolved, activeTheme, themes, recentPreferences));
  }, [activeTheme, recentPreferences, resolved, setPreference, themes]);

  useLayoutEffect(() => {
    applyAppearance(preference, themeId, resolved, activeTheme, priorInlineVariables.current);
  }, [preference, resolved, themeId, activeTheme]);

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

  useEffect(() => {
    if (preference !== 'system') rememberPreference(preference);
  }, [preference, rememberPreference]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let localStorage: Storage;
    try {
      localStorage = window.localStorage;
    } catch {
      return;
    }
    return subscribeToRecentAppearanceStorage(window, localStorage, (next) => {
      recentPreferencesRef.current = next;
      setRecentPreferences(next);
    });
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, themeId, options, activeTheme, setPreference, setThemes, toggleExplicitTheme }),
    [preference, resolved, themeId, options, activeTheme, setPreference, setThemes, toggleExplicitTheme],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('useAppearance must be used inside AppearanceProvider.');
  return value;
}
