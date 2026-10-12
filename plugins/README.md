# Local plugins

Pico loads `.mjs` modules from this directory when the Runtime starts. Each module exports a default plugin object with `id`, `name`, `version`, and `activate(context)`.

The example plugin contributes an agent tool, the `/notes` command, a Thread toolbar action, private persistent state, and append-only canonical records. Local plugins execute as trusted code inside the Pico Runtime.

Stable contribution surfaces are `tools`, the `step` / `projection` / `model` / `toolBatch` / `toolInvocation` pipelines, `commands`, semantic `ui` slots, plugin `state`, and the append-only `canonical` logger. Pipeline registration order is deterministic by plugin load order and registration order.

The `toolBatch` stage exposes the committed calls and an `execute(call)` function. A scheduler can wrap `execute` or reorder calls while delegating each unchanged call; the default stage runs them concurrently. Preserve each call's ID, name, and arguments. Pico checks the durable Execution records after the stage and will not start the next Model Step until the whole batch is settled.

The `step` stage wraps one full agent-loop iteration: its Model Step and any Tool Batch produced by that Model Step run before the interceptor returns at the next safe boundary. A short-circuit that leaves durable work unprocessed pauses the Thread so the Runtime does not spin without progress.
