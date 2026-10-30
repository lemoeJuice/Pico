(() => {
  'use strict';
  const pluginId = 'pico.todo';
  let port = null;
  let context = { thread: null };
  let items = [];
  let revision = 0;
  let openCount = 0;
  let busy = false;
  let loading = false;
  let error = '';
  let notice = '';
  let pendingBlockedId = '';
  let blockerDraft = '';
  let blockerRevision = 0;
  let form = { type: 'phase', title: '', phaseId: '', note: '', nextAction: '', blocker: '' };
  let editingId = '';
  let expandedOperationsId = '';
  let edit = {};
  let editingRevision = 0;
  let sequence = 0;
  let refreshGeneration = 0;
  let contextGeneration = 0;
  const pending = new Map();
  const paragraph = (value) => ({ type: 'paragraph', text: String(value ?? '') });
  const group = (...children) => {
    const layouts = ['row', 'spread', 'form-row', 'grid-2', 'grid-compact', 'grid-standard', 'stack-compact', 'nested'];
    const layout = layouts.includes(children.at(-1)) ? children.pop() : undefined;
    return { type: 'group', children, ...(layout ? { layout } : {}) };
  };
  const card = (...children) => ({ type: 'card', children: [group(...children, 'stack-compact')] });
  const button = (label, actionId, options = {}) => ({ type: 'button', label, actionId, ...options });
  const input = (label, value, actionId, placeholder = '', visuallyHidden = false) => ({ type: 'textInput', label, value: String(value ?? ''), placeholder, actionId, maxLength: 240, disabled: busy, ...(visuallyHidden ? { visuallyHidden: true } : {}) });
  const area = (label, value, actionId) => ({ type: 'textArea', label, value: String(value ?? ''), actionId, rows: 'compact', maxLength: 4000, disabled: busy });
  const preview = (value) => {
    const content = String(value ?? '');
    return content.length > 500 ? `${content.slice(0, 500)}…` : content;
  };

  function send(action, payload = {}) {
    if (!port) return Promise.reject(new Error('Pico plugin UI is not connected.'));
    const id = `${pluginId}-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, action, ...payload });
    });
  }
  function api(path, method = 'GET', body) {
    return send('api', { path: `/api/plugins/${pluginId}${path}`, ...(method === 'GET' ? {} : { init: { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } }) });
  }
  function phaseItems() { return items.filter((item) => item.type === 'phase'); }
  function taskItems(phaseId) { return items.filter((item) => item.type === 'task' && (item.phaseId ?? '') === phaseId); }
  function statusLabel(item) {
    return ({ open: 'Open', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' })[item.status] ?? item.status;
  }
  function rootItems() { return items.filter((item) => item.type === 'phase' || !item.phaseId); }
  function siblings(item) { return item.phaseId ? taskItems(item.phaseId) : rootItems(); }
  function move(item, direction) {
    const list = siblings(item);
    const index = list.findIndex((entry) => entry.id === item.id);
    const target = list[index + direction];
    if (!target) return;
    expandedOperationsId = '';
    const beforeId = direction < 0 ? target.id : (list[index + 2]?.id ?? null);
    void mutate([{ action: 'move', id: item.id, ...(item.type === 'task' ? { phaseId: item.phaseId ?? null } : {}), beforeId }]);
  }
  function itemNode(item, siblingIndex, siblingCount) {
    const isEditing = editingId === item.id;
    const operationsOpen = expandedOperationsId === item.id;
    const details = [item.note && `Note: ${preview(item.note)}`, item.nextAction && `Next: ${preview(item.nextAction)}`, item.blocker && `Blocked: ${preview(item.blocker)}`].filter(Boolean);
    const nodes = [group(
      { type: 'heading', text: item.title, level: item.type === 'phase' ? 3 : 4 },
      { type: 'status', text: statusLabel(item), tone: item.status === 'done' ? 'success' : item.status === 'blocked' ? 'danger' : 'neutral' },
      ...(!isEditing ? [button(operationsOpen ? 'Less' : 'More', `more:${item.id}`, { tone: 'quiet', disabled: busy })] : []),
      'spread')];
    if (details.length) nodes.push(paragraph(details.join(' · ')));
    if (operationsOpen && !isEditing) {
      nodes.push(group(
        button('↑', `move-up:${item.id}`, { tone: 'quiet', disabled: busy || siblingIndex === 0 }),
        button('↓', `move-down:${item.id}`, { tone: 'quiet', disabled: busy || siblingIndex === siblingCount - 1 }),
        ...(item.type === 'phase' ? [button('Add task', `add-task:${item.id}`, { tone: 'quiet', disabled: busy })] : []),
        button('Edit', `edit:${item.id}`, { tone: 'quiet', disabled: busy }),
        button('Delete', `delete:${item.id}`, { tone: 'danger', disabled: busy }),
        'row'));
      nodes.push(item.type === 'task'
        ? group(
          { type: 'select', label: 'Status', value: item.status, actionId: `status:${item.id}`, disabled: busy, options: [
            { label: 'Open', value: 'open' }, { label: 'In progress', value: 'in_progress' }, { label: 'Blocked', value: 'blocked' }, { label: 'Done', value: 'done' },
          ] },
          { type: 'select', label: 'Phase', value: item.phaseId ?? '', actionId: `phase:${item.id}`, disabled: busy, options: phaseOptions(item.phaseId) },
          'grid-2')
        : group({ type: 'select', label: 'Status', value: item.status, actionId: `status:${item.id}`, disabled: busy, options: [{ label: 'Open', value: 'open' }, { label: 'Done', value: 'done' }] }, 'row'));
    }
    if (isEditing) {
      nodes.push(input('Item title', edit.title, 'edit.title', 'Describe the outcome', true), area('Note', edit.note, 'edit.note'));
      if (item.type === 'task') nodes.push(area('Next action', edit.nextAction, 'edit.nextAction'), area('Blocker', edit.blocker, 'edit.blocker'));
      nodes.push(group(button('Save', `save:${item.id}`, { tone: 'primary', disabled: busy || !String(edit.title ?? '').trim() || (item.type === 'task' && item.status === 'blocked' && !String(edit.blocker ?? '').trim()) }), button('Cancel', 'cancel-edit', { disabled: busy }), 'row'));
    }
    if (item.type === 'task' && pendingBlockedId === item.id) {
      nodes.push(area('Blocker required to mark blocked', blockerDraft, 'blocked.value'));
      nodes.push(group(button('Set blocked', `blocked.save:${item.id}`, { tone: 'primary', disabled: busy || !blockerDraft.trim() }), button('Cancel', 'blocked.cancel', { disabled: busy }), 'row'));
    }
    return card(...nodes);
  }
  function phaseOptions(selectedId = '') {
    const phases = phaseItems();
    const selected = phases.find((phase) => phase.id === selectedId);
    return [{ label: 'No phase', value: '' }, ...phases.map((phase) => ({ label: phase.title, value: phase.id })), ...(selected && !phases.includes(selected) ? [{ label: `Current: ${selected.title}`, value: selected.id }] : [])];
  }
  function phaseNode(phase, index) {
    const allTasks = taskItems(phase.id);
    return card(
      itemNode(phase, rootItems().indexOf(phase), rootItems().length),
      ...(allTasks.length
        ? [group(...allTasks.map((task) => itemNode(task, allTasks.indexOf(task), allTasks.length)), 'nested')]
        : [paragraph('No tasks in this phase.')]),
    );
  }
  function draw() {
    if (!context.thread) {
      port?.postMessage({ type: 'pico:plugin-ui:render', tree: [card(paragraph('Select a Thread to manage its Todo plan.'))] });
      return;
    }
    const roots = rootItems();
    const nodes = [
      card(
      group({ type: 'heading', text: 'Todo' }, { type: 'status', text: loading ? 'Loading…' : `${openCount} unfinished`, tone: openCount ? 'neutral' : 'success' }, 'spread'),
      group({ type: 'select', label: 'Add item', value: form.type, actionId: 'form.type', disabled: busy, options: [{ label: 'Phase', value: 'phase' }, { label: 'Independent task', value: 'task' }, { label: 'Task in phase', value: 'phase-task' }] },
        ...(form.type === 'phase-task' ? [{ type: 'select', label: 'Phase', value: form.phaseId, actionId: 'form.phase', disabled: busy, options: phaseOptions(form.phaseId) }] : []), 'grid-2'),
      group(input('Item title', form.title, 'form.title', 'Describe the outcome', true), button('Add', 'add', { tone: 'primary', disabled: busy || !form.title.trim() || (form.type === 'phase-task' && !form.phaseId) }), 'form-row'),
      ),
      { type: 'separator' },
      { type: 'heading', text: 'Todo items', level: 3 },
      ...(loading ? [paragraph('Loading Todo items…')] : roots.map((item) => item.type === 'phase'
        ? phaseNode(item, roots.indexOf(item))
        : itemNode(item, rootItems().indexOf(item), rootItems().length))),
      ...(notice ? [{ type: 'status', text: notice, tone: 'success' }] : []),
      ...(error ? [{ type: 'status', text: error, tone: 'danger' }] : []),
    ];
    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }
  async function refresh() {
    const threadId = context.thread?.id;
    const generation = ++refreshGeneration;
    if (!threadId) { items = []; revision = 0; openCount = 0; loading = false; error = ''; notice = ''; draw(); return false; }
    loading = true; draw();
    try {
      const result = await api(`/threads?threadId=${encodeURIComponent(threadId)}`);
      if (generation !== refreshGeneration || context.thread?.id !== threadId) return;
      items = Array.isArray(result.items) ? result.items : [];
      revision = Number.isSafeInteger(result.revision) ? result.revision : 0;
      openCount = Number.isSafeInteger(result.openCount) ? result.openCount : items.filter((item) => item.status !== 'done').length;
      error = '';
      return true;
    } catch (reason) { if (generation === refreshGeneration) error = reason instanceof Error ? reason.message : String(reason); return false; }
    finally { if (generation === refreshGeneration) { loading = false; draw(); } }
  }
  async function mutate(operations, onSuccess, expectedRevision = revision) {
    if (busy || !context.thread) return;
    const generation = contextGeneration;
    expandedOperationsId = ''; busy = true; error = ''; notice = ''; draw();
    try {
      const result = await api('/edit', 'POST', { threadId: context.thread.id, expectedRevision, operations });
      if (generation !== contextGeneration) return;
      if (Number.isSafeInteger(result.revision)) revision = result.revision;
      onSuccess?.(result);
      await refresh();
    } catch (reason) {
      if (generation === contextGeneration) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (/409|conflict|revision/i.test(message)) {
          const refreshed = await refresh();
          if (refreshed) notice = 'Todo changed elsewhere. The latest version has been loaded.';
        }
        else error = message;
      }
    } finally { if (generation === contextGeneration) { busy = false; draw(); } }
  }
  function act(action) {
    const id = action.actionId;
    const value = String(action.value ?? '');
    if (id.startsWith('form.')) { const key = id.slice(5); if (key === 'type') form.type = value; else if (key === 'phase') form.phaseId = value; else form[key] = value; draw(); return; }
    if (id.startsWith('edit.')) { edit[id.slice(5)] = value; draw(); return; }
    if (id === 'blocked.value') { blockerDraft = value; draw(); return; }
    if (busy) return;
    if (id.startsWith('more:')) {
      const itemId = id.slice(5);
      expandedOperationsId = expandedOperationsId === itemId ? '' : itemId;
      draw(); return;
    }
    if (id === 'blocked.cancel') { pendingBlockedId = ''; blockerDraft = ''; draw(); return; }
    if (id.startsWith('blocked.save:')) {
      const itemId = id.slice('blocked.save:'.length);
      if (!blockerDraft.trim()) return;
      void mutate([{ action: 'set_status', id: itemId, status: 'blocked', blocker: blockerDraft.trim() }], () => { pendingBlockedId = ''; blockerDraft = ''; }, blockerRevision);
      return;
    }
    if (id === 'add') {
      const title = form.title.trim(); if (!title) return;
      const type = form.type === 'phase' ? 'phase' : 'task';
      void mutate([{ action: 'add', type, title, ...(form.type === 'phase-task' ? { phaseId: form.phaseId } : {}) }], () => { form = { ...form, title: '' }; }); return;
    }
    if (id.startsWith('edit:')) {
      const item = items.find((entry) => entry.id === id.slice(5)); if (!item) return;
      expandedOperationsId = ''; editingId = item.id; editingRevision = revision; edit = { title: item.title, note: item.note ?? '', nextAction: item.nextAction ?? '', blocker: item.blocker ?? '' }; draw(); return;
    }
    if (id === 'cancel-edit') { editingId = ''; edit = {}; expandedOperationsId = ''; draw(); return; }
    if (id.startsWith('save:')) {
      const itemId = id.slice(5); const item = items.find((entry) => entry.id === itemId); if (!item || !String(edit.title ?? '').trim()) return;
      const op = { action: 'update', id: itemId, title: edit.title.trim(), note: edit.note ?? '' };
      if (item.type === 'task') Object.assign(op, { nextAction: edit.nextAction ?? '', blocker: edit.blocker ?? '' });
      void mutate([op], () => { editingId = ''; edit = {}; expandedOperationsId = ''; }, editingRevision); return;
    }
    if (id.startsWith('done:')) {
      const item = items.find((entry) => entry.id === id.slice(5)); if (!item) return;
      void mutate([{ action: 'set_status', id: item.id, status: item.status === 'done' ? 'open' : 'done' }]); return;
    }
    if (id.startsWith('status:')) {
      const item = items.find((entry) => entry.id === id.slice(7)); if (!item) return;
      if (value === 'blocked' && item.type === 'task') { pendingBlockedId = item.id; blockerRevision = revision; blockerDraft = item.blocker ?? ''; draw(); return; }
      void mutate([{ action: 'set_status', id: item.id, status: value }]); return;
    }
    if (id.startsWith('phase:')) { const item = items.find((entry) => entry.id === id.slice(6)); if (!item) return; void mutate([{ action: 'move', id: item.id, phaseId: value || null, beforeId: null }]); return; }
    if (id.startsWith('move-up:') || id.startsWith('move-down:')) { const item = items.find((entry) => entry.id === id.slice(id.indexOf(':') + 1)); if (item) move(item, id.startsWith('move-up:') ? -1 : 1); return; }
    if (id.startsWith('add-task:')) { expandedOperationsId = ''; form.type = 'phase-task'; form.phaseId = id.slice(9); draw(); return; }
    if (id.startsWith('delete:')) {
      const itemId = id.slice(7);
      const item = items.find((entry) => entry.id === itemId);
      const retained = item?.type === 'phase' ? taskItems(item.id).length : 0;
      void mutate([{ action: 'delete', id: itemId }], () => { if (item?.type === 'phase') notice = `Phase deleted; ${retained} task${retained === 1 ? '' : 's'} retained as independent tasks.`; });
    }
  }
  function accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:response') { const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.ok ? handler.resolve(message.value) : handler.reject(new Error(message.error)); }
    else if (message.type === 'pico:plugin-ui:action') act(message);
    else if (message.type === 'pico:plugin-ui:context') {
      const next = message.context ?? { thread: null };
      if (context.thread?.id !== next.thread?.id) { contextGeneration++; items = []; revision = 0; openCount = 0; busy = false; loading = Boolean(next.thread); error = ''; notice = ''; editingId = ''; expandedOperationsId = ''; edit = {}; pendingBlockedId = ''; blockerDraft = ''; form = { type: 'phase', title: '', phaseId: '', note: '', nextAction: '', blocker: '' }; }
      context = next; draw(); void refresh();
    } else if (message.type === 'pico:plugin-ui:event' && message.event?.type === 'plugin.updated' && message.event.pluginId === pluginId) void refresh();
  }
  window.addEventListener('message', (event) => {
    const init = event.data;
    if (event.source !== window.parent || init?.type !== 'pico:plugin-ui:init' || init.protocolVersion !== 1 || init.pluginId !== pluginId || init.entry !== 'webui' || event.ports.length !== 1) return;
    context = init.context ?? { thread: null }; port = event.ports[0]; port.onmessage = (portEvent) => accept(portEvent.data); port.start(); draw();
    if (typeof init.attemptId === 'string') port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId });
    void refresh();
  });
})();
