import { describe, expect, it } from 'vitest';
import { toolsPanelPosition } from '../src/web/tools-panel-position.js';

describe('Tools panel positioning', () => {
  it('keeps the existing panel width within both viewport edges', () => {
    expect(toolsPanelPosition({ left: 82, top: 59, bottom: 99 }, 347, 460, { width: 375, height: 667 })).toEqual({
      left: 16,
      top: 108,
      maxHeight: 460,
    });
    expect(toolsPanelPosition({ left: 2, top: 59, bottom: 99 }, 292, 100, { width: 320, height: 667 }).left).toBe(12);
  });

  it('opens below when content fits and above when only that side fits', () => {
    const anchor = { left: 100, top: 400, bottom: 440 };
    expect(toolsPanelPosition(anchor, 360, 200, { width: 800, height: 700 })).toEqual({
      left: 100,
      top: 449,
      maxHeight: 239,
    });
    expect(toolsPanelPosition(anchor, 360, 300, { width: 800, height: 700 })).toEqual({
      left: 100,
      bottom: 309,
      maxHeight: 379,
    });
  });

  it('uses the larger available side and limits the height for scrolling', () => {
    expect(toolsPanelPosition({ left: 82, top: 59, bottom: 99 }, 360, 800, { width: 667, height: 320 })).toEqual({
      left: 82,
      top: 108,
      maxHeight: 200,
    });
    expect(toolsPanelPosition({ left: 80, top: 200, bottom: 240 }, 292, 800, { width: 320, height: 320 })).toEqual({
      left: 16,
      bottom: 129,
      maxHeight: 179,
    });
  });
});
