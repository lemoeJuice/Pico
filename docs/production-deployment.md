# Pico production Runtime deployment

This page records the production deployment flow used for Pico and the limits of running deployment commands from the Codex sandbox.

## Choose and run a deployment

Run commands from the Pico project root on the deployment host as the Runtime owner. Scope is always selected explicitly by the operator or agent; the plan and deployment script inspect changes and report risks, but never choose, widen, or switch the deployment scope automatically.

```sh
# Inspect source changes against the deployed baseline without selecting a scope
npm run deploy:plan

# Preview a selected scope and its detected changes
npm run deploy:plan -- --web

# Explicit deployment choices
npm run deploy -- --full
npm run deploy -- --web
npm run deploy -- --plugin-ui=pico.todo
npm run deploy -- --plugin-ui=pico.todo --plugin-ui=pico.chatgpt-plan --web
npm run deploy -- --all-plugin-uis --web

# Checks only: type checking and the complete test suite
npm run deploy -- --checks
```

`npm run deploy:plan` compares current source contents with the last verified deployment, including uncommitted and untracked source files, and reports the differences. It does not select or recommend an executable deployment scope. Add an explicit scope option to preview what that selection covers and what the checks detect, for example `npm run deploy:plan -- --web`.

`--full` selects a complete deployment. `--web` selects only the main WebUI. Repeat `--plugin-ui=<plugin-id>` to select individual plugin UIs; combine it with `--web` to deploy both selections. `--all-plugin-uis` explicitly selects every plugin UI and can also be combined with `--web`. `--checks` performs type checking and the complete test suite only; it does not need or modify an online deployment baseline. A first deployment without a trusted baseline must use `--full` to establish one.

For a deployment, the script reports source paths and detected changes that fall outside the selected scope, as well as unknown paths, and blocks execution while those warnings are unreviewed. The operator or agent must inspect them and may add `--accept-warnings` to continue with the originally selected scope. That option acknowledges reviewed scope warnings only: the script must never widen or switch the scope, and `--accept-warnings` cannot bypass technical validation such as Runtime identity, artifact and baseline integrity, credentials, health, or resource checks. Checks-only runs do not need warning acceptance. Documentation-only changes need no release and are not included in the release-source comparison. Changes that introduce a new API requirement must include and explicitly deploy the corresponding Runtime change.

Subsequent releases retain separate source baselines for Runtime, the main WebUI, and each plugin UI. An invalid or missing baseline requires a complete deployment. Before a WebUI-only or plugin-UI release, the script verifies the Runtime PID and start time, Runtime artifact hashes and previously published asset hashes against the baseline; if the Runtime has been restarted or artifacts were replaced outside this process, explicitly choose `npm run deploy -- --full` to re-establish the baseline. The manifest is local operational state, ignored by Git, and does not store credentials.

The script takes a project-local deployment lock and copies the working source into an isolated temporary snapshot. When the existing installed dependency inventory matches the snapshot lock, it copies the dependency tree and checks it with `npm ls`; otherwise it uses `npm ci --prefer-offline` in the snapshot. Installation respects the host's npm configuration, and its package cache or network must supply the lockfile's dependencies. It builds and runs checks in the snapshot while tasks continue. `--checks` runs type checking and the complete test suite. A deployment runs the checks applicable to the explicitly selected targets. A frontend release publishes versioned assets under `dist/client/releases/` and `dist/plugin-ui/`, then changes HTML entrypoints and verifies their contents over HTTP. Existing pages can keep using old versioned assets. Old releases are retained; do not delete them while open pages might still request them. A failed publication rolls back the entrypoints. Opening or refreshing a page loads the new version; existing tabs are not forcibly reloaded. Do not run `npm run build` directly in a live workspace: Vite clears `dist/client`; use the deployment script's isolated build instead.

The Runtime must first have been deployed with versioned plugin UI support. After that, edits to plugin WebUI source do not directly change the published plugin UI. Plugin page registrations and plugin Runtime changes still require a complete deployment. A custom `PICO_PLUGIN_DIR` outside this workspace is not managed by this deployment flow; automatic full/plugin UI deployment refuses that configuration.

