# Local plugins

Pico loads `.mjs` modules from this directory when the Runtime starts. Each module exports a default plugin object with `id`, `name`, `version`, and `activate(context)`.

The example plugin contributes an agent tool, the `/notes` command, a Thread toolbar action, private persistent state, and append-only canonical records. Local plugins execute as trusted code inside the Pico Runtime.

Stable contribution surfaces are `tools`, the `step` / `projection` / `model` / `toolBatch` / `toolInvocation` pipelines, `commands`, semantic `ui` slots, plugin `state`, and the append-only `canonical` logger. Pipeline registration order is deterministic by plugin load order and registration order.

The first-party ChatGPT account provider is installed from `pico.chatgpt-plan.mjs` like another Runtime plugin. It contributes an OpenAI-compatible provider ID, a `model` pipeline interceptor, authenticated plugin API routes, plugin-local OAuth/preferences state, a slash command, a Settings page, and a `composer.model` semantic UI contribution. Its React entry is bundled with the Pico Web UI so the Runtime plugin and the browser UI can use the same stable entry/component identifiers without exposing the DOM or component tree as an extension API.

Runtime plugins may register HTTP routes and Settings pages using stable IDs. A Settings page or component requires a matching Web UI entry bundled with the Pico client; the `.mjs` Runtime module cannot inject arbitrary script or markup into the browser. The generic client reports a clear unavailable-entry message when a registered page has no bundled UI implementation.

The UI slots render in distinct places: `thread.toolbar` sits in the selected Thread header, `composer.action` sits next to Send, and `sidebar.panel` appears in the scrollable navigation area. Contributions with a `command` invoke that registered slash command from the selected Thread. A sidebar panel without a command can provide label and description only; toolbar and composer actions without a command appear disabled.

Slash command handlers receive whitespace-split `args` for simple options and `context.rawArgs` for the original text after the command name, preserving spaces and newlines for commands that accept prose. The built-in `/project-context` command uses plugin-local state keyed by Project ID and a projection interceptor to share explicitly maintained context across a Project's Threads. `/project-context set` followed by a new line and text replaces it; `/project-context clear` removes it. This context is never harvested from canonical history or shortened automatically.

The `toolBatch` stage exposes the committed calls and an `execute(call)` function. A scheduler can wrap `execute` or reorder calls while delegating each unchanged call; the default stage runs them concurrently. Preserve each call's ID, name, and arguments. Pico checks the durable Execution records after the stage and will not start the next Model Step until the whole batch is settled.

The `step` stage wraps one full agent-loop iteration: its Model Step and any Tool Batch produced by that Model Step run before the interceptor returns at the next safe boundary. A short-circuit that leaves durable work unprocessed pauses the Thread so the Runtime does not spin without progress.

Slash commands stay explicit actions and do not become user Messages. Pico records an append-only receipt before running a command handler; retrying the same request ID will not invoke the handler again. If a handler throws or its outcome is uncertain, inspect the Thread or plugin state before submitting it again with a new ID.
