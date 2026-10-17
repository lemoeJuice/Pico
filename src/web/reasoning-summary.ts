/** Repair old summaries that consisted solely of headings concatenated without part boundaries. */
export function reasoningSummaryMarkdown(text: string): string {
  if (/^\*\*[^*\n]+(?:\*{4}[^*\n]+)+\*\*$/.test(text)) {
    return text.replace(/\*{4}/g, '**\n\n**');
  }
  return text;
}
