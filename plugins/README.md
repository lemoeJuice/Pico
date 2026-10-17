# Local plugins

Pico loads `.mjs` Runtime entries from this directory when the Runtime starts. Each entry exports a default plugin object with `id`, `name`, `version`, and a Runtime `activate(context)` contribution. Executor-only manifests may omit the Runtime contribution. Runtime modules are loaded independently from Pico's compiled server.

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

For `composer.model`, the init message also includes `uiSlot: "composer.model"` and `controlHeightPx`. This semantic UI contract fixes the contribution frame to that height and provides the same value as `--pico-composer-control-height` on the plugin root. Render the row at that height and apply the token to its controls; do not infer sizing from Pico's DOM or component styles. The host applies the same token to its Idle and Send controls, so the plugin controls stay aligned across independently bundled UI code.

The example plugin contributes an agent tool, the `/notes` command, a Thread toolbar action, private persistent state, and append-only canonical records. Local plugins execute as trusted code inside the Pico Runtime. Browser UI code runs in the iframe sandbox and only receives the bridged capabilities above.

Stable contribution surfaces are `tools`, the `step` / `projection` / `model` / `toolBatch` / `toolInvocation` pipelines, `commands`, semantic `ui` slots, plugin `state`, and the append-only `canonical` logger. Pipeline registration order is deterministic by plugin load order and registration order. The ChatGPT example contributes an OpenAI-compatible provider ID, a `model` pipeline interceptor, authenticated plugin API routes, plugin-local OAuth/preferences state, a slash command, a Settings page, and a `composer.model` semantic UI contribution.

Runtime plugins may register HTTP routes and Settings pages using stable IDs. The `.mjs` Runtime module cannot inject arbitrary script or markup into the host Web UI; its separately packaged UI is mounted only in the registered semantic location.

The UI slots render in distinct places: `thread.toolbar` sits in the selected Thread action row beside Tools, `composer.action` sits next to Send, and `sidebar.panel` appears in the scrollable navigation area. A component contribution in `thread.toolbar` can set `supportsPopover: true` to make its button open the component in a popover. Contributions with a `command` invoke that registered slash command from the selected Thread. A sidebar panel without a command can provide label and description only; toolbar and composer actions without a command appear disabled.

Slash command handlers receive whitespace-split `args` for simple options and `context.rawArgs` for the original text after the command name, preserving spaces and newlines for commands that accept prose. The built-in `/project-context` command uses plugin-local state keyed by Project ID and a projection interceptor to share explicitly maintained context across a Project's Threads. `/project-context set` followed by a new line and text replaces it; `/project-context clear` removes it. This context is never harvested from canonical history or shortened automatically.

The `toolBatch` stage exposes the committed calls and an `execute(call)` function. A scheduler can wrap `execute` or reorder calls while delegating each unchanged call; the default stage runs them concurrently. Preserve each call's ID, name, and arguments. Pico checks the durable Execution records after the stage and will not start the next Model Step until the whole batch is settled.

The `step` stage wraps one full agent-loop iteration: its Model Step and any Tool Batch produced by that Model Step run before the interceptor returns at the next safe boundary. A short-circuit that leaves durable work unprocessed pauses the Thread so the Runtime does not spin without progress.

Slash commands stay explicit actions and do not become user Messages. Pico records an append-only receipt before running a command handler; retrying the same request ID will not invoke the handler again. If a handler throws or its outcome is uncertain, inspect the Thread or plugin state before submitting it again with a new ID.

## Workflow ownership and configuration

The default Runtime workflows are `pico.workspace`, `pico.project-context`, `pico.commands`, `pico.collaboration`, and `pico.permissions`. Set `PICO_DISABLED_PLUGINS` to a comma-separated list of default plugin IDs, or use `RuntimeOptions.disabledBuiltinPlugins`, to disable a default implementation before loading a replacement. Selection happens at startup; loaded plugins and pipeline registration order are inspectable through `/api/plugins`. Disabling permissions removes its rules, approval interaction, and interceptors from the active workflow. It does not change Executor isolation.

`context.threads` exposes Thread lookup, listing, bound Executor lookup, available tool discovery, creation, and same-Project message delivery. The collaboration plugin owns the agent-facing spawn/message tools and guidance. Message senders provide stable IDs so a retry does not create a second message. Child Threads retain ordinary Thread and Message semantics.

