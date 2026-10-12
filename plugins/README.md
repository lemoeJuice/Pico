# Local plugins

Pico loads `.mjs` modules from this directory when the Runtime starts. Each module exports a default plugin object with `id`, `name`, `version`, and `activate(context)`.

The example plugin contributes an agent tool, the `/notes` command, a Thread toolbar action, private persistent state, and append-only canonical records. Local plugins execute as trusted code inside the Pico Runtime.

Stable contribution surfaces are `tools`, the `step` / `projection` / `model` / `toolBatch` / `toolInvocation` pipelines, `commands`, semantic `ui` slots, plugin `state`, and the append-only `canonical` logger. Pipeline registration order is deterministic by plugin load order and registration order.

The UI slots render in distinct places: `thread.toolbar` sits in the selected Thread header, `composer.action` sits next to Send, and `sidebar.panel` appears in the scrollable navigation area. Contributions with a `command` invoke that registered slash command from the selected Thread. A sidebar panel without a command can provide label and description only; toolbar and composer actions without a command appear disabled.

The `toolBatch` stage exposes the committed calls and an `execute(call)` function. A scheduler can wrap `execute` or reorder calls while delegating each unchanged call; the default stage runs them concurrently. Preserve each call's ID, name, and arguments. Pico checks the durable Execution records after the stage and will not start the next Model Step until the whole batch is settled.

The `step` stage wraps one full agent-loop iteration: its Model Step and any Tool Batch produced by that Model Step run before the interceptor returns at the next safe boundary. A short-circuit that leaves durable work unprocessed pauses the Thread so the Runtime does not spin without progress.

Slash commands stay explicit actions and do not become user Messages. Pico records an append-only receipt before running a command handler; retrying the same request ID will not invoke the handler again. If a handler throws or its outcome is uncertain, inspect the Thread or plugin state before submitting it again with a new ID.
