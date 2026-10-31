/** Upper bound shared by the Runtime validator and the WebUI. */
export const MAX_THEME_VARIABLES = 256;

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
  background?: ThemeAssetReference;
  /** Plugin-local ID of the paired theme in the other appearance scheme. */
  pairedThemeId?: string;
  /** Optional host-rendered brand and welcome mark from this plugin's registered Web UI assets. */
  brandIcon?: ThemeAssetReference;
  /** Optional replacement for the built-in wordmark while this theme is active. */
  brandLabel?: string;
}

/** Host-registered theme with its owner and globally namespaced ID. */
export interface RegisteredTheme extends ThemeContribution {
  pluginId: string;
  id: string;
}
