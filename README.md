# Pico

Pico is a local-first agent harness built around durable Projects, Threads, Messages, Tool Executions, and replaceable Executors. The initial version includes a responsive web UI, an OpenAI-compatible streaming adapter, Host and Podman Container Executors, a small local plugin API, and a SQLite store.

## Run Pico

Requirements: Node.js 26 or newer and npm. Podman is needed for the default Container Executor. A Host Thread can run without Podman.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:4173>. Create a Project by choosing a workspace folder, then create a Thread and select its Executor. New Threads default to Container; choose Host when you want tools to run directly on the machine running Pico.

Open **Model settings** to enter an OpenAI-compatible base URL, model name, and optional API key. For example, use `https://api.openai.com/v1` as the base URL. Pico appends `/chat/completions`. The key is stored in the local SQLite database and is never returned by the settings API.

To serve the built UI:

```sh
npm run build
NODE_ENV=production npm start
```

The build compiles the Runtime server separately from the static web client, so production startup does not need the development TypeScript or Vite server.

Pico listens on `127.0.0.1:4173` by default. Configure `PICO_HOST` and `PICO_PORT` to change the listener, `PICO_DB_PATH` to change the SQLite file, and `PICO_PLUGIN_DIR` to load `.mjs` plugins from another directory. Model defaults can also be set with `PICO_MODEL_BASE_URL`, `PICO_MODEL_API_KEY`, and `PICO_MODEL`; the Settings page can override them.

## Executors and permissions

- Each Thread stays bound to the Executor selected at creation. Create another Thread in the same Project to use a different Executor.
- Container Executor uses Podman and `node:22-bookworm-slim`. It mounts only the selected workspace at `/workspace`, runs as root inside the container, and does not mount the host home directory, SSH keys, or Podman socket. Each Thread gets its own persistent container.
- Host Executor runs shell commands with the host environment. File tools stay within the selected workspace. Host tool calls ask for approval by default; Container tool calls are allowed by default because they run in the isolated container. Permission can be changed per Thread.
- `read_file`, `search_files`, `apply_patch`, and `shell` are available to the model. Tool output and execution status are visible in the Thread.
- Pause lets current Model and Tool executions settle and prevents the next Model Step. Interrupt explicitly tries to stop active work. Continue restarts a paused Thread from its durable records.

The database defaults to `data/pico.sqlite`; the database file is created with owner-only permissions. Projects, Messages, complete Model Steps, Tool results, execution logs, approvals, settings, and plugin-local state are persisted there.

## Plugins

Place an ES module ending in `.mjs` in `plugins/` (or `PICO_PLUGIN_DIR`). A default export must provide `id`, `name`, `version`, and `activate(context)`. Plugins may contribute tools, interceptors for the `step`, `projection`, `model`, `toolBatch`, and `toolInvocation` stages, slash commands, UI actions in semantic slots, plugin-local persistent state, and namespaced append-only canonical records. See [plugins/README.md](plugins/README.md) and the runnable [example plugin](plugins/example-plugin.mjs).

Slash commands are discoverable by typing `/` in the composer. UI contributions attach to documented semantic slots and do not depend on private component structure.

## Development

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

The invariant tests exercise Message and Execution deduplication, concurrent Tool Batches, pause/interrupt behavior, Executor reconnection and restart recovery, incomplete streaming, child Thread messaging, plugin surfaces, workspace boundaries, and append-only canonical history.
