(() => {
  'use strict';
  const pluginId = 'pico.todo';
  let port = null;
  let context = { thread: null };
  let items = [];
  let openCount = 0;
  let busy = false;
  let loading = false;
  let error = '';
  let notice = '';
  let showCompleted = false;
  let editingId = '';
  let editValue = '';
  let addingChildId = '';
  let childValue = '';
  let newValue = '';
  let sequence = 0;
  let refreshGeneration = 0;
  let contextGeneration = 0;
  const pending = new Map();
  const text = (value) => ({ type: 'text', text: String(value ?? '') });
  const paragraph = (value) => ({ type: 'paragraph', text: String(value ?? '') });
  const group = (...children) => {
    const layouts = ['row', 'spread', 'form-row', 'grid-2', 'grid-compact', 'grid-standard', 'stack-compact'];
    const layout = layouts.includes(children.at(-1)) ? children.pop() : undefined;
    return { type: 'group', children, ...(layout ? { layout } : {}) };
  };
  const card = (...children) => ({ type: 'card', children: [group(...children, 'stack-compact')] });
  const button = (label, actionId, options = {}) => ({ type: 'button', label, actionId, ...options });

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

  function itemDepth(item, status) {
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    let depth = 0;
    let parentId = item.parentId;
    const seen = new Set([item.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.status === status) depth += 1;
      parentId = parent.parentId;
    }
    return Math.min(depth, 8);
  }

  function todoRow(item) {
    const id = item.id;
    const indent = `${'↳ '.repeat(itemDepth(item, item.status))}`;
    const controls = [
      {
        type: 'checkbox',
        label: `${indent}${item.title}`,
        checked: item.status === 'done',
        actionId: `toggle:${id}`,
        disabled: busy,
      },
    ];
    if (editingId === id) {
      controls.push(
        {
          type: 'textInput',
          label: 'Todo result',
          value: editValue,
          actionId: 'edit.value',
          maxLength: 240,
          disabled: busy,
        },
        group(
          button('Save', `save:${id}`, { tone: 'primary', disabled: busy || !editValue.trim() }),
          button('Cancel', 'edit.cancel', { disabled: busy }),
          'row',
        ),
      );
    } else {
      controls.push(
        group(
          button('Edit', `edit:${id}`, { tone: 'quiet', disabled: busy }),
          button('Add subitem', `child:${id}`, { tone: 'quiet', disabled: busy }),
          button('Delete', `delete:${id}`, { tone: 'danger', disabled: busy }),
          'row',
        ),
      );
    }
    if (addingChildId === id) {
      controls.push(
        {
          type: 'textInput',
          label: 'Subitem result',
          value: childValue,
          placeholder: 'Describe the result to finish',
          actionId: 'child.value',
          maxLength: 240,
          disabled: busy,
        },
        group(
          button('Add subitem', `child-add:${id}`, { tone: 'primary', disabled: busy || !childValue.trim() }),
          button('Cancel', 'child.cancel', { disabled: busy }),
          'row',
        ),
      );
    }
    return group(...controls, 'stack-compact');
  }

  function draw() {
    if (!context.thread) {
      port?.postMessage({
        type: 'pico:plugin-ui:render',
        tree: [card(paragraph('Select a Thread to manage its Todo items.'))],
      });
      return;
    }
    const openItems = items.filter((item) => item.status === 'open');
    const doneItems = items.filter((item) => item.status === 'done');
    const nodes = [
      card(
        group(
          { type: 'heading', text: 'Todo' },
          {
            type: 'status',
            text: loading ? 'Loading…' : `${openCount} unfinished`,
            tone: loading ? 'neutral' : openCount ? 'neutral' : 'success',
          },
          'spread',
        ),
        group(
          {
            type: 'textInput',
            label: 'New Todo result',
            value: newValue,
            placeholder: 'What result still needs to be completed?',
            actionId: 'new.value',
            maxLength: 240,
            disabled: busy,
          },
          button('Add', 'add', { tone: 'primary', disabled: busy || !newValue.trim() }),
          'form-row',
        ),
        ...(loading
          ? [paragraph('Loading Todo items…')]
          : openItems.length
            ? [{ type: 'list', ordered: false, items: openItems.map(todoRow) }]
            : [paragraph('No unfinished items.')]),
        ...(!loading && doneItems.length
          ? [
              {
                type: 'disclosure',
                label: `Completed (${doneItems.length})`,
                open: showCompleted,
                actionId: 'completed.toggle',
                children: showCompleted ? [{ type: 'list', ordered: false, items: doneItems.map(todoRow) }] : [],
              },
            ]
          : []),
        ...(notice ? [{ type: 'status', text: notice, tone: 'success' }] : []),
        ...(error ? [{ type: 'status', text: error, tone: 'danger' }] : []),
      ),
    ];
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }

  async function refresh() {
    const threadId = context.thread?.id;
    const generation = ++refreshGeneration;
    if (!threadId) {
      items = [];
      openCount = 0;
      loading = false;
      error = '';
      notice = '';
      draw();
      return;
    }
    loading = true;
    draw();
    try {
      const result = await api(`/threads?threadId=${encodeURIComponent(threadId)}`);
      if (generation !== refreshGeneration || context.thread?.id !== threadId) return;
      items = Array.isArray(result.items) ? result.items : [];
      openCount = Number.isSafeInteger(result.openCount)
        ? result.openCount
        : items.filter((item) => item.status === 'open').length;
      error = '';
    } catch (reason) {
      if (generation !== refreshGeneration) return;
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (generation === refreshGeneration) {
        loading = false;
        draw();
      }
    }
  }

  async function mutate(run, onSuccess) {
    if (busy) return;
    const generation = contextGeneration;
    busy = true;
    error = '';
    notice = '';
    draw();
    try {
      const result = await run();
      if (generation !== contextGeneration) return;
      if (onSuccess) onSuccess(result);
      await refresh();
    } catch (reason) {
      if (generation === contextGeneration) error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (generation === contextGeneration) {
        busy = false;
        draw();
      }
    }
  }

  function act(action) {
    const id = action.actionId;
    const value = String(action.value ?? '');
    if (id === 'new.value') {
      newValue = value;
      draw();
      if (action.event === 'submit') void act({ actionId: 'add' });
      return;
    }
    if (id === 'edit.value') {
      editValue = value;
      draw();
      if (action.event === 'submit' && editingId) void act({ actionId: `save:${editingId}` });
      return;
    }
    if (id === 'child.value') {
      childValue = value;
      draw();
      if (action.event === 'submit' && addingChildId) void act({ actionId: `child-add:${addingChildId}` });
      return;
    }
    if (busy) return;
    if (id === 'completed.toggle') {
      showCompleted = !showCompleted;
      draw();
      return;
    }
    if (id === 'edit.cancel') {
      editingId = '';
      editValue = '';
      draw();
      return;
    }
    if (id === 'child.cancel') {
      addingChildId = '';
      childValue = '';
      draw();
      return;
    }
    if (id === 'add') {
      const title = newValue.trim();
      if (!title || !context.thread) return;
      const threadId = context.thread.id;
      void mutate(
        () => api('/items', 'POST', { threadId, title }),
        () => {
          newValue = '';
        },
      );
      return;
    }
    if (id.startsWith('toggle:')) {
      const item = items.find((entry) => entry.id === id.slice(7));
      if (!item || !context.thread) return;
      const threadId = context.thread.id;
      void mutate(() =>
        api('/items', 'PATCH', {
          threadId,
          id: item.id,
          status: item.status === 'done' ? 'open' : 'done',
        }),
      );
      return;
    }
    if (id.startsWith('edit:')) {
      const item = items.find((entry) => entry.id === id.slice(5));
      if (!item) return;
      editingId = item.id;
      editValue = item.title;
      addingChildId = '';
      draw();
      return;
    }
    if (id.startsWith('save:')) {
      const itemId = id.slice(5);
      const title = editValue.trim();
      if (!title || !context.thread) return;
      const threadId = context.thread.id;
      void mutate(
        () => api('/items', 'PATCH', { threadId, id: itemId, title }),
        () => {
          editingId = '';
          editValue = '';
        },
      );
      return;
    }
    if (id.startsWith('child:')) {
      addingChildId = id.slice(6);
      childValue = '';
      editingId = '';
      draw();
      return;
    }
    if (id.startsWith('child-add:')) {
      const parentId = id.slice(10);
      const title = childValue.trim();
      if (!title || !context.thread) return;
      const threadId = context.thread.id;
      void mutate(
        () => api('/items', 'POST', { threadId, parentId, title }),
        () => {
          addingChildId = '';
          childValue = '';
        },
      );
      return;
    }
    if (id.startsWith('delete:')) {
      const itemId = id.slice(7);
      if (!context.thread) return;
      const threadId = context.thread.id;
      void mutate(
        () => api('/items', 'DELETE', { threadId, id: itemId }),
        (result) => {
          const kept = Number.isSafeInteger(result.keptSubitemCount) ? result.keptSubitemCount : 0;
          notice = kept ? `Todo item deleted; kept ${kept} subitem${kept === 1 ? '' : 's'}.` : 'Todo item deleted.';
        },
      );
    }
  }

  function accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:response') {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      message.ok ? handler.resolve(message.value) : handler.reject(new Error(message.error));
    } else if (message.type === 'pico:plugin-ui:action') {
      act(message);
    } else if (message.type === 'pico:plugin-ui:context') {
      const next = message.context ?? { thread: null };
      if (context.thread?.id !== next.thread?.id) {
        contextGeneration += 1;
        items = [];
        openCount = 0;
        busy = false;
        loading = Boolean(next.thread);
        error = '';
        notice = '';
        showCompleted = false;
        editingId = '';
        addingChildId = '';
        editValue = '';
        childValue = '';
        newValue = '';
      }
      context = next;
      draw();
      void refresh();
    } else if (
      message.type === 'pico:plugin-ui:event' &&
      message.event?.type === 'plugin.updated' &&
      message.event.pluginId === pluginId
    ) {
      void refresh();
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
      event.ports.length !== 1
    )
      return;
    context = init.context ?? { thread: null };
    port = event.ports[0];
    port.onmessage = (portEvent) => accept(portEvent.data);
    port.start();
    draw();
    if (typeof init.attemptId === 'string')
      port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId });
    void refresh();
  });
})();
