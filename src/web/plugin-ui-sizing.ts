export function clampPluginPopoverWidth(preferredWidth: number | undefined, viewportWidth: number): number {
  const available = Math.max(0, viewportWidth - 24);
  return Math.min(Math.max(120, preferredWidth ?? 360), available);
}