For a complete deployment, the script verifies the listener, workspace, credentials and systemd configuration, builds and tests first, then waits for API-visible active Threads and executions to become idle. It asks for `RESTART` and, immediately before shutdown, `STOP_RUNTIME`. After the old process has exited it installs the snapshot's Runtime and Executor artifacts, switches the frontend entrypoints, starts the replacement, and verifies the WebUI, authenticated health endpoint, workspace, plugin status and published resources. A failure before the old Runtime stops leaves it running. A failure after shutdown retains the artifact backup for manual recovery; do not assume the replacement is healthy. Do not submit new work between the final confirmation and replacement startup.

The script reads the existing `PICO_ACCESS_TOKEN` and the rest of the Runtime environment directly from the verified listener process into memory. It does not print or persist the token, or pass it as a command-line argument. API checks use only loopback or a `PICO_HOST` address that resolves to a local interface; redirects are disabled. For systemd it checks the existing credential source before stopping the unit and checks the replacement inherited the same token. The Runtime API cannot atomically block new work or expose all in-flight commands, so the final operator confirmation is still necessary. A detached-process shutdown timeout is not force-killed by the script; systemd controls its own stop deadline and may force-kill remaining cgroup members after `TimeoutStopSec`. Run on the host as the Runtime owner: the Codex sandbox cannot replace the host deployment.

A project-local lock prevents concurrent deploy scripts. If the script is killed forcibly or the host loses power, inspect `.pico-deploy.lock` and any `.pico-deploy-backup-*` directory before retrying. The next run can restore a recorded interrupted build only when the original Runtime PID and start time still match; it refuses to guess after shutdown has begun. If the old Runtime has stopped but replacement health checks have not passed, the backup is retained for operator recovery. A stale lock may be removed only after confirming its recorded PID and start time no longer identify the deployment script.

The target port defaults to `4173`. For a non-default port, set `PICO_DEPLOY_PORT` to the current Runtime's port. Optional wait limits are `PICO_DEPLOY_IDLE_TIMEOUT_SECONDS` (default `300`), `PICO_DEPLOY_SHUTDOWN_TIMEOUT_SECONDS` (default `180`), and `PICO_DEPLOY_STARTUP_TIMEOUT_SECONDS` (default `45`). Detached Runtime logs append to `/tmp/pico-runtime-production.log` with owner-only permissions; set `PICO_DEPLOY_LOG` to choose another location. For a user systemd unit, inspect logs with `journalctl --user -u <unit-name>`.

## Start or restart the Runtime

The production Runtime listens on `100.64.209.124:4173`. The launch script accepts one optional bind address and passes it to `PICO_HOST`:

```sh
NODE_ENV=production ./scripts/start-runtime.sh 100.64.209.124
```

Set `PICO_ACCESS_TOKEN` in the process environment before starting the script. For non-loopback bindings Pico requires a token of at least 32 bytes. Keep the token in the environment or the production process manager; do not put it in a command argument, checked-in file, or deployment log.

For a routine restart, reuse the existing production `PICO_ACCESS_TOKEN` so existing clients and authenticated sessions continue to use the same credential. If a production secret manager is configured, inject that same value into the replacement process. If the Runtime was started manually and the token exists only in its process environment, transfer it directly in memory to the replacement process environment before stopping the old Runtime. Do not generate or rotate a replacement token as part of deployment. Never print the token, place it in a command line, or save it in a deployment note, script, or temporary file. Rotate it only as a separate, intentional credential change.

### Required pre-stop credential handoff

Before sending `SIGTERM`, prepare the replacement launcher's environment with the existing token. When it is available only from the running Runtime, read it from that process into launcher memory and keep it there until the replacement process has inherited it. Validate only that it is present and meets the 32-byte minimum; never print or persist its value. If the replacement launch context cannot safely receive the existing token, stop here and restore access to the configured secret source while the old Runtime is still running. Do not stop the old Runtime first and then search shell history, configuration files, or unrelated process environments for a copy.

This is a hard gate, not a post-stop recovery step: the shell or user systemd manager may not have inherited a token that was set only for the Runtime process. Confirm the in-memory handoff is ready before continuing with the restart.

`scripts/start-runtime.sh` changes to the project root and runs `npm start` in the foreground. It does not build artifacts, stop an existing Runtime, or daemonize itself. Let the host's process manager keep it running, or run it in a controlled host session. The production instance deployed for this change was started as a detached host process with output in `/tmp/pico-runtime-production.log`; that temporary log location is specific to the current launch.

