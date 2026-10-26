(() => {
  'use strict';
  const pluginId = 'pico.qq-adapter';
  let port = null;
  let settings = null;
  let form = null;
  let busy = false;
  let error = '';
  let notice = '';
  let sequence = 0;
  let saveRevision = 0;
  let statusTimer = null;
  const requests = new Map();
  const button = (label, actionId, options = {}) => ({ type: 'button', label, actionId, ...options });
  const paragraph = (text) => ({ type: 'paragraph', text: String(text ?? '') });
  const api = (path, method = 'GET', body) => {
    const id = `${pluginId}-${++sequence}`;
    const init =
      method === 'GET' ? undefined : { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      port.postMessage({
        type: 'pico:plugin-ui:request',
        id,
        action: 'api',
        path: `/api/plugins/${pluginId}${path}`,
        ...(init ? { init } : {}),
      });
    });
  };
  const connectionLabel = (state) =>
    ({
      notConfigured: '未配置',
      connecting: '连接中',
      connected: '已连接',
      reconnecting: '重连中',
    })[state] || String(state || '未知');
  const mcpLabel = (server) =>
    `${server.name} · ${connectionLabel(server.status === 'ready' ? 'connected' : server.status)}`;
  async function refresh() {
    error = '';
    try {
      settings = await api('/config');
      if (!form) {
        form = { ...settings.config, accessToken: '', clearAccessToken: false };
      } else {
        form = {
          ...form,
          tokenConfigured: settings.config.tokenConfigured,
          privateUserIds: form.privateUserIds ?? settings.config.privateUserIds,
          groupIds: form.groupIds ?? settings.config.groupIds,
        };
      }
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    draw();
  }
  async function refreshStatus() {
    if (!port || busy) return;
    const revision = saveRevision;
    try {
      const latest = await api('/config');
      if (busy || revision !== saveRevision) return;
      settings = latest;
      if (form) form = { ...form, tokenConfigured: latest.config.tokenConfigured };
      draw();
    } catch {
      // A transient status refresh must not replace the saved page with an error.
    }
  }
  function draw() {
    if (!settings || !form) {
      port?.postMessage({
        type: 'pico:plugin-ui:render',
        tree: [{ type: 'heading', text: 'QQ 适配器' }, paragraph(error || '正在读取设置…')],
      });
      return;
    }
    const projects = settings.projects || [];
    const servers = settings.mcpServers || [];
    const selectedProject = projects.find((project) => project.id === form.projectId);
    const selectedServer = servers.find((server) => server.id === form.mcpServerId);
    const state = settings.status || {};
    const nodes = [
      { type: 'heading', text: 'QQ 适配器' },
      paragraph(
        '适配器只绑定一个 Project。OneBot WebSocket 负责接收事件；SnowLuma MCP 负责发送消息、处理操作和读取媒体。',
      ),
      {
        type: 'status',
        text: `OneBot：${connectionLabel(state.state)}${state.connectedAt ? ` · ${state.connectedAt}` : ''}`,
        tone: state.state === 'connected' ? 'success' : 'neutral',
      },
      { type: 'text', text: `已转发消息：${state.receivedMessages || 0}` },
      state.lastError ? paragraph(`连接错误：${state.lastError}`) : null,
      state.lastWarning ? paragraph(`状态提示：${state.lastWarning}`) : null,
      {
        type: 'select',
        label: '绑定 Project',
        value: form.projectId,
        actionId: 'projectId',
        disabled: busy,
        options: [
          { label: '选择 Project', value: '' },
          ...projects.map((project) => ({ label: `${project.name} · ${project.id}`, value: project.id })),
        ],
      },
      {
        type: 'select',
        label: 'QQ Thread 执行环境',
        value: form.executorKind,
        actionId: 'executorKind',
        disabled: busy,
        options: [
          { label: 'Container（推荐）', value: 'container' },
          { label: 'Host', value: 'host' },
        ],
      },
      {
        type: 'textInput',
        label: 'OneBot WebSocket URL',
        value: form.websocketUrl,
        placeholder: 'ws://127.0.0.1:3001/',
        actionId: 'websocketUrl',
        maxLength: 2048,
        disabled: busy,
      },
      {
        type: 'textInput',
        label: 'OneBot access token',
        inputType: 'password',
        value: form.accessToken,
        placeholder: form.tokenConfigured ? '已保存；留空表示不更改' : '可选',
        actionId: 'accessToken',
        maxLength: 4096,
        disabled: busy,
      },
      form.tokenConfigured
        ? {
            type: 'checkbox',
            label: '清除已保存的 access token',
            checked: form.clearAccessToken,
            actionId: 'clearAccessToken',
            disabled: busy,
          }
        : null,
      {
        type: 'select',
        label: 'SnowLuma MCP 服务',
        value: form.mcpServerId,
        actionId: 'mcpServerId',
        disabled: busy,
        options: [
          { label: '选择 MCP 服务', value: '' },
          ...servers.map((server) => ({ label: mcpLabel(server), value: server.id })),
        ],
      },
      selectedServer
        ? paragraph(
            `该服务目前有 ${selectedServer.toolCount || 0} 个已发现工具；QQ Thread 会单独开启这些工具的可见性。MCP 全局默认值仍由 MCP 设置管理。`,
          )
        : paragraph('请先在 MCP 设置中添加并启动 SnowLuma MCP，然后在这里选择。'),
      { type: 'switch', label: '接收私聊', checked: form.acceptPrivate, actionId: 'acceptPrivate', disabled: busy },
      {
        type: 'textArea',
        label: '私聊允许的 QQ 号',
        value: form.privateUserIds,
        placeholder: '每行一个；留空表示接收所有私聊',
        actionId: 'privateUserIds',
        rows: 'standard',
        maxLength: 10000,
        disabled: busy || !form.acceptPrivate,
      },
      { type: 'switch', label: '接收群聊', checked: form.acceptGroups, actionId: 'acceptGroups', disabled: busy },
      {
        type: 'textArea',
        label: '群号允许列表',
        value: form.groupIds,
        placeholder: '每行一个；留空表示接收所有群聊',
        actionId: 'groupIds',
        rows: 'standard',
        maxLength: 10000,
        disabled: busy || !form.acceptGroups,
      },
      paragraph(
        selectedProject ? `Workspace：${selectedProject.workspacePath}` : '选择 Project 后才能配置文件路径映射。',
      ),
      paragraph(
        'SnowLuma MCP 文件配置：使用 write 模式；将 SNOWLUMA_MCP_STREAM_DIR 设为 Project workspace 内的目录，将 SNOWLUMA_MCP_UPLOAD_ROOT 设为 Project workspace。Container 内将 workspace 前缀映射为 /workspace。已下载文件不会由 MCP 自动清理。',
      ),
      paragraph(
        '权限行为：插件绑定的 Project 下所有 Thread 的 Pico Ask/Deny 规则与审批队列都会被绕过，包括手动创建的 Thread。工具仍须在对应 Thread 的 Tools 面板中启用；QQ Thread 由插件自动开启所选 SnowLuma MCP 的工具。',
      ),
      {
        type: 'actions',
        children: [
          button(busy ? '保存中…' : '保存设置', 'save', { tone: 'primary', disabled: busy || !form.projectId }),
          button('刷新状态', 'refresh', { disabled: busy }),
          button('重新连接', 'reconnect', { disabled: busy }),
        ],
      },
    ].filter(Boolean);
    if (notice) nodes.push(paragraph(notice));
    if (error) nodes.push(paragraph(error));
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  function onAction(action) {
    const { actionId, value } = action;
    if (actionId === 'save') {
      if (busy) return;
      busy = true;
      saveRevision += 1;
      error = '';
      notice = '';
      draw();
      api('/config', 'PUT', form)
        .then((result) => {
          settings = result;
          form = { ...result.config, accessToken: '', clearAccessToken: false };
          notice = '设置已保存。';
        })
        .catch((reason) => {
          error = reason instanceof Error ? reason.message : String(reason);
        })
        .finally(() => {
          busy = false;
          draw();
        });
      return;
    }
    if (actionId === 'reconnect') {
      if (busy) return;
      busy = true;
      api('/reconnect', 'POST', {})
        .then((result) => {
          settings = result;
          notice = '已请求重新连接。';
        })
        .catch((reason) => {
          error = reason instanceof Error ? reason.message : String(reason);
        })
        .finally(() => {
          busy = false;
          draw();
        });
      return;
    }
    if (actionId === 'refresh') {
      void refresh();
      return;
    }
    if (actionId === 'acceptPrivate' || actionId === 'acceptGroups' || actionId === 'clearAccessToken') {
      form[actionId] = value === 'true' || value === true;
    } else if (actionId in form && typeof value === 'string') {
      form[actionId] = value;
      if (actionId === 'projectId' || actionId === 'mcpServerId') saveRevision += 1;
      if (actionId === 'accessToken') form.clearAccessToken = false;
    }
    draw();
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (
      event.source !== window.parent ||
      !init ||
      init.type !== 'pico:plugin-ui:init' ||
      init.protocolVersion !== 1 ||
      init.pluginId !== pluginId ||
      init.entry !== 'webui' ||
      init.viewType !== 'page' ||
      init.viewId !== 'settings' ||
      event.ports.length !== 1
    )
      return;
    port = event.ports[0];
    statusTimer = window.setInterval(() => {
      void refreshStatus();
    }, 5000);
    window.addEventListener(
      'pagehide',
      () => {
        if (statusTimer !== null) window.clearInterval(statusTimer);
      },
      { once: true },
    );
    port.onmessage = (message) => {
      const item = message.data;
      if (item?.type === 'pico:plugin-ui:action') onAction(item);
      else if (item?.type === 'pico:plugin-ui:response' && typeof item.id === 'string') {
        const pending = requests.get(item.id);
        if (pending) {
          requests.delete(item.id);
          item.ok ? pending.resolve(item.value) : pending.reject(new Error(item.error || 'Request failed.'));
        }
      }
    };
    port.start();
    port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId });
    void refresh();
  });
})();
