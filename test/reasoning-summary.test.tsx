import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Markdown } from '../src/web/markdown.js';
import { reasoningSummaryMarkdown } from '../src/web/reasoning-summary.js';

it('renders legacy concatenated reasoning headings as separate emphasized paragraphs', () => {
  const text = reasoningSummaryMarkdown('**Archive download timed out****Clarifying no file created**');
  expect(renderToStaticMarkup(<Markdown>{text}</Markdown>)).toContain(
    '<p><strong>Archive download timed out</strong></p>\n<p><strong>Clarifying no file created</strong></p>',
  );
});

it('leaves ordinary Markdown, code, and new summaries unchanged', () => {
  for (const text of [
    '**One**\n\n**Two**',
    '```\n**One****Two**\n```',
    'Text with **bold** and **** literal characters.',
  ]) {
    expect(reasoningSummaryMarkdown(text)).toBe(text);
  }
});