The ChatGPT plugin stores its OAuth secret in the dedicated `data/chatgpt-oauth.sqlite` database by default. Independent Runtimes that intentionally share this account must set `PICO_CHATGPT_OAUTH_DB_PATH` to the same file. The plugin serializes refreshes with a SQLite write lock, so only one Runtime rotates the shared refresh token at a time. Keep this database private and back it up like the Runtime database.

For a routine restart:

1. Finish or pause active Thread work, then check that the current listener belongs to this project with `ss -ltnp 'sport = :4173'` and inspect its working directory.
2. Complete the required pre-stop credential handoff above. Verify the launcher has the existing token in memory without printing it.
3. Send `SIGTERM` to the existing Runtime and wait for it to exit before starting another instance. Pico drains its HTTP/WebSocket connections and then shuts down Executors and closes SQLite.
4. If a WebUI tab remains connected, its WebSocket can keep graceful shutdown waiting after the listener has stopped accepting new requests. Close or reload the old tab and wait for the Runtime to exit. Do not force-stop a process while durable executions are active. If shutdown remains stuck, inspect execution states first; only stop the old process after confirming no active work and understanding that forced termination bypasses the remaining cleanup.
5. Start `./scripts/start-runtime.sh 100.64.209.124` with the prepared production environment, then verify the listener and WebUI response.

### Incident note (2026-10-24)

A deployment attempt stopped the old Runtime before transferring its process-only `PICO_ACCESS_TOKEN` to the replacement launcher's environment. The token was then unavailable from the shell and user systemd environment, so the replacement could not be started safely and the production listener was left down until the operator supplied the existing credential. The required pre-stop handoff above was added to prevent this ordering failure. Never include the token itself in incident notes.

Basic checks:

```sh
ss -ltnp 'sport = :4173'
curl -fsS -o /dev/null -w '%{http_code}\n' http://100.64.209.124:4173/
```

`/api/health` and plugin APIs require an authenticated Pico session when access-token protection is enabled. Verify a model-parameter profile through the WebUI or an authenticated API session; do not put the access token in a URL or print it in diagnostic output.

## Codex sandbox notes

- The default command sandbox is isolated from the host process and network namespaces. `ss`, `curl`, and process listings there can show no production listener even while the host Runtime is running.
- Starting `scripts/start-runtime.sh` from the default sandbox starts a sandbox-local process; it does not deploy to the host Runtime. Use the authorized host execution path for the production restart and verify the listener from that same host context.
- The sandbox may not have permission to inspect or terminate host processes, or to close a host TCP connection. A failed `ss -K` or similar operation is not evidence that the connection closed. Prefer the WebUI's normal reconnect/close behavior and graceful process shutdown.
- Build artifacts live in the project tree, but a running Node process keeps its already-loaded code. Rebuild first, then restart the host Runtime to load the new artifacts.
- Never print, copy into notes, or pass `PICO_ACCESS_TOKEN` as a command-line argument. Read it only through the intended process environment and redact diagnostics.
- Use the Pico entrypoint `scripts/start-runtime.sh` for this service. A similarly named deployment script in another project may manage unrelated applications and side effects.

## Verification performed for the model-parameters deployment

- The production listener was confirmed at `100.64.209.124:4173`.
- The WebUI returned HTTP 200; authenticated `/api/health` returned `{ "ok": true }`.
- The model-parameters profile API returned HTTP 200 for a ChatGPT model and exposed the expected reasoning-effort options and Fast mode control.
- The model-parameters plugin UI asset returned HTTP 200. The temporary authentication session used for these checks was revoked.

## Production deployment record (2026-10-27)

- Ran `./scripts/deploy-production.mjs` against the user systemd unit `pico-runtime.service`. The script reused the token from the verified Runtime process, checked that the replacement inherited the same value, and revoked its temporary authenticated session.
- `npm run build` and `npm run plugins:build:chatgpt` completed successfully. Vite warned that the main JavaScript bundle is larger than 500 kB; this warning did not fail the build.
- The unit returned to `active (running)` with `Result=success`. The replacement listener PID was `1102284` on `100.64.209.124:4173`; the WebUI returned HTTP 200. The script's authenticated health, workspace, and plugin-status checks passed. No deployment lock or backup remained.
- The old unit's stop phase exceeded its 45-second `TimeoutStopSec`; systemd killed a lingering Executor `conmon` process with SIGKILL before starting the replacement. The matching Executor container was running after startup, and the new Runtime passed its health checks, but the stop timeout caused a deployment interruption of about 45 seconds. Investigate Executor shutdown and the unit stop timeout before the next deployment.