`context.executions` provides lookup, explicit failure, and subscriptions to execution changes. The `toolInvocation` input provides an abort signal, tool source, `fail(reason, result?)`, and `invoke()`. Permission policies and approval state live in `pico.permissions` plugin state. Its static API routes are `GET /api/plugins/pico.permissions/threads?threadId=...`, `PUT .../rules`, and `POST .../approvals`; its toolbar and pending decision actions come from its independently loaded Web UI package. Existing core approval tables and permission settings are migrated once to plugin state, preserving canonical audit records.

## Canonical facts and state

`canonical.list(threadId)` reads all committed fact kinds. Prefer `canonical.read(threadId, { afterSeq, limit })` for bounded forward pagination (maximum 1,000 records), and save the last processed sequence in plugin state when needed. `canonical.subscribe(threadId, listener)` delivers committed records while the Runtime is alive. It does not replay history or provide a durable queue; reconnecting consumers resume with `read`. Notifications are emitted after the outer transaction commits, rolled-back writes emit nothing, and observer errors cannot roll back committed facts. Plugin-owned subscriptions are disposed on activation failure or shutdown.

`canonical.append` remains restricted to the owning plugin namespace. Existing records cannot be edited. `state.transaction(operation)` groups state and canonical writes atomically, while `state.subscribe(listener)` observes committed changes to the owning plugin's state. State writes with identical serialized values do not emit another update.

## Executor contributions

One manifest can provide optional `activate(context)` for Runtime contributions and optional `activateExecutor(context)` for environment tools. At least one entrypoint is required. Install self-contained Executor `.mjs` bundles under `executor-plugins/` or `PICO_EXECUTOR_PLUGIN_DIR`; Runtime-only bundles are ignored by the Executor loader and Executor-only bundles are ignored by the Runtime loader. Executor activation receives `tools.register(definition, execute)`. Tool execution receives the environment's `workspacePath`, stable `executionId`, and abort `signal`.

Host and Remote Executors load their own bundles. Container Executor copies bundles to `/opt/pico/executor-plugins` and discovers the tool schemas actually registered inside the container. Bundle dependencies must be included in the self-contained file. The default `pico.executor-tools` package registers file, search, patch, and shell tools through the same registry. Failed plugin registrations do not expose a partial toolset.

Remote `/api/info` uses protocol version 1 and returns validated tool schemas; no particular tool names are mandatory. Model tool surfaces combine the bound Executor's schemas with Runtime tools. A name registered by both sources is rejected with a diagnostic instead of silently routing to one implementation. Chat Threads expose Runtime plugin tools without attaching an external Executor toolset.

## UI components and commands

Components can contribute to `thread.toolbar`, `composer.action`, `sidebar.panel`, `composer.model`, and `tool.result`. Only `thread.toolbar` components can set `supportsPopover: true`; the host renders their control in the Thread action row and opens the component in a popover when clicked. The host always owns the Tool Card shell and lifecycle. A `tool.result` component can add a small result-area action or detail; it cannot replace the card. These components may specify `toolNames`, and the host mounts them only for matching calls while the execution is pending. Their context is limited to the Thread ID and an execution ID/status pair; it does not expose the Thread record, Tool arguments, or result payload. `pico:plugin-ui:context` updates that context; `pico:plugin-ui:event` delivers events for the owning plugin. The typed client exposes `subscribeContext` and `subscribeEvents`.

First-party Web UI pages load `/pico-plugin-ui.css` for common tokens and component classes. Shared tokens cover background, panel, text, muted text, borders, accent, success, error, warning, information, focus, and controls. Use `.pico-ui-panel` and `.pico-ui-section` for surfaces and grouped content; `.pico-ui-card`, `.pico-ui-list-item`, and `.pico-ui-metric-card` for cards and rows; `.pico-ui-heading`, `.pico-ui-status[data-status]`, and `.pico-ui-tag` for labels; `.pico-ui-actions`, `.pico-ui-button` (`--primary` or `--danger`), and `.pico-ui-control` for interaction; and `.pico-ui-empty`, `.pico-ui-error`, `.pico-ui-preview`, and `.pico-ui-disclosure` for feedback and details. Keep plugin CSS for domain-specific layout and behavior. The host’s `ToolCard` uses the same card, status, and preview classes; plugins cannot replace its shell. Goal, Todo, Project Context, Global Memory, Collaboration, Rolling Context, Usage, ChatGPT Plan, and Permissions pages all use the shared sheet.

A `command` request contains the complete slash command text. The host injects the owning plugin and current Thread, and the server verifies command ownership before executing it. The command uses a stable request ID and the ordinary command receipt path. A plugin frame cannot invoke another plugin's command, open another plugin's page, call another plugin's API, or access the host DOM.
