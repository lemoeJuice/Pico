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

These files establish a light appearance baseline; they do not yet implement
theme selection, a dark theme, or plugin theme registration. Any future plugin
theme contract must describe stable semantic roles rather than requiring a
plugin to depend on internal selectors or DOM layout.
