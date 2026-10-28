# Pico production Runtime deployment

This page records the production deployment flow used for Pico and the limits of running deployment commands from the Codex sandbox.

## Build

Run from the Pico project root after updating the source:

```sh
npm run build
npm run plugins:build:chatgpt
```

`npm run build` builds the Runtime, WebUI, default plugins, and Executor bundle. The ChatGPT plugin is a separate artifact, so rebuild it separately when its UI or Runtime code changes. Start the Runtime only after both builds finish.

## Build and replace the production Runtime

Run `./scripts/deploy-production.mjs` in an interactive terminal on the deployment host as the Runtime owner. It supports the documented detached host process and systemd `.service` units. For systemd, it verifies before building that the unit's `Environment` contains the exact token from the running process, that no `EnvironmentFile` supplies credentials or `UnsetEnvironment` removes the token, and that `ExecStart` does not contain the token; it then restarts the unit through systemd and checks the replacement process inherited the same token. Unsupported unit setups fail before building. The script checks the current listener and workspace, waits for API-visible active Threads and executions to become idle, asks for `RESTART` before building and `STOP_RUNTIME` immediately before shutdown, saves the current generated artifacts, builds both documented artifacts, then replaces the process and verifies the WebUI, authenticated health endpoint, workspace, and plugin status. If a build fails, API-visible work becomes active during the build, or the script receives Ctrl-C/SIGTERM before stopping the old Runtime, it restores the saved artifacts and leaves the old process running. Do not submit new work while the script is building or restarting the service.

The script reads the existing `PICO_ACCESS_TOKEN` and the rest of the Runtime environment directly from the verified listener process into memory. It does not print or persist the token, or pass it as a command-line argument. API checks use only loopback or a `PICO_HOST` address that resolves to a local interface; the script rejects a non-local hostname instead of sending the token elsewhere. Redirects are disabled for all API requests. The current Runtime API does not expose in-flight command state such as `/compact` or auxiliary plugin model calls, and it cannot block new work atomically. The `STOP_RUNTIME` prompt therefore requires the operator to confirm those operations are finished and that no client submitted new work; do not submit work from any client through replacement startup. A small race remains if another client submits work after the final API check. If the token cannot be read, the process does not match this repository, API-visible work becomes active, or a detached-process shutdown times out, the script stops without force-killing the old process. For systemd units, the manager controls the stop deadline and `KillMode`; it may force-kill remaining cgroup members after `TimeoutStopSec`. Check those settings and confirm Executor shutdown fits within the deadline before deploying. If a systemd restart fails after the old listener has stopped, the script retains the build backup for recovery. Run it on the deployment host as the same OS user that runs Runtime, where `/proc` and `ss` can see the production process; the Codex sandbox cannot replace the host deployment.

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
