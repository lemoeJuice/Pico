# QQ adapter (SnowLuma OneBot)

The Runtime plugin binds one Project to a SnowLuma OneBot WebSocket. It routes accepted group and private messages to durable Pico Threads and replaces Pico's default system prompt for Threads in the selected Project.

## Setup

1. Add SnowLuma's `@snowluma/mcp` server in Pico's MCP Settings and start it. Configure the MCP for write mode if Pico should send messages or perform other write actions.
2. Leave MCP tool auto-enable off if the tools should be limited to QQ Threads. The adapter enables the selected server's tools per QQ Thread through Pico's Thread Tools service.
3. Enable `pico.qq-adapter`, open Settings → Integrations → QQ adapter, choose one Project and the SnowLuma MCP server, and enter the OneBot WebSocket URL. The access token is stored in Runtime secret storage and is never returned to the page.
4. Choose whether private/group messages are accepted. If the corresponding allowlist is empty, all messages of that enabled type are accepted. SnowLuma should filter messages sent by the bot account itself.

The plugin connects to the OneBot WebSocket service. SnowLuma MCP uses the corresponding OneBot HTTP endpoint; these are separate endpoints and must both be configured in SnowLuma/Pico.

## Threads and messages

Group chats route by `group:<group_id>` to a Thread named `群聊_<group_id>_<groupname>`. Private chats route by `private:<user_id>` to `私聊_<user_id>_<nickname>`. User messages contain a human-readable QQ chat and sender label followed by text. Non-text OneBot segments are represented by labels such as `[图片]`, `[文件]`, `[语音]`, and `[视频]`, plus available message/file IDs and URLs. Binary media is not embedded in the Pico message.

QQ events use Pico's ordinary user-message service. A leading slash in a QQ message stays message text and is never submitted as a Pico slash command. In Pico's Web UI, command routing occurs only after the user chooses a command suggestion.

## Tools and permissions

The plugin enables only MCP tools whose server ID matches the server selected in its Settings page. This changes Thread tool visibility and the plugin tracks only switches it changed from disabled to enabled, so it can turn those tools off when the selected server changes without disabling tools enabled by a user or the MCP default. For every Thread in the configured Project, the plugin's `toolInvocation` interceptor bypasses the Pico Permissions plugin, including Ask approvals and explicit Deny rules. This applies to every tool call in that Project and to manually created Threads as well as QQ Threads; SnowLuma's own write-mode checks still apply. Disabling the QQ adapter stops OneBot ingress and removes this bypass; it does not change Runtime permission policies or Executor isolation.

## Files

SnowLuma MCP stream downloads are written on the MCP host and its tool result contains a `file_path`, not file bytes. Completed downloads are not automatically deleted. For Container Threads, configure `SNOWLUMA_MCP_STREAM_DIR` inside the Project workspace, such as `<workspace>/.pico/snowluma-downloads`, and `SNOWLUMA_MCP_UPLOAD_ROOT` as the Project workspace. The prompt maps the host workspace prefix to `/workspace` when reading and maps `/workspace` back to the host path for upload. The MCP and Pico Runtime must share that workspace on the same host (or an explicitly shared filesystem); a remote MCP host's local path cannot be read from the Pico Container by prefix replacement alone.

SnowLuma's stream file actions require MCP write mode and `invoke_action`. The permission bypass does not change SnowLuma MCP's own mode gate or any action-level restrictions.
