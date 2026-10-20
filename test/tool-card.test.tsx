import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ToolCard } from '../src/web/tool-card.js';

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
