(() => {
  'use strict';

  const pluginId = 'pico.usage';
  const formatUsageSummary = window.PicoUsageSummary.formatUsageSummary;
  const pending = new Map();
  const query = new URLSearchParams(location.search);
  const callPageSize = 300;
  let port = null;
  let requestId = 0;
  let composerRefreshId = 0;
  let context = { thread: null };
  let report = null;
  let error = '';
  let busy = false;
  let savingRate = false;
  let composer = false;
  let catalog = { projects: [], threads: [], providerModels: [], purposes: [] };
  let filters = Object.fromEntries(
    ['threadId', 'projectId', 'provider', 'model', 'purpose', 'from', 'to'].map((key) => [key, query.get(key) || '']),
  );
  let filterDraft = { ...filters };
  let rateDraft = {
    provider: '',
    model: '',
    inputPerMillion: '',
    outputPerMillion: '',
    cachedInputPerMillion: '',
    cacheWritePerMillion: '',
    currency: '',
  };
  let callPage = 0;

  const paragraph = (text) => ({ type: 'paragraph', text: String(text ?? '') });
  const button = (label, actionId, disabled = busy, tone) => ({
    type: 'button',
    label,
    actionId,
    disabled,
    ...(tone ? { tone } : {}),
  });
  const fieldButton = (label, actionId, disabled = busy, tone) => ({
    type: 'fieldButton',
    label,
    actionId,
    disabled,
    ...(tone ? { tone } : {}),
  });
  const select = (label, value, actionId, options) => ({
    type: 'select',
    label,
    value: value || '',
    actionId,
    options,
  });
  const input = (label, value, actionId, inputType = 'text', placeholder = '', extra = {}) => ({
    type: 'textInput',
    label,
    value: String(value ?? ''),
    actionId,
    inputType,
    ...(placeholder ? { placeholder } : {}),
    ...extra,
  });

  function api(path, method = 'GET', body) {
    const id = `${pluginId}-${++requestId}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({
        type: 'pico:plugin-ui:request',
        id,
        action: 'api',
        path: `/api/plugins/${pluginId}${path}`,
        ...(method === 'GET'
          ? {}
          : { init: { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } }),
      });
    });
  }

  function filterQuery() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return params.size ? `?${params}` : '';
  }

  const fmt = (value) => (value == null ? 'unknown' : new Intl.NumberFormat().format(value));
  const money = (value, currency) => (value == null ? 'unknown' : `${currency || ''} ${value.toFixed(6)}`.trim());

  function labelBy(rows, id, key) {
    return rows.find((row) => row.id === id)?.[key] || (key === 'name' ? 'Unknown project' : 'Unknown thread');
  }

  function optionsWith(values, selected, placeholder) {
    const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right));
    const bounded = [...new Set([...(selected ? [selected] : []), ...sorted])].slice(0, 79);
    return [{ label: placeholder, value: '' }, ...bounded.map((value) => ({ label: value, value }))];
  }

  function coverage(value) {
    if (!value) return 'No data';
    const state = value.reported === 0 ? 'No data' : value.reported < value.total ? 'Partial' : 'Known';
    return `${state} · ${value.reported}/${value.total} calls`;
  }

  function cacheMetrics(rows) {
    const reported = rows.filter(
      (row) => typeof row.usage?.inputTokens === 'number' && typeof row.usage?.cachedInputTokens === 'number',
    );
    const inputTokens = reported.reduce((sum, row) => sum + row.usage.inputTokens, 0);
    const cachedInputTokens = reported.reduce((sum, row) => sum + row.usage.cachedInputTokens, 0);
    return {
      rate:
        inputTokens > 0
          ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format((cachedInputTokens / inputTokens) * 100)}%`
          : 'unknown',
      coverage: coverage({ reported: reported.length, total: rows.length }),
    };
  }

  async function loadCatalog() {
    try {
      const [value, options] = await Promise.all([api('/catalog'), api('/options')]);
      catalog = {
        projects: Array.isArray(value.projects) ? value.projects : [],
        threads: Array.isArray(value.threads) ? value.threads : [],
        providerModels: Array.isArray(options.providerModels) ? options.providerModels : [],
        purposes: Array.isArray(options.purposes) ? options.purposes : [],
      };
      draw();
    } catch (reason) {
      error = reason.message || String(reason);
      draw();
    }
  }

  async function refresh() {
    if (!port) return;
    busy = true;
    draw();
    try {
      report = await api(`/report${filterQuery()}`);
      error = '';
    } catch (reason) {
      error = reason.message || String(reason);
    } finally {
      busy = false;
      draw();
    }
  }

  async function refreshComposer() {
    const refreshId = ++composerRefreshId;
    const threadId = context.thread?.id;
    if (!threadId) {
      port?.postMessage({ type: 'pico:plugin-ui:render', tree: [] });
      return;
    }
    try {
      const result = await api(`/report?threadId=${encodeURIComponent(threadId)}`);
      if (refreshId !== composerRefreshId || context.thread?.id !== threadId) return;
      const summary = formatUsageSummary(result);
      port?.postMessage({
        type: 'pico:plugin-ui:render',
        tree: [
          {
            type: 'text',
            text: `In ${summary.input} · Out ${summary.output} · Cache ${summary.cached} · Hit ${summary.cacheRate} · ${summary.cacheCoverage}`,
          },
        ],
      });
    } catch {
      if (refreshId === composerRefreshId) port?.postMessage({ type: 'pico:plugin-ui:render', tree: [] });
    }
  }

  function metricCard(label, value, detail) {
    return {
      type: 'card',
      children: [{ type: 'text', text: label }, { type: 'heading', level: 4, text: value }, paragraph(detail)],
    };
  }

  function breakdownGroup(title, rows, label = (key) => key) {
    const items = (rows || []).slice(0, 12).map((row) => ({
      type: 'card',
      children: [{
        type: 'group',
        layout: 'stack-compact',
        children: [
          {
            type: 'group',
            layout: 'spread',
            children: [
              { type: 'text', text: String(label(row.key)) },
              { type: 'text', text: `${fmt(row.totals.inputTokens)} in / ${fmt(row.totals.outputTokens)} out` },
            ],
          },
          {
            type: 'text',
            text: `In ${coverage(row.coverage?.inputTokens)} · Out ${coverage(row.coverage?.outputTokens)}`,
          },
        ],
      }],
    }));
    return {
      type: 'group',
      children: [
        { type: 'heading', level: 4, text: title },
        ...(items.length ? items : [{ type: 'card', children: [{ type: 'text', text: 'No calls' }] }]),
      ],
    };
  }

  function draw() {
    if (composer) return;

    const totals = report?.totals || {};
    const rows = report?.rows || [];
    const cache = cacheMetrics(rows);
    const nodes = [
      {
        type: 'group',
        layout: 'spread',
        children: [
          {
            type: 'group',
            layout: 'stack-compact',
            children: [
              { type: 'heading', level: 2, text: 'Usage' },
              paragraph('Committed main calls and Runtime-tracked auxiliary model calls'),
            ],
          },
          button('Refresh', 'refresh'),
        ],
      },
    ];

    const projectOptions = optionsWith(
      catalog.projects.map((project) => project.id),
      filterDraft.projectId,
      'All projects',
    ).map((option) => ({
      ...option,
      label: option.value ? labelBy(catalog.projects, option.value, 'name') : option.label,
    }));
    const threadList = catalog.threads.filter(
      (thread) => !filterDraft.projectId || thread.projectId === filterDraft.projectId,
    );
    const threadOptions = optionsWith(
      threadList.map((thread) => thread.id),
      filterDraft.threadId,
      'All threads',
    ).map((option) => ({
      ...option,
      label: option.value ? labelBy(threadList, option.value, 'title') : option.label,
    }));
    const providers = [...new Set(catalog.providerModels.map((pair) => pair.provider))];
    const models = catalog.providerModels
      .filter((pair) => !filterDraft.provider || pair.provider === filterDraft.provider)
      .map((pair) => pair.model);

    nodes.push(
      {
        type: 'group',
        layout: 'grid-2',
        children: [
          select('Project', filterDraft.projectId, 'filter.projectId', projectOptions),
          select('Thread', filterDraft.threadId, 'filter.threadId', threadOptions),
          select(
            'Provider',
            filterDraft.provider,
            'filter.provider',
            optionsWith(providers, filterDraft.provider, 'Any provider'),
          ),
          select('Model', filterDraft.model, 'filter.model', optionsWith(models, filterDraft.model, 'Any model')),
          input('From', filterDraft.from, 'filter.from', 'date'),
          input('To', filterDraft.to, 'filter.to', 'date'),
          select(
            'Purpose',
            filterDraft.purpose,
            'filter.purpose',
            optionsWith(catalog.purposes, filterDraft.purpose, 'Any purpose'),
          ),
          fieldButton('Apply filters', 'apply-filters', busy, 'primary'),
        ],
      },
      ...(error ? [{ type: 'status', text: error, tone: 'danger' }] : []),
      paragraph('Token totals include reported values only; missing values are excluded, never estimated.'),
      {
        type: 'group',
        layout: 'masonry',
        // Masonry flows down columns, so order cards column-first to preserve the first row.
        children: [
          metricCard('Input tokens', fmt(totals.inputTokens), coverage(report?.coverage?.inputTokens)),
          metricCard('Cache hit rate', cache.rate, cache.coverage),
          metricCard('Main calls', fmt(report?.counts?.completedMainCalls), ''),
          metricCard('Output tokens', fmt(totals.outputTokens), coverage(report?.coverage?.outputTokens)),
          metricCard('Reasoning', fmt(totals.reasoningTokens), coverage(report?.coverage?.reasoningTokens)),
          metricCard('Auxiliary calls', fmt(report?.counts?.auxiliaryCalls), ''),
          metricCard('Cache read', fmt(totals.cachedInputTokens), coverage(report?.coverage?.cachedInputTokens)),
          metricCard(
            'Estimated cost',
            money(totals.estimatedCost, rows.find((row) => row.currency)?.currency),
            'Unknown if any call or required price is unknown',
          ),
        ],
      },
      { type: 'heading', level: 2, text: 'Breakdown' },
      {
        type: 'group',
        layout: 'grid-standard',
        children: [
          breakdownGroup('By Thread', report?.groups?.thread, (id) => labelBy(catalog.threads, id, 'title')),
          breakdownGroup('By Project', report?.groups?.project, (id) => labelBy(catalog.projects, id, 'name')),
          breakdownGroup('By Provider', report?.groups?.provider),
          breakdownGroup('By Model', report?.groups?.model),
          breakdownGroup('By Purpose', report?.groups?.purpose),
          breakdownGroup('By day', report?.groups?.day),
        ],
      },
      { type: 'heading', level: 2, text: 'Model calls' },
    );

    const pageCount = Math.max(1, Math.ceil(rows.length / callPageSize));
    callPage = Math.min(callPage, pageCount - 1);
    const firstRow = callPage * callPageSize;
    const visibleRows = rows
      .slice()
      .reverse()
      .slice(firstRow, firstRow + callPageSize);
    const callTable = {
      type: 'table',
      columns: ['Time', 'Kind / purpose', 'Provider / model', 'Thread', 'Status / tokens', 'Cost', 'Attempts'],
      rows: visibleRows.map((row) => [
        new Date(row.createdAt).toLocaleString(),
        `${row.kind}\n${row.purpose}`,
        `${row.provider}\n${row.model}`,
        row.threadId ? labelBy(catalog.threads, row.threadId, 'title') : '—',
        `${row.status}\n${fmt(row.usage?.inputTokens)} in / ${fmt(row.usage?.outputTokens)} out`,
        money(row.estimatedCost, row.currency),
        (row.attempts || []).map((attempt) => `${attempt.outcome || 'attempt'} · ${attempt.model || ''}`).join('\n') ||
          '—',
      ]),
    };
    nodes.push(callTable);
    if (rows.length === 0) nodes.push(paragraph('No calls match the selected filters.'));
    nodes.push(
      paragraph(
        rows.length <= callPageSize
          ? 'Showing up to 300 calls. Main-call rows use committed responses; failed attempts and retries are not included.'
          : `Showing ${firstRow + 1}–${Math.min(rows.length, firstRow + visibleRows.length)} of ${rows.length} calls. Main-call rows use committed responses; failed attempts and retries are not included.`,
      ),
    );
    if (pageCount > 1) {
      nodes.push({
        type: 'actions',
        children: [
          button('Previous calls', 'model-calls.previous', busy || callPage === 0),
          { type: 'text', text: `Page ${callPage + 1} of ${pageCount}` },
          button('Next calls', 'model-calls.next', busy || callPage >= pageCount - 1),
        ],
      });
    }

    const rateProviders = optionsWith(providers, rateDraft.provider, 'Select provider');
    const rateModels = catalog.providerModels
      .filter((pair) => !rateDraft.provider || pair.provider === rateDraft.provider)
      .map((pair) => pair.model);
    nodes.push(
      { type: 'heading', level: 2, text: 'Rates' },
      {
        type: 'card',
        children: [
          paragraph(
            'The current provider/model rates are used to estimate costs for all calls, including historical calls. Costs remain unknown if a required price is missing.',
          ),
        ],
      },
      {
        type: 'group',
        layout: 'grid-2',
        children: [
          select('Provider', rateDraft.provider, 'rate.provider', rateProviders),
          select('Model', rateDraft.model, 'rate.model', optionsWith(rateModels, rateDraft.model, 'Select model')),
          input('Input / 1M', rateDraft.inputPerMillion, 'rate.inputPerMillion', 'number', '', { min: 0, step: 'any' }),
          input('Output / 1M', rateDraft.outputPerMillion, 'rate.outputPerMillion', 'number', '', {
            min: 0,
            step: 'any',
          }),
          input('Cache read / 1M', rateDraft.cachedInputPerMillion, 'rate.cachedInputPerMillion', 'number', '', {
            min: 0,
            step: 'any',
          }),
          input('Cache write / 1M', rateDraft.cacheWritePerMillion, 'rate.cacheWritePerMillion', 'number', '', {
            min: 0,
            step: 'any',
          }),
          input('Currency', rateDraft.currency, 'rate.currency', 'text', 'e.g. USD', { maxLength: 8 }),
          fieldButton(
            savingRate ? 'Saving rate…' : 'Save rate',
            'save-rate',
            busy ||
              !rateDraft.provider ||
              !rateDraft.model ||
              !rateDraft.currency ||
              !rateDraft.inputPerMillion ||
              !rateDraft.outputPerMillion,
            'primary',
          ),
        ],
      },
    );

    const rates = report?.rates || [];
    if (rates.length) {
      nodes.push({
        type: 'group',
        layout: 'stack-compact',
        children: rates.map((rate) => {
          const price = (value) => `${rate.currency} ${value}`;
          const priceLine = (label, value) => ({
            type: 'group',
            layout: 'spread',
            children: [
              { type: 'text', text: label },
              { type: 'text', text: value == null ? '—' : `${price(value)} / 1M` },
            ],
          });
          return {
            type: 'card',
            children: [
              {
                type: 'group',
                layout: 'spread',
                children: [
                  {
                    type: 'group',
                    layout: 'stack-compact',
                    children: [{ type: 'heading', level: 4, text: `${rate.provider} / ${rate.model}` }],
                  },
                  button('Remove', `delete-rate:${rate.id}`, busy, 'danger'),
                ],
              },
              {
                type: 'group',
                layout: 'stack-compact',
                children: [
                  priceLine('Input', rate.inputPerMillion),
                  priceLine('Output', rate.outputPerMillion),
                  priceLine('Cache read', rate.cachedInputPerMillion),
                  priceLine('Cache write', rate.cacheWritePerMillion),
                ],
              },
            ],
          };
        }),
      });
    } else {
      nodes.push(paragraph('No rates configured.'));
    }
    for (const item of report?.limitations || []) nodes.push(paragraph(item));

    port?.postMessage({ type: 'pico:plugin-ui:render', tree: nodes });
  }

  function rateId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function act(action) {
    const { actionId, value } = action;
    if (actionId.startsWith('filter.')) {
      const key = actionId.slice('filter.'.length);
      filterDraft = { ...filterDraft, [key]: value };
      if (key === 'projectId') filterDraft.threadId = '';
      if (key === 'provider') filterDraft.model = '';
      draw();
      return;
    }
    if (actionId.startsWith('rate.')) {
      rateDraft = { ...rateDraft, [actionId.slice('rate.'.length)]: value };
      if (actionId === 'rate.provider') rateDraft.model = '';
      draw();
      return;
    }
    if (actionId === 'model-calls.previous') {
      callPage = Math.max(0, callPage - 1);
      draw();
      return;
    }
    if (actionId === 'model-calls.next') {
      callPage = Math.min(Math.max(0, Math.ceil((report?.rows?.length || 0) / callPageSize) - 1), callPage + 1);
      draw();
      return;
    }
    if (actionId === 'refresh') {
      callPage = 0;
      await refresh();
      return;
    }
    if (actionId === 'apply-filters') {
      filters = { ...filterDraft };
      callPage = 0;
      await refresh();
      return;
    }
    if (actionId === 'save-rate') {
      const valueFor = (key) => Number(rateDraft[key]);
      const rate = {
        id: rateId(),
        provider: rateDraft.provider,
        model: rateDraft.model,
        currency: rateDraft.currency,
        inputPerMillion: valueFor('inputPerMillion'),
        outputPerMillion: valueFor('outputPerMillion'),
        ...(rateDraft.cachedInputPerMillion ? { cachedInputPerMillion: valueFor('cachedInputPerMillion') } : {}),
        ...(rateDraft.cacheWritePerMillion ? { cacheWritePerMillion: valueFor('cacheWritePerMillion') } : {}),
      };
      busy = true;
      savingRate = true;
      draw();
      try {
        await api('/rates', 'PUT', { rate });
        rateDraft = {
          provider: '',
          model: '',
          inputPerMillion: '',
          outputPerMillion: '',
          cachedInputPerMillion: '',
          cacheWritePerMillion: '',
          currency: '',
        };
        await refresh();
      } catch (reason) {
        error = reason.message || String(reason);
      } finally {
        savingRate = false;
        busy = false;
        draw();
      }
      return;
    }
    if (actionId.startsWith('delete-rate:')) {
      try {
        await api('/rates', 'DELETE', { id: actionId.slice('delete-rate:'.length) });
        await refresh();
      } catch (reason) {
        error = reason.message || String(reason);
        draw();
      }
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
      !['page', 'component'].includes(init.viewType) ||
      event.ports.length !== 1
    )
      return;

    context = init.context || context;
    port = event.ports[0];
    composer = init.viewType === 'component' && init.viewId === 'ComposerUsage';
    port.onmessage = ({ data }) => {
      if (data?.type === 'pico:plugin-ui:response' && pending.has(data.id)) {
        const request = pending.get(data.id);
        pending.delete(data.id);
        data.ok ? request.resolve(data.value) : request.reject(new Error(data.error));
      } else if (data?.type === 'pico:plugin-ui:action') {
        void act(data);
      } else if (data?.type === 'pico:plugin-ui:context') {
        context = data.context || context;
        if (composer) void refreshComposer();
      } else if (data?.type === 'pico:plugin-ui:event' && composer) {
        void refreshComposer();
      }
    };
    port.start();
    if (composer) {
      void refreshComposer();
    } else {
      draw();
      void loadCatalog();
      void refresh();
    }
    if (typeof init.attemptId === 'string')
      port.postMessage({ type: 'pico:plugin-ui:ready', attemptId: init.attemptId });
  });
})();
