import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ToolCard, ToolCardExpansionProvider } from '../src/web/tool-card.js';

it('keeps arguments and the pending result visible without disclosure controls', () => {
  const html = renderToStaticMarkup(
    <ToolCard
      call={{ id: 'a', name: 'shell', arguments: { command: 'pwd' } }}
      execution={undefined}
      result={undefined}
    />,
  );
  expect(html).not.toContain('<details');
  expect(html).not.toContain('<summary');
  expect(html).toContain('pwd');
  expect(html).toContain('Waiting for the Executor');
  expect(html).toContain('tool-shell-output-pending');
});

it('uses the durable result status when execution history is outside the loaded page and escapes output', () => {
  const html = renderToStaticMarkup(
    <ToolCard
      call={{ id: 'a', name: 'shell', arguments: {} }}
      execution={undefined}
      result={{
        executionId: 'e',
        toolCallId: 'a',
        batchId: 'b',
        toolName: 'shell',
        status: 'completed',
        result: { stdout: '<script>alert(1)</script>', exitCode: 0 },
      }}
    />,
  );
  expect(html).toContain('status-completed');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

it('renders a compact summary when tool cards are collapsed by the host preference', () => {
  const html = renderToStaticMarkup(
    <ToolCardExpansionProvider defaultExpanded={false}>
      <ToolCard
        call={{ id: 'a', name: 'shell', arguments: { command: 'git status --short' } }}
        execution={undefined}
        result={undefined}
        expansionKey="thread-a:execution-a:0"
      />
    </ToolCardExpansionProvider>,
  );

  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('Command: git status --short');
  expect(html).not.toContain('tool-shell-body');
  expect(html).toContain('data-status="pending"');
});

it.each([
  { name: 'shell', field: 'command' },
  { name: 'apply_patch', field: 'patch' },
  { name: 'send_thread_message', field: 'message' },
])('keeps streamed $field content visible across incomplete JSON escapes', ({ name, field }) => {
  const value = 'stable first line\nsecond line with \\ and "quotes"\nlast line';
  const serialized = JSON.stringify({ [field]: value });
  const stablePrefix = serialized.indexOf('stable first line') + 'stable first line'.length;

  for (let length = stablePrefix; length <= serialized.length; length += 1) {
    const html = renderToStaticMarkup(
      <ToolCard
        call={{ id: 'a', name, arguments: {} }}
        execution={undefined}
        result={undefined}
        preview={{ argumentsText: serialized.slice(0, length) }}
      />,
    );
    expect(html, `preview ending at character ${length}`).toContain('stable first line');
  }

  const html = renderToStaticMarkup(
    <ToolCard
      call={{ id: 'a', name, arguments: {} }}
      execution={undefined}
      result={undefined}
      preview={{ argumentsText: serialized }}
    />,
  );
  expect(html).toContain('stable first line\nsecond line with \\ and &quot;quotes&quot;\nlast line');
});
