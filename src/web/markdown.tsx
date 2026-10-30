import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkRepairBoldAutolinks } from './markdown-autolink-repair.js';

export function Markdown({ children, threadId }: { children: string; threadId?: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkRepairBoldAutolinks]}
        components={{
          a({ node: _node, href, ...props }) {
            if (threadId && href && !/^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(href)) {
              const hashIndex = href.indexOf('#');
              const fragment = hashIndex === -1 ? '' : href.slice(hashIndex);
              const path = (hashIndex === -1 ? href : href.slice(0, hashIndex)).split('?')[0]!;
              try {
                const query = new URLSearchParams({ path: decodeURIComponent(path) });
                href = `/api/threads/${encodeURIComponent(threadId)}/workspace-file?${query}${fragment}`;
              } catch {
                href = undefined;
              }
            }
            return <a href={href} {...props} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
