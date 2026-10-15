(() => {
  'use strict';
  const pluginId = 'pico.project-context';
  const root = document.getElementById('root');
  if (!root) return;
  let port = null;
  let context = { thread: null };
  let entries = [];
  let query = '';
  let busy = false;
  let error = '';
  let editing = null;
  let pendingSource = null;
  let sequence = 0;
  const pending = new Map();
  function send(action, payload = {}) {
    if (!port) return Promise.reject(new Error('Pico plugin UI is not connected.'));
    const id = `${pluginId}-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...payload });
    });
  }
  function api(path, method = 'GET', body) {
    return send('api', {
      path: `/api/plugins/${pluginId}${path}`,
      ...(method === 'GET' ? {} : { init: { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } }),
    });
  }
  function escape(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
  async function refresh() {
    if (!context.thread?.projectId) {
      entries = [];
      draw();
      return;
    }
    try {
      const result = await api(
        `/memory?projectId=${encodeURIComponent(context.thread.projectId)}&q=${encodeURIComponent(query)}`,
      );
      entries = result.entries ?? [];
      error = '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    draw();
  }
  function card(entry) {
    const source = entry.sourceThreadId
      ? `Source: ${entry.sourceThreadId}${entry.sourceSeq === null ? '' : ` · #${entry.sourceSeq}`}`
      : `${entry.source} entry`;
    return `<article class="card"><div class="card-head"><span class="badge">${escape(entry.category)}${entry.status === 'conflicted' ? ' · conflict' : ''}${entry.status === 'expired' ? ' · expired' : ''}</span><button class="icon" data-action="pin" data-id="${escape(entry.id)}" title="${entry.pinned ? 'Unpin' : 'Pin'}">${entry.pinned ? '★' : '☆'}</button></div>${editing === entry.id ? `<form class="form" data-edit="${escape(entry.id)}"><select name="category">${['fact', 'decision', 'activity', 'open-issue'].map((item) => `<option ${entry.category === item ? 'selected' : ''}>${item}</option>`).join('')}</select><textarea name="text" required>${escape(entry.text)}</textarea><div class="form-actions"><button class="primary" type="submit">Save</button><button type="button" data-action="cancel">Cancel</button></div></form>` : `<div class="text">${escape(entry.text)}</div><div class="source">${escape(source)} · ${escape(entry.confidence)} confidence · ${escape(entry.source)}${entry.sourceThreadId && entry.sourceSeq !== null ? `<button class="source-link" data-action="source" data-thread="${escape(entry.sourceThreadId)}" data-seq="${entry.sourceSeq}">Open source</button>` : ''}</div><div class="card-actions"><button data-action="edit" data-id="${escape(entry.id)}">Edit</button><button data-action="conflict" data-id="${escape(entry.id)}">Mark conflict</button><button data-action="expire" data-id="${escape(entry.id)}">Expire</button><button class="danger" data-action="delete" data-id="${escape(entry.id)}">Delete</button></div>`}</article>`;
  }
  function draw() {
    if (!context.thread?.projectId) {
      root.innerHTML = '<div class="empty">Select a Thread attached to a Project to manage shared memory.</div>';
      return;
    }
    const categories = [
      ['activity', 'Recent project activity'],
      ['fact', 'Stable facts'],
      ['decision', 'Decisions'],
      ['open-issue', 'Open issues'],
    ];
    root.innerHTML = `<section class="panel"><div class="top"><div><div class="title">Project Context</div><div class="muted">Shared notes for ${escape(context.thread.title ?? 'this Project')}</div></div><button class="primary" data-action="add">Add memory</button></div><div class="search-wrap"><input class="search" id="search" placeholder="Search project memory" value="${escape(query)}"></div>${editing === 'new' ? `<form class="form" id="new-form"><select name="category"><option value="fact">fact</option><option value="decision">decision</option><option value="activity">activity</option><option value="open-issue">open issue</option></select><textarea name="text" required maxlength="4000" placeholder="Add a sourced project note"></textarea><div class="form-actions"><button class="primary" type="submit" ${busy ? 'disabled' : ''}>Save memory</button><button type="button" data-action="cancel">Cancel</button></div></form>` : ''}${categories
      .map(([id, label]) => {
        const group = entries.filter((entry) => entry.category === id);
        return group.length ? `<div class="group"><h3>${label}</h3>${group.map(card).join('')}</div>` : '';
      })
      .join(
        '',
      )}${entries.length ? '' : '<div class="empty">No matching Project Memory entries.</div>'}${error ? `<div class="error">${escape(error)}</div>` : ''}</section>`;
    root.querySelector('#search')?.addEventListener('input', (event) => {
      query = event.currentTarget.value;
      void refresh();
    });
    root.querySelector('#new-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      busy = true;
      draw();
      try {
        await api('/memory', 'POST', {
          threadId: context.thread.id,
          category: data.get('category'),
          text: data.get('text'),
        });
        editing = null;
        error = '';
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      } finally {
        busy = false;
        await refresh();
      }
    });
    root.querySelectorAll('form[data-edit]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const id = event.currentTarget.dataset.edit;
        try {
          await api('/memory', 'PATCH', {
            projectId: context.thread.projectId,
            id,
            category: data.get('category'),
            text: data.get('text'),
          });
          editing = null;
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
          draw();
        }
      }),
    );
    root.querySelectorAll('button[data-action]').forEach((button) =>
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        const id = button.dataset.id;
        if (action === 'source') {
          const sourceThreadId = button.dataset.thread;
          const seq = Number(button.dataset.seq);
          if (!sourceThreadId || !Number.isSafeInteger(seq)) return;
          try {
            if (context.thread?.id === sourceThreadId) await send('open-message', { seq });
            else {
              pendingSource = { threadId: sourceThreadId, seq };
              await send('open-thread', { threadId: sourceThreadId });
            }
          } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason);
            draw();
          }
          return;
        }
        if (action === 'add') {
          editing = 'new';
          draw();
          return;
        }
        if (action === 'edit') {
          editing = id;
          draw();
          return;
        }
        if (action === 'cancel') {
          editing = null;
          draw();
          return;
        }
        const entry = entries.find((item) => item.id === id);
        if (!entry) return;
        try {
          if (action === 'delete') await api('/memory', 'DELETE', { projectId: context.thread.projectId, id });
          else
            await api('/memory', 'PATCH', {
              projectId: context.thread.projectId,
              id,
              ...(action === 'pin'
                ? { pinned: !entry.pinned }
                : { status: action === 'conflict' ? 'conflicted' : 'expired' }),
            });
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
          draw();
        }
      }),
    );
    requestAnimationFrame(() =>
      port?.postMessage({ type: 'pico:plugin-ui:resize', height: root.getBoundingClientRect().height }),
    );
  }
  function accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:response') {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.ok) handler.resolve(message.value);
      else handler.reject(new Error(message.error));
    } else if (message.type === 'pico:plugin-ui:context') {
      context = message.context ?? { thread: null };
      editing = null;
      query = '';
      if (pendingSource && context.thread?.id === pendingSource.threadId) {
        const seq = pendingSource.seq;
        pendingSource = null;
        void send('open-message', { seq }).catch((reason) => {
          error = reason instanceof Error ? reason.message : String(reason);
          draw();
        });
      }
      void refresh();
    } else if (
      message.type === 'pico:plugin-ui:event' &&
      message.event?.type === 'plugin.updated' &&
      message.event.pluginId === pluginId
    )
      void refresh();
  }
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== 'pico:plugin-ui:init' ||
      event.data.protocolVersion !== 1 ||
      event.data.pluginId !== pluginId ||
      event.data.entry !== 'webui' ||
      event.ports.length !== 1
    )
      return;
    context = event.data.context ?? { thread: null };
    port = event.ports[0];
    port.onmessage = (portEvent) => accept(portEvent.data);
    port.start();
    draw();
    void refresh();
  });
})();
