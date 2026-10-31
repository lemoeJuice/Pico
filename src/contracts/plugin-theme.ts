/** Upper bound shared by the Runtime validator and the WebUI. */
export const MAX_THEME_VARIABLES = 128;

/** Theme data exposed by a Runtime plugin. Values are validated as inert CSS tokens by PluginHost. */
export interface ThemeContribution {
  /** Stable ID within the contributing plugin. */
  id: string;
  label: string;
  appearance: 'light' | 'dark';
  variables: Record<string, string>;
  background?: { entry: string; path: string };
}

/** Host-registered theme with its owner and globally namespaced ID. */
export interface RegisteredTheme extends ThemeContribution {
  pluginId: string;
  id: string;
}
