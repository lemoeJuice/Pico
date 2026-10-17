import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/web/markdown.js';

function render(markdown: string): string {
  return renderToStaticMarkup(<Markdown>{markdown}</Markdown>);
}

describe('Markdown', () => {
  it('renders common Markdown and GitHub Flavored Markdown structures', () => {
    const html = render(
      [
        '# Heading',
        '',
        'A paragraph with `inline code` and [a link](https://example.com).',
        '',
        '```ts',
        'const answer = 42;',
        '```',
        '',
        '- first item',
        '- second item',
        '',
        '> a quote',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| answer | 42 |',
      ].join('\n'),
    );

    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain(
      '<p>A paragraph with <code>inline code</code> and <a href="https://example.com">a link</a>.</p>',
    );
    expect(html).toContain('<pre><code class="language-ts">const answer = 42;\n</code></pre>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<table>');
    expect(html).toContain('<td style="text-align:right">42</td>');
    expect(html).toContain('class="markdown-body"');
  });

  it('does not render raw HTML as active elements', () => {
    const html = render('<script>alert(1)</script><img src=x onerror="alert(2)">');

    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).toContain('onerror=&quot;alert(2)&quot;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('omits links using unsafe protocols and keeps safe links', () => {
    const html = render(
      '[unsafe](javascript:alert%281%29) [data](data:text/html,evil) [safe](https://example.com) [relative](../guide)',
    );

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('<a href="">unsafe</a>');
    expect(html).toContain('<a href="">data</a>');
    expect(html).toContain('<a href="https://example.com">safe</a>');
    expect(html).toContain('<a href="../guide">relative</a>');
  });
});
