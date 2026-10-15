(() => {
  'use strict';
  const pluginId = 'pico.global-memory';
  const root = document.getElementById('root');
  if (!root) return;
  let port = null;
  let context = { thread: null };
  let items = [];
  let autoEnabled = true;
  let search = '';
  let busy = false;
  let error = '';
  let seq = 0;
  const requests = new Map();
  function api(path, method = 'GET', body) {
    if (!port) return Promise.reject(new Error('Pico plugin UI is not connected.'));
    const id = `${pluginId}-${++seq}`;
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
  }
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  async function refresh() {
    try {
      const result = await api(`/items${search ? `?query=${encodeURIComponent(search)}` : ''}`);
      items = Array.isArray(result.items) ? result.items : [];
      autoEnabled = result.autoEnabled !== false;
      error = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    render();
  }
  function render() {
    if (!root) return;
    const threadId = context.thread?.id;
    root.innerHTML = `<section class="panel">
      <div class="heading"><span>Memory</span><label class="toggle"><input id="auto" type="checkbox" ${autoEnabled ? 'checked' : ''} ${busy ? 'disabled' : ''}> Automatic memory</label></div>
      <div class="muted">Global memories apply across Projects. Project Context remains scoped to its Project.</div>
      <form class="form" id="add"><textarea name="text" maxlength="1200" required placeholder="Add a durable preference or general fact…" aria-label="Memory text"></textarea><select name="category" aria-label="Category"><option value="preference">Preference</option><option value="fact">Fact</option><option value="collaboration">Collaboration</option><option value="other">Other</option></select><button ${busy ? 'disabled' : ''}>Add</button></form>
      <div class="search"><input id="search" value="${escape(search)}" placeholder="Search memories…" aria-label="Search memories"></div>
      ${error ? `<div class="error" role="alert">${escape(error)}</div>` : ''}
      <div class="items">${
        items
          .map(
            (item) => `<article class="item">
        <div class="row"><span class="tag">${escape(item.category)} · ${Math.round(item.confidence * 100)}%</span><label class="toggle"><input type="checkbox" data-pin="${escape(item.id)}" ${item.pinned ? 'checked' : ''} ${busy ? 'disabled' : ''}> Pin</label></div>
        <div class="item-text">${escape(item.text)}</div>
        ${item.applicability ? `<div class="muted">Applies: ${escape(item.applicability)}</div>` : ''}
        ${item.sources?.length ? `<div class="sources muted">Sources: ${item.sources.map((source) => `${escape(source.threadId)} #${escape(source.seq)}`).join(' · ')}</div>` : '<div class="sources muted">Manual entry</div>'}
        <div class="actions"><button type="button" data-edit="${escape(item.id)}" ${busy ? 'disabled' : ''}>Edit</button><button type="button" data-delete="${escape(item.id)}" ${busy ? 'disabled' : ''}>Delete</button></div>
      </article>`,
          )
          .join('') || '<div class="empty">No matching Global Memory entries.</div>'
      }</div>
    </section>`;
    root.querySelector('#search')?.addEventListener('input', (event) => {
      search = event.currentTarget.value;
      void refresh();
    });
    root.querySelector('#auto')?.addEventListener('change', async (event) => {
      busy = true;
      render();
      try {
        const result = await api('/settings', 'PUT', { autoEnabled: event.currentTarget.checked });
        autoEnabled = result.autoEnabled;
        error = '';
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      } finally {
        busy = false;
        render();
      }
    });
    root.querySelector('#add')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      busy = true;
      render();
      try {
        await api('/items', 'POST', {
          threadId,
          text: data.get('text'),
          category: data.get('category'),
          confidence: 1,
        });
        await refresh();
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      } finally {
        busy = false;
        render();
      }
    });
    root.querySelectorAll('[data-pin]').forEach((input) =>
      input.addEventListener('change', async (event) => {
        const item = items.find((candidate) => candidate.id === event.currentTarget.dataset.pin);
        if (!item) return;
        await mutate({ id: item.id, pinned: event.currentTarget.checked });
      }),
    );
    root.querySelectorAll('[data-edit]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        const item = items.find((candidate) => candidate.id === event.currentTarget.dataset.edit);
        if (!item) return;
        const text = window.prompt('Memory text', item.text);
        if (text === null) return;
        const applicability = window.prompt('Applicability (optional)', item.applicability || '');
        if (applicability === null) return;
        await mutate({ id: item.id, text, applicability });
      }),
    );
    root.querySelectorAll('[data-delete]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        const id = event.currentTarget.dataset.delete;
        if (!window.confirm('Delete this memory?')) return;
        busy = true;
        render();
        try {
          await api('/items', 'DELETE', { threadId, id });
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        } finally {
          busy = false;
          render();
        }
      }),
    );
  }
  async function mutate(patch) {
    busy = true;
    render();
    try {
      await api('/items', 'PATCH', { threadId: context.thread?.id, ...patch });
      await refresh();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      busy = false;
      render();
    }
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (
      event.source !== window.parent ||
      init?.type !== 'pico:plugin-ui:init' ||
      init.protocolVersion !== 1 ||
      init.pluginId !== pluginId ||
      init.entry !== 'webui' ||
      init.viewType !== 'page' ||
      event.ports.length !== 1
    )
      return;
    context = init.context || context;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'pico:plugin-ui:response' && requests.has(data.id)) {
        const request = requests.get(data.id);
        requests.delete(data.id);
        data.ok ? request.resolve(data.value) : request.reject(new Error(data.error));
      }
      if (data?.type === 'pico:plugin-ui:context') {
        context = data.context || context;
        void refresh();
      }
      if (
        data?.type === 'pico:plugin-ui:event' &&
        data.event?.type === 'plugin.updated' &&
        data.event.pluginId === pluginId
      )
        void refresh();
    };
    port.start();
    void refresh();
  });
})();
