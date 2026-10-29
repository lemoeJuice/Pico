import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkRepairBoldAutolinks } from './markdown-autolink-repair.js';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRepairBoldAutolinks]}>{children}</ReactMarkdown>
    </div>
  );
}
