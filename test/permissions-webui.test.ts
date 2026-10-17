import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

async function renderPermissionActions(status: string, approvalStatus: string | null = 'pending') {
  let html = '';
  let listener: (event: unknown) => void = () => {};
  let portListener: (event: { data: unknown }) => void = () => {};
  const root = {
    set innerHTML(value: string) {
      html = value;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ height: 90 }),
  };
  const parent = {};
  const port = {
    postMessage(message: { type?: string; id?: string; action?: string }) {
      if (message.action !== 'api' || !message.id) return;
      portListener({
        data: {
          type: 'pico:plugin-ui:response',
          id: message.id,
          ok: true,
          value: {
            tools: [],
            autoReview: false,
            approvals:
              approvalStatus === null
                ? []
                : [{ executionId: 'execution', status: approvalStatus, reviewer: undefined }],
          },
        },
      });
    },
    start() {},
    set onmessage(callback: (event: { data: unknown }) => void) {
      portListener = callback;
    },
  };
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
      viewId: 'PermissionResultActions',
      context: {
        thread: null,
        threadId: 'thread',
        toolResult: { executionId: 'execution', status },
      },
    },
    ports: [port],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return html;
}

it('keeps the framework Tool Card intact and adds approval actions only while an approval is pending', async () => {
  const pending = await renderPermissionActions('pending');
  expect(pending).toContain('Allow once');
  expect(pending).toContain('Deny');
  expect(pending).toContain('pico-ui-button--primary');
  expect(pending).not.toContain('Arguments');
  expect(pending).not.toContain('Result');
  expect(pending).not.toContain('<article');

  for (const status of ['running', 'completed', 'failed', 'interrupted']) {
    expect(await renderPermissionActions(status)).toBe('');
  }
  expect(await renderPermissionActions('pending', 'allowed')).toBe('');
});
