import type { Root } from 'mdast';
import type { Processor } from 'unified';
import type { VFile } from 'vfile';

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
};

/** Repair bold HTTP(S) autolinks whose closing marker was swallowed before punctuation. */
export function remarkRepairBoldAutolinks(this: Processor) {
  const parse = this.parse.bind(this);

  return (tree: Root, file: VFile): Root | undefined => {
    const source = String(file);
    if (!source.includes('**')) return undefined;

    const insertions: { offset: number; value: string }[] = [];

    function visit(node: MarkdownNode) {
      if (!node.children) return;

      const children = node.children;
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        const previous = children[index - 1];
        if (
          child?.type === 'link' &&
          previous?.type === 'text' &&
          previous.value?.endsWith('**') &&
          child.children?.length === 1 &&
          child.children[0]?.type === 'text'
        ) {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          if (start !== undefined && end !== undefined) {
            const raw = source.slice(start, end);
            const match = /^(https?:\/\/[^\s<>*]+)\*\*(?!\*)(?=\p{P})/iu.exec(raw);
            const before = source.slice(0, start);
            if (match?.[1] && raw === child.children[0].value && /(?:^|[^\\*])(?:\\\\)*\*\*$/.test(before)) {
              insertions.push({ offset: start, value: '<' }, { offset: start + match[1].length, value: '>' });
            }
          }
        }
        if (child) visit(child);
      }
    }

    visit(tree);
    if (insertions.length === 0) return undefined;

    let repaired = source;
    for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
      repaired = repaired.slice(0, insertion.offset) + insertion.value + repaired.slice(insertion.offset);
    }
    return parse(repaired) as Root;
  };
}
