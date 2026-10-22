# Pico production Runtime deployment

This page records the production deployment flow used for Pico and the limits of running deployment commands from the Codex sandbox.

## Build

Run from the Pico project root after updating the source:

```sh
npm run build
npm run plugins:build:chatgpt
```

`npm run build` builds the Runtime, WebUI, default plugins, and Executor bundle. The ChatGPT plugin is a separate artifact, so rebuild it separately when its UI or Runtime code changes. Start the Runtime only after both builds finish.

## Start or restart the Runtime

The production Runtime listens on `100.64.209.124:4173`. The launch script accepts one optional bind address and passes it to `PICO_HOST`:

```sh
NODE_ENV=production ./scripts/start-runtime.sh 100.64.209.124
```

Set `PICO_ACCESS_TOKEN` in the process environment before starting the script. For non-loopback bindings Pico requires a token of at least 32 bytes. Keep the token in the environment or the production process manager; do not put it in a command argument, checked-in file, or deployment log.

For a routine restart, reuse the existing production `PICO_ACCESS_TOKEN` so existing clients and authenticated sessions continue to use the same credential. If a production secret manager is configured, inject that same value into the replacement process. If the Runtime was started manually and the token exists only in its process environment, transfer it directly in memory to the replacement process environment before stopping the old Runtime. Do not generate or rotate a replacement token as part of deployment. Never print the token, place it in a command line, or save it in a deployment note, script, or temporary file. Rotate it only as a separate, intentional credential change.

`scripts/start-runtime.sh` changes to the project root and runs `npm start` in the foreground. It does not build artifacts, stop an existing Runtime, or daemonize itself. Let the host's process manager keep it running, or run it in a controlled host session. The production instance deployed for this change was started as a detached host process with output in `/tmp/pico-runtime-production.log`; that temporary log location is specific to the current launch.

For a routine restart:

1. Finish or pause active Thread work, then check that the current listener belongs to this project with `ss -ltnp 'sport = :4173'` and inspect its working directory.
2. Send `SIGTERM` to the existing Runtime and wait for it to exit before starting another instance. Pico drains its HTTP/WebSocket connections and then shuts down Executors and closes SQLite.
3. If a WebUI tab remains connected, its WebSocket can keep graceful shutdown waiting after the listener has stopped accepting new requests. Close or reload the old tab and wait for the Runtime to exit. Do not force-stop a process while durable executions are active. If shutdown remains stuck, inspect execution states first; only stop the old process after confirming no active work and understanding that forced termination bypasses the remaining cleanup.
4. Start `./scripts/start-runtime.sh 100.64.209.124` with the production environment, reusing the existing `PICO_ACCESS_TOKEN` as described above, then verify the listener and WebUI response.

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
