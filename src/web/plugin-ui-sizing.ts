export function clampPluginPopoverWidth(viewportWidth: number): number {
  const available = Math.max(0, viewportWidth - 24);
  return Math.min(360, available);
}
