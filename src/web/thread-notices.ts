export type ThreadNotices = Record<string, string>;

export function withThreadNotice(notices: ThreadNotices, threadId: string, notice: string): ThreadNotices {
  return { ...notices, [threadId]: notice };
}

export function noticeForThread(threadId: string | null, notices: ThreadNotices, generalNotice = ''): string {
  return generalNotice || (threadId ? (notices[threadId] ?? '') : '');
}

export function withoutThreadNotice(notices: ThreadNotices, threadId: string): ThreadNotices {
  if (!(threadId in notices)) return notices;
  const next = { ...notices };
  delete next[threadId];
  return next;
}
