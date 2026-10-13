# Local plugins

Pico loads `.mjs` Runtime entries from this directory when the Runtime starts. Each entry exports a default plugin object with `id`, `name`, `version`, and `activate(context)`. Runtime modules are loaded independently from Pico's compiled server.

A plugin package can contain several contributions together. The ChatGPT example is installed as `pico.chatgpt-plan.mjs` plus the `pico.chatgpt-plan/` directory. The Runtime entry dynamically imports its independently built `runtime.mjs`; `webui/index.html` and its `webui/build/` assets provide the matching browser UI. Build the ChatGPT package with `npm run plugins:build:chatgpt`. Pico's normal `npm run build` does not compile plugin code into the Runtime or main Web UI. The Runtime discovers packages when it starts, so installing or updating a package requires restarting the Runtime, not rebuilding Pico.

The Runtime serves a plugin's registered UI entry from its own package directory. Pages and semantic UI components load in a sandboxed iframe. The host bridges a small capability API over a `MessagePort`: calls to that plugin's authenticated API routes, non-secret model selection fields, opening the plugin's own registered page, notices/errors, and frame sizing. The plugin supplies its own self-contained Web UI bundle and may choose its own UI framework. It does not receive the host DOM or React component tree. Plugin UI assets are public static files; credentials and mutable plugin state remain behind authenticated Runtime APIs.

Third-party package layout:

```text
plugins/
  my.plugin.mjs
  my.plugin/
    webui/
      index.html
      ...self-contained assets...
```

The Runtime entry ID and directory name must match. Register each page or UI component with an `entry` ID; the corresponding files are served from `my.plugin/webui/`. `index.html` can select the requested semantic view from `viewType` and `viewId` query parameters. The host initializes the iframe with protocol version 1 and transfers one `MessagePort`; do not use cross-frame DOM access or depend on Pico's UI framework. The stable host message shapes and TypeScript authoring types are in `src/plugins/ui-protocol.ts` for first-party development.

The init message is `{ type: "pico:plugin-ui:init", protocolVersion: 1, pluginId, entry, viewType, viewId, settings }`. UI requests use `{ type: "pico:plugin-ui:request", id, action, ... }` and receive a matching `pico:plugin-ui:response`. Supported actions are `api` (same-plugin `/api/plugins/<id>/...` path plus method/body), `update-model-settings` (`baseUrl`, `model`, `provider`, `temperature` only), `open-page` (one of the plugin's registered pages), `error`, and `notice`. The host may send `pico:plugin-ui:settings` updates; the entry may send `pico:plugin-ui:resize` with a content height. Requests outside these capabilities are ignored or rejected.

The example plugin contributes an agent tool, the `/notes` command, a Thread toolbar action, private persistent state, and append-only canonical records. Local plugins execute as trusted code inside the Pico Runtime. Browser UI code runs in the iframe sandbox and only receives the bridged capabilities above.

Stable contribution surfaces are `tools`, the `step` / `projection` / `model` / `toolBatch` / `toolInvocation` pipelines, `commands`, semantic `ui` slots, plugin `state`, and the append-only `canonical` logger. Pipeline registration order is deterministic by plugin load order and registration order. The ChatGPT example contributes an OpenAI-compatible provider ID, a `model` pipeline interceptor, authenticated plugin API routes, plugin-local OAuth/preferences state, a slash command, a Settings page, and a `composer.model` semantic UI contribution.

Runtime plugins may register HTTP routes and Settings pages using stable IDs. The `.mjs` Runtime module cannot inject arbitrary script or markup into the host Web UI; its separately packaged UI is mounted only in the registered semantic location.

The UI slots render in distinct places: `thread.toolbar` sits in the selected Thread header, `composer.action` sits next to Send, and `sidebar.panel` appears in the scrollable navigation area. Contributions with a `command` invoke that registered slash command from the selected Thread. A sidebar panel without a command can provide label and description only; toolbar and composer actions without a command appear disabled.

Slash command handlers receive whitespace-split `args` for simple options and `context.rawArgs` for the original text after the command name, preserving spaces and newlines for commands that accept prose. The built-in `/project-context` command uses plugin-local state keyed by Project ID and a projection interceptor to share explicitly maintained context across a Project's Threads. `/project-context set` followed by a new line and text replaces it; `/project-context clear` removes it. This context is never harvested from canonical history or shortened automatically.

The `toolBatch` stage exposes the committed calls and an `execute(call)` function. A scheduler can wrap `execute` or reorder calls while delegating each unchanged call; the default stage runs them concurrently. Preserve each call's ID, name, and arguments. Pico checks the durable Execution records after the stage and will not start the next Model Step until the whole batch is settled.

The `step` stage wraps one full agent-loop iteration: its Model Step and any Tool Batch produced by that Model Step run before the interceptor returns at the next safe boundary. A short-circuit that leaves durable work unprocessed pauses the Thread so the Runtime does not spin without progress.

Slash commands stay explicit actions and do not become user Messages. Pico records an append-only receipt before running a command handler; retrying the same request ID will not invoke the handler again. If a handler throws or its outcome is uncertain, inspect the Thread or plugin state before submitting it again with a new ID.
