const EDGE = 12;
const GAP = 9;
const MAX_HEIGHT = 460;

export function toolsPanelPosition(
  anchor: { left: number; top: number; bottom: number },
  panelWidth: number,
  contentHeight: number,
  viewport: { width: number; height: number },
): { left: number; top?: number; bottom?: number; maxHeight: number } {
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - panelWidth - EDGE));
  const below = Math.max(0, viewport.height - anchor.bottom - GAP - EDGE);
  const above = Math.max(0, anchor.top - GAP - EDGE);
  const desiredHeight = Math.min(MAX_HEIGHT, contentHeight);
  const openBelow = below >= desiredHeight || (above < desiredHeight && below >= above);
  return openBelow
    ? { left, top: anchor.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) }
    : { left, bottom: viewport.height - anchor.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) };
}
