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
import { MAX_THEME_VARIABLES, type RegisteredTheme } from '../contracts/plugin-theme.js';

export type ResolvedAppearance = 'light' | 'dark';

export type RegisteredThemeContribution = RegisteredTheme;

export type PluginThemeId = `${string}:${string}`;

export const BUILT_IN_THEMES = [
  { id: 'pico.light', label: 'Light', appearance: 'light' },
  { id: 'pico.dark', label: 'Dark', appearance: 'dark' },
] as const;

export type BuiltInThemeId = (typeof BUILT_IN_THEMES)[number]['id'];
export type AppearancePreference = 'system' | BuiltInThemeId | PluginThemeId;
export type AppearanceOption = { value: AppearancePreference; label: string };

export const APPEARANCE_STORAGE_KEY = 'pico.appearance';

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
    if (source.variables && typeof source.variables === 'object' && !Array.isArray(source.variables)) {
      for (const [name, variableValue] of Object.entries(source.variables).slice(0, MAX_THEME_VARIABLES)) {
        if (/^--pico-[a-z0-9-]{1,120}$/.test(name) && typeof variableValue === 'string' && safeThemeVariableValue(variableValue)) {
          variables[name] = variableValue;
        }
      }
    }
    let background: RegisteredThemeContribution['background'];
    if (
      source.background &&
      typeof source.background === 'object' &&
      !Array.isArray(source.background) &&
      typeof (source.background as Record<string, unknown>).entry === 'string' &&
      typeof (source.background as Record<string, unknown>).path === 'string'
    ) {
      const candidateBackground = source.background as { entry: string; path: string };
      if (
        /^[a-z0-9][a-z0-9._-]{0,127}$/.test(candidateBackground.entry) &&
        candidateBackground.path.length <= 256 &&
        !candidateBackground.path.startsWith('/') &&
        !candidateBackground.path.includes('\\') &&
        candidateBackground.path.split('/').every((segment) => segment && segment !== '.' && segment !== '..') &&
        /^[a-zA-Z0-9._/-]+$/.test(candidateBackground.path)
      ) {
        background = { entry: candidateBackground.entry, path: candidateBackground.path };
      }
    }
    result.push({ id, pluginId, label, appearance, variables, ...(background ? { background } : {}) });
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

export function nextExplicitAppearance(current: ResolvedAppearance): Exclude<AppearancePreference, 'system'> {
  return current === 'light' ? 'pico.dark' : 'pico.light';
}

export function themeColorForAppearance(resolved: ResolvedAppearance, pluginPageBackground?: string): string {
  const candidate = pluginPageBackground?.trim();
  if (candidate && (/^#[\da-f]{3,8}$/i.test(candidate) || globalThis.CSS?.supports?.('color', candidate))) {
    return candidate;
  }
  return resolved === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

export function pluginThemeBackgroundUrl(theme: RegisteredThemeContribution | undefined): string | undefined {
  if (!theme?.background) return undefined;
  const pluginId = encodeURIComponent(theme.pluginId);
  const entry = encodeURIComponent(theme.background.entry);
  const path = theme.background.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `url("/_pico/plugin-ui/${pluginId}/${entry}/current/${path}")`;
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
  const priorInlineVariables = useRef(new Map<string, { value: string; priority: string }>());
  const resolved = resolveAppearance(preference, systemDark, themes);
  const themeId = resolveThemeId(preference, systemDark, themes);
  const activeTheme = themes.find((theme) => theme.id === preference);
  const options = useMemo(() => appearanceOptions(themes), [themes]);

  const setPreference = useCallback((nextPreference: AppearancePreference) => {
    persistAppearancePreference(nextPreference);
    if (nextPreference === 'system') setSystemDark(readSystemDark());
    setPreferenceState(nextPreference);
  }, []);

  const setThemes = useCallback((nextThemes: unknown) => {
    setThemesState(normalizePluginThemes(nextThemes));
  }, []);

  const toggleExplicitTheme = useCallback(() => {
    setPreference(nextExplicitAppearance(resolved));
  }, [resolved, setPreference]);

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
