export function mergePluginSelectionRefresh<T>(
  current: Record<string, T>,
  refreshed: Record<string, T>,
  startedVersions: Record<string, number>,
  currentVersions: Record<string, number>,
  busy: ReadonlySet<string>,
  drafts: ReadonlySet<string>,
): Record<string, T> {
  const merged = { ...current };
  for (const id of new Set([...Object.keys(current), ...Object.keys(refreshed)])) {
    if ((startedVersions[id] ?? 0) !== (currentVersions[id] ?? 0) || busy.has(id) || drafts.has(id)) continue;
    if (Object.hasOwn(refreshed, id)) merged[id] = refreshed[id]!;
    else delete merged[id];
  }
  return merged;
}
