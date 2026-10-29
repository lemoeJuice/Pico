# pico.rolling-context

Rolling Context preserves Canonical History and projects user messages verbatim. A model round contains an assistant response and its complete tool-result batch; when the next model step starts, the plugin summarizes that round independently without user messages. Rounds remain hot until the Agent invokes `rolling_compact` with the number of recent completed rounds to keep. The action replaces eligible older rounds with their summaries only when its configured cost estimate supports the change. Existing warm summaries remain in the projection.

Runtime owns the separate `/compact` and window-limit fallback. It summarizes the final projected context, including user messages and rolling summaries, while preserving user constraints. The host loads this package through the `pico.rolling-context` dynamic entry; its UI runs in the plugin sandbox.
