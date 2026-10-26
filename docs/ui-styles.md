# WebUI stylesheet layout

The first extraction stage moves existing CSS into files grouped by style type
and UI location. It does not consolidate styles, introduce tokens, or change
selectors, declarations, media queries, or their order.

## Entry points

| Entry | Existing caller | Extracted rules |
| --- | --- | --- |
| `src/web/styles.css` | `src/web/main.tsx` | `src/web/styles/` |
| `src/web/tool-card.css` | `src/web/tool-card.tsx` | `src/web/styles/regions/tool-card/` |
| `src/web/mcp-settings.css` | `src/web/App.tsx` | `src/web/styles/regions/mcp-settings/` |
| `public/pico-plugin-ui.css` | `index.html` and consumers of the public stylesheet URL | `public/pico-plugin-ui/` |

Each entry contains ordered `@import` rules. Its original loading location and
public URL stay the same. The imported files are contiguous slices of the former
entry; concatenating their bytes in import order reconstructs the original CSS.

`pico-plugin-ui.css` is also loaded in the host document. ToolCard uses its
`pico-ui-*` classes together with the framework's ToolCard rules. Visible plugin
trees use `plugin-ui-*` rules in the host document; the plugin bridge JavaScript
and its hidden logic iframe are outside this extraction.

## Directory groups

| Group | Contents |
| --- | --- |
| `styles/base/` | Document defaults, existing variables, global interaction rules, and animations |
| `styles/shared/` | Existing host buttons, plugin layouts and surfaces, plugin buttons and status labels, fields, switches, ranges, selectors, text inputs, tables, disclosures, modal and form rules |
| `styles/regions/` | Shell and sidebar, authentication, topbar and notices, toolbar entries and panels, timeline, settings, composer, welcome, and dedicated dialog content |
| `styles/content/` | Markdown content presentation |
| `styles/responsive.css` | The existing late responsive and reduced-motion rules, in their original position |
| `public/pico-plugin-ui/` | Public base, surfaces, status labels, actions and controls, feedback and content rules |

## Locating a style

| UI or style type | Files below `src/web/styles/` |
| --- | --- |
| Sidebar, project/Thread rows, sidebar counts and navigation | `regions/shell-sidebar.css` |
| Topbar, Executor pill, connection indicators, toolbar banners and diagnostics | `regions/topbar-notices.css` |
| Toolbar layout, entry controls, counts, popovers and Tools panel | `regions/toolbar.css`, `regions/toolbar-controls.css`, `regions/toolbar-panels.css` |
| Framework action buttons | `shared/buttons.css` |
| Plugin groups, card surfaces, actions and status capsules | `shared/plugin-layouts.css`, `shared/plugin-surfaces.css`, `shared/plugin-buttons.css`, `shared/plugin-status.css` |
| Plugin fields, checkbox labels, Switch, range and Select | `shared/plugin-fields.css`, `shared/plugin-switch.css`, `shared/plugin-range.css`, `shared/plugin-select.css` |
| Plugin text/date/multiline inputs, lists, tables and disclosures | `shared/plugin-inputs.css`, `shared/plugin-data-disclosure.css` |
| Settings navigation, management lists and settings-specific status capsules | `regions/settings.css` |
| Composer shell, state controls, send button, commands and status footer | `regions/composer-layout.css`, `regions/composer.css`, `regions/composer-integration.css` |
| Messages, attempts, conversation details, context events and reasoning | `regions/conversation.css`, `regions/conversation-events.css`, `regions/reasoning.css` |
| ToolCard headings, controls, status and result layouts | `regions/tool-card-heading.css`, `regions/tool-card/` |
| Modal/form base and dedicated Project, Thread, history and remote-executor content | `shared/modal-form.css`, `regions/dialog-content.css` |
| MCP settings, editor, confirmation and responsive rules | `regions/mcp-settings/` |
| Authentication, welcome, and Markdown typography | `regions/auth.css`, `regions/welcome.css`, `content/markdown.css` |

Text styles and state capsules remain beside the component or reusable style that
owns them. Similar button, input, card, disclosure and capsule definitions remain
separate, including their current differences in padding, typography, borders,
backgrounds and state treatments. Toolbar counts remain part of toolbar entries.

## Cascade order

The entry order is intentional. Do not alphabetize imports or gather all rules
for a selector into one earlier file as part of this extraction. In particular:

- Responsive overrides retain their original position after the initial region
  rules and before the late conversation/content integrations.
- `conversation-events.css`, `composer-integration.css`, and
  `tool-card-heading.css` retain the original late overrides.
- ToolCard and MCP keep their existing component import points.
- The public stylesheet keeps its existing HTML link and relative import URLs.

Shared selectors may still appear in several files. Deciding which definitions
to preserve or consolidate belongs to the next stage, after acceptance of this
source-preserving extraction.
