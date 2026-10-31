import { THEME_ROLE_SCHEMA } from './theme-role-schema.js';

/** Upper bound shared by the Runtime validator and the WebUI. */
export const MAX_THEME_VARIABLES = THEME_ROLE_SCHEMA.length;
export const MAX_THEME_INHERIT_ROLES = THEME_ROLE_SCHEMA.length;

export interface ThemeAssetReference {
  entry: string;
  path: string;
}

/** Theme data exposed by a Runtime plugin. Values are validated as inert CSS tokens by PluginHost. */
export interface ThemeContribution {
  /** Stable ID within the contributing plugin. */
  id: string;
  label: string;
  appearance: 'light' | 'dark';
  variables: Record<string, string>;
  /** Opt in to exact accounting of all framework theme roles. Omitted for legacy partial themes. */
  coverage?: 'complete';
  /** Framework roles intentionally inherited from the selected light/dark base appearance. */
  inheritRoles?: readonly string[];
  background?: ThemeAssetReference;
  /** Plugin-local ID of the paired theme in the other appearance scheme. */
  pairedThemeId?: string;
  /** Optional host-rendered brand and welcome mark from this plugin's registered Web UI assets. */
  brandIcon?: ThemeAssetReference;
  /** Optional replacement for the built-in wordmark while this theme is active. */
  brandLabel?: string;
}

export type ThemeRoleCoverageInput = Pick<ThemeContribution, 'variables' | 'coverage' | 'inheritRoles' | 'background'>;

/**
 * Return contract errors for strict themes. Legacy themes without `coverage`
 * retain their existing sparse-override behavior.
 */
export function themeRoleCoverageErrors(theme: ThemeRoleCoverageInput): string[] {
  const errors: string[] = [];
  if (theme.coverage === undefined) {
    if (theme.inheritRoles !== undefined) errors.push('inheritRoles requires coverage: complete');
    return errors;
  }
  if (theme.coverage !== 'complete') return ['coverage must be complete when specified'];

  const known = new Set<string>(THEME_ROLE_SCHEMA);
  const variables =
    theme.variables && typeof theme.variables === 'object' && !Array.isArray(theme.variables)
      ? Object.keys(theme.variables).slice(0, MAX_THEME_VARIABLES)
      : [];
  const inherited = Array.isArray(theme.inheritRoles) ? theme.inheritRoles.slice(0, MAX_THEME_INHERIT_ROLES) : [];

  if (
    !theme.variables ||
    typeof theme.variables !== 'object' ||
    Array.isArray(theme.variables) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(theme.variables))
  ) {
    errors.push('variables must be a plain object');
  }
  if (theme.inheritRoles !== undefined && !Array.isArray(theme.inheritRoles)) {
    errors.push('inheritRoles must be an array');
  } else if (Array.isArray(theme.inheritRoles) && theme.inheritRoles.length > MAX_THEME_INHERIT_ROLES) {
    errors.push(`inheritRoles may contain at most ${MAX_THEME_INHERIT_ROLES} roles`);
  }
  if (
    theme.variables &&
    typeof theme.variables === 'object' &&
    Object.keys(theme.variables).length > MAX_THEME_VARIABLES
  ) {
    errors.push(`variables may contain at most ${MAX_THEME_VARIABLES} roles`);
  }

  for (const role of variables) {
    if (!known.has(role)) errors.push(`unknown theme role: ${role}`);
    if (role === '--pico-theme-background-image') {
      errors.push('theme background images must use the background asset field and inheritRoles');
    }
  }

  const seenInherited = new Set<string>();
  for (const role of inherited) {
    if (typeof role !== 'string' || !known.has(role)) {
      errors.push(`unknown inherited theme role: ${String(role)}`);
      continue;
    }
    if (seenInherited.has(role)) errors.push(`duplicate inherited theme role: ${role}`);
    seenInherited.add(role);
    if (Object.hasOwn(theme.variables ?? {}, role)) errors.push(`theme role is both overridden and inherited: ${role}`);
  }

  const covered = new Set(variables.filter((role) => role !== '--pico-theme-background-image'));
  for (const role of inherited) covered.add(role);
  for (const role of THEME_ROLE_SCHEMA) {
    if (!covered.has(role)) errors.push(`missing theme role coverage: ${role}`);
  }
  return errors;
}

/** Host-registered theme with its owner and globally namespaced ID. */
export interface RegisteredTheme extends ThemeContribution {
  pluginId: string;
  id: string;
}
