# WebUI appearance roles

The built-in light appearance is the baseline for Pico's theme work. The files
in `src/web/styles/themes/*-light.css` define the current colors and typography
without requiring components or plugins to choose their own palette. They are
loaded by `src/web/styles.css` before component and region rules.

- `base-light.css` owns shared page, text, accent, border, font and focus roles.
  The earlier `--ink`, `--paper` and related names in `base/document.css` are
  aliases to these roles so that existing host rules continue to resolve.
- `controls-light.css` and `controls-typography-light.css` define control and
  form appearances. Shared switches and popover surfaces use these roles.
- `shell-light.css`, `composer-light.css`, `conversation-light.css`,
  `settings-light.css`, and `responsive-light.css` keep region-specific roles
  separate where the existing light appearance differs.
- `content-light.css` and `content-typography-light.css` own ToolCard, MCP and
  Markdown appearances. Their component styles retain their existing entry
  points and loading order.

Distinct roles can have the same initial value. Do not merge them solely because
their current light colors or font sizes match: their use, states and contrast
may differ in another theme. Likewise, preserve existing layout, control sizing,
component state and information hierarchy when applying appearance values.

The public `pico-plugin-ui.css` stylesheet can be loaded independently. Its
`--pico-ui-*` aliases fall back to the original light values if the host theme
roles are absent. In Pico's host document, visible plugin nodes are rendered by
the framework and inherit the same roles; the hidden plugin logic iframe does
not style those host-rendered nodes.

The built-in `pico.light`, `pico.dark`, and `pico.dark-legacy` themes use the same appearance roles. Dark Legacy preserves the previous green-tinted dark palette, while retaining the updated Pico icon.
The `dark-*.css` files override color roles without changing the light theme's
layout or typography. `AppearanceProvider` owns browser-local selection and
system-following; an early script in `index.html` applies the stored built-in
appearance before the application renders. The document root carries the active
theme ID and native color scheme, so authentication and body-mounted portals
inherit the same appearance as the main interface.

Runtime plugins can register themes as appearance data, as documented in
`plugins/README.md`. The host validates contributions and applies known
`--pico-*` appearance roles to its document; plugins do not style host DOM or
provide arbitrary CSS. Complete themes enumerate all roles as overrides or
explicit inheritance; legacy partial themes inherit unspecified roles from the
light or dark base. The selected plugin theme is kept in browser storage
even while its plugin is unavailable, with the light appearance as a temporary
fallback. Theme changes update native controls and body-mounted portals too.

Optional backgrounds are plugin-owned Web UI assets. The host constructs the
URL and the server serves only paths in the package's theme asset manifest;
the release publisher snapshots and verifies those assets with the plugin UI.
`--pico-material-backdrop` controls the optional glass blur of framework-owned
surfaces. Its default is `none`, so the built-in themes retain their appearance.

In General settings, each theme defaults to no background and can use its own
background or a locally selected raster image behind the main panel. Each
theme's selection and blur settings are remembered independently. The image is
stored in that browser's IndexedDB and is never uploaded to the Runtime. The
two image choices remember separate blur amounts: theme backgrounds default to
0 px and personal images to 4 px; both can be adjusted from 0 to 20 px. Personal
images also have an optional per-theme lightening or dimming overlay, depending
on the theme's appearance. Its default is 0%, preserving the original tint.

An optional brand icon and label replace the sidebar mark and name only while
that theme is active; the host still owns the controls and their behavior. A
theme can name an opposite-scheme counterpart from the same plugin. The sidebar
toggle prefers this counterpart, otherwise it restores the latest available
explicit choice for the target scheme, falling back to the built-in theme.
