# Local plugins

Pico loads `.mjs` modules from this directory when the Runtime starts. Each module exports a default plugin object with `id`, `name`, `version`, and `activate(context)`.

The example plugin contributes an agent tool, the `/notes` command, a Thread toolbar action, private persistent state, and append-only canonical records. Local plugins execute as trusted code inside the Pico Runtime.

Stable contribution surfaces are `tools`, the `step` / `projection` / `model` / `toolBatch` / `toolInvocation` pipelines, `commands`, semantic `ui` slots, plugin `state`, and the append-only `canonical` logger. Pipeline registration order is deterministic by plugin load order and registration order.
