export function isNearScrollEnd(
  { scrollHeight, scrollTop, clientHeight }: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 72,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
