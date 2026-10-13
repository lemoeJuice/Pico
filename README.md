# Pico

Pico is a local-first agent harness built around durable Projects, Threads, Messages, Tool Executions, and replaceable Executors. The initial version includes a responsive web UI, an OpenAI-compatible streaming adapter, Host and Podman Container Executors, a small local plugin API, and a SQLite store.

## Run Pico

Requirements: Node.js 26 or newer and npm. Podman is needed for the default Container Executor. Set `PICO_CONTAINER_IMAGE` to use a compatible image from another registry; by default Pico uses `docker.io/library/node:22-bookworm-slim`. The image must provide Node.js and `/bin/sh`. When a Btrfs-backed Podman store cannot use kernel overlay, Pico uses `fuse-overlayfs` if available and otherwise falls back to a separate VFS store at `data/podman-vfs`. Set `PICO_PODMAN_OVERLAY_MOUNT_PROGRAM` for a helper outside `PATH` or `PICO_PODMAN_VFS_ROOT` to move the fallback store. VFS can use more disk and run image operations more slowly than overlay. A Host Thread can run without Podman.

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

### Connect a Remote Host Executor

The Runtime can connect to an Executor on another machine over an HTTP(S) endpoint. On the machine that owns the workspace, create a long token and start the Executor service:

```sh
export PICO_EXECUTOR_TOKEN="$(openssl rand -hex 32)"
PICO_EXECUTOR_HOST=0.0.0.0 \
PICO_EXECUTOR_WORKSPACE_ROOT="$HOME/Projects" \
npm run dev:executor
```

Keep the token for the Runtime connection. The service defaults to `127.0.0.1:4174`; set `PICO_EXECUTOR_PORT` to change the port. It accepts requests only for folders under `PICO_EXECUTOR_WORKSPACE_ROOT` and keeps execution receipts in `data/executor.sqlite`. For production, run `npm run build` and then `npm run start:executor` with the same environment. Use HTTPS when the connection crosses a network you do not fully trust.

In Pico, open **Model and Executor connections**, add the service URL and token, then choose **Remote Host** when starting a Thread. Set the workspace path as seen by that machine. Remote Host tool calls use the same approval policy as local Host calls. A Thread remains bound to its selected connection; create a new Thread to use another Executor.

Pico listens on `127.0.0.1:4173` by default. Configure `PICO_HOST` and `PICO_PORT` to change the listener, `PICO_DB_PATH` to change the SQLite file, and `PICO_PLUGIN_DIR` to load `.mjs` plugins from another directory. Model defaults can also be set with `PICO_MODEL_BASE_URL`, `PICO_MODEL_API_KEY`, and `PICO_MODEL`; the Settings page can override them.

### Access from another device

Pico refuses to listen beyond a loopback address unless `PICO_ACCESS_TOKEN` is set to a secret of at least 32 bytes. Generate one and bind Pico to your chosen interface:

```sh
export PICO_ACCESS_TOKEN="$(openssl rand -hex 32)"
PICO_HOST=0.0.0.0 npm run dev
```

The browser asks for the token once and receives a revocable, `HttpOnly`, `SameSite=Strict` session cookie that expires after 12 hours. API routes and the event WebSocket require that session; WebSocket upgrades also check the browser origin. Sign out from the top bar to revoke the current session. The token itself is not stored in browser storage. Use HTTPS when traffic crosses a network you do not fully trust. When TLS terminates at a trusted reverse proxy, set `PICO_TRUST_PROXY=1` so Pico can mark the session cookie `Secure`; only enable this when the direct peer is that proxy.

## Executors and permissions

- Each Thread stays bound to the Executor selected at creation. Create another Thread in the same Project to use a different Executor.
- Container Executor uses Podman and `node:22-bookworm-slim`. It mounts only the selected workspace at `/workspace`, runs as root inside the container, and does not mount the host home directory, SSH keys, or Podman socket. Each Thread gets its own persistent container.
- Remote Host Executor runs the same basic tools on a separately started Pico Executor service. The Runtime stores its token locally and does not return it through the API. Remote execution IDs are durably deduplicated on the Executor so retrying after a lost response does not start a second command.
- Host Executor runs shell commands with the host environment. File tools stay within the selected workspace. Host tool calls ask for approval by default; each approval can allow once or save an allow rule for that Tool in the current Thread. Container tool calls are allowed by default because they run in the isolated container. Permission can be changed per Thread.
- `read_file`, `search_files`, `apply_patch`, and `shell` are available to the model. Tool output and execution status are visible in the Thread.
- The Thread view loads the newest 100 canonical records first. Use **Load earlier history** to page backward; this only limits UI reads and never trims the stored history or changes model projection.
- Expand **Model input** below a committed assistant step or an uncommitted Model Step to inspect each prompt passed to the model adapter after projection and model plugins run. It is loaded on demand from the execution log; API credentials are not included and the view is not part of canonical conversation history.
- Use the **Project context** Thread action or `/project-context` to view context shared across that Project's Threads. Set it with `/project-context set` followed by text on the next line; use `/project-context clear` to remove it. Pico injects this explicitly maintained text into future Model Input projections and never summarizes or trims it automatically.
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
