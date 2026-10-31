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

The built-in `pico.light` and `pico.dark` themes use the same appearance roles.
The `dark-*.css` files override color roles without changing the light theme's
layout or typography. `AppearanceProvider` owns browser-local selection and
system-following; an early script in `index.html` applies the stored built-in
appearance before the application renders. The document root carries the active
theme ID and native color scheme, so authentication and body-mounted portals
inherit the same appearance as the main interface.

Runtime plugins can register themes as appearance data, as documented in
`plugins/README.md`. The host validates contributions and applies known
`--pico-*` appearance roles to its document; plugins do not style host DOM or
provide arbitrary CSS. The declared light or dark base supplies any roles a
theme does not override. The selected plugin theme is kept in browser storage
even while its plugin is unavailable, with the light appearance as a temporary
fallback. Theme changes update native controls and body-mounted portals too.

Optional backgrounds are plugin-owned Web UI assets. The host constructs the
URL and the server serves only paths in the package's theme asset manifest;
the release publisher snapshots and verifies those assets with the plugin UI.
`--pico-material-backdrop` controls the optional glass blur of framework-owned
surfaces. Its default is `none`, so the built-in themes retain their appearance.
