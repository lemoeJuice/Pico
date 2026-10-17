import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

function renderTool(status: string, result: unknown = null, error: string | null = null) {
  let html = '';
  let listener: (event: unknown) => void = () => {};
  const root = {
    set innerHTML(value: string) {
      html = value;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ height: 300 }),
  };
  const parent = {};
  runInNewContext(readFileSync(new URL('../plugins/pico.permissions/webui/permissions.js', import.meta.url), 'utf8'), {
    document: { getElementById: () => root, addEventListener() {} },
    window: {
      parent,
      addEventListener(_type: string, callback: typeof listener) {
        listener = callback;
      },
    },
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  listener({
    source: parent,
    data: {
      type: 'pico:plugin-ui:init',
      protocolVersion: 1,
      pluginId: 'pico.permissions',
      entry: 'webui',
      viewId: 'ToolExecution',
      context: {
        thread: null,
        toolCall: { id: 'call', name: 'shell', arguments: { command: 'pwd' } },
        execution: { id: 'execution', toolName: 'shell', arguments: { command: 'pwd' }, status, result, error },
      },
    },
    ports: [{ postMessage() {}, start() {} }],
  });
  return html;
}

it('keeps the permissions renderer arguments and result visible in every execution phase', () => {
  for (const status of ['pending', 'running', 'completed', 'failed', 'interrupted']) {
    const html = renderTool(status, status === 'completed' ? '/workspace' : null);
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).toContain('Arguments');
    expect(html).toContain('Result');
    expect(html).toContain('pwd');
  }
  expect(renderTool('pending')).toContain('Waiting for approval or Executor');
  expect(renderTool('running')).toContain('Running in the selected Executor');
  expect(renderTool('running')).not.toContain('<pre class="">null</pre>');
  expect(renderTool('completed', '/workspace')).toContain('/workspace');
});

it('escapes results and retains failure styling in the actual plugin renderer', () => {
  expect(renderTool('completed', '<script>alert(1)</script>')).toContain('&lt;script&gt;');
  expect(renderTool('failed', null, 'Executor <failed>')).toContain('Executor &lt;failed&gt;');
  expect(renderTool('failed', null, 'failure')).toContain('result-error');
});
