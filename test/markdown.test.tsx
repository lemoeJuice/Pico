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

  it('repairs bold literal URLs followed by Chinese punctuation', () => {
    expect(render('访问 **http://localhost:4173**。在另一个终端可运行：')).toContain(
      '<p>访问 <strong><a href="http://localhost:4173">http://localhost:4173</a></strong>。在另一个终端可运行：</p>',
    );
    expect(render('**https://example.com/中文路径**，接着是 **加粗**')).toContain(
      '<strong><a href="https://example.com/%E4%B8%AD%E6%96%87%E8%B7%AF%E5%BE%84">https://example.com/中文路径</a></strong>，接着是 <strong>加粗</strong>',
    );
    expect(render('**http://one.test**。和 **https://two.test**！')).toContain(
      '<strong><a href="http://one.test">http://one.test</a></strong>。和 <strong><a href="https://two.test">https://two.test</a></strong>！',
    );
    expect(render('“**https://example.com/path?q=1**”后续')).toContain(
      '“<strong><a href="https://example.com/path?q=1">https://example.com/path?q=1</a></strong>”后续',
    );
  });

  it('leaves code, escaped markers, and explicit links alone', () => {
    expect(render('`**http://localhost:4173**。`')).toContain('<code>**http://localhost:4173**。</code>');
    expect(render('```\n**http://localhost:4173**。\n```')).toContain('<code>**http://localhost:4173**。\n</code>');
    expect(render('\\*\\*http://localhost:4173**。')).not.toContain('<strong>');
    expect(render(String.raw`\**http://localhost:4173**。`)).not.toContain('<strong>');
    expect(render(String.raw`\\**http://localhost:4173**。`)).toContain(
      '<strong><a href="http://localhost:4173">http://localhost:4173</a></strong>。',
    );
    expect(render('[label](https://example.com/path**。)')).toContain(
      '<a href="https://example.com/path**%E3%80%82">label</a>',
    );
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

  it('resolves assistant workspace links for their Thread without changing external links', () => {
    const html = renderToStaticMarkup(
      <Markdown threadId="thread-1">
        {
          '[file](prototype/window-composite.mjs#L3) [unicode](目录/文件%20名.md) [web](https://example.com/path) [section](#part) [unsafe](javascript:alert%281%29)'
        }
      </Markdown>,
    );
    expect(html).toContain('href="/api/threads/thread-1/workspace-file?path=prototype%2Fwindow-composite.mjs#L3"');
    expect(html).toContain('path=%E7%9B%AE%E5%BD%95%2F%E6%96%87%E4%BB%B6+%E5%90%8D.md');
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('href="#part"');
    expect(html).not.toContain('javascript:');
  });
});
