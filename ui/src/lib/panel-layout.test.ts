import { describe, expect, it } from 'vitest';
import { sidebarLayout, terminalHeightLimit } from './panel-layout';
const input = { width: 1352, projectRequested: true, assistantRequested: true, projectWidth: 328, assistantWidth: 328 };
const centerWidth = (width: number, result: ReturnType<typeof sidebarLayout>) => width - 32 - (result.project.overlay ? 0 : result.project.width) - (result.assistant.overlay ? 0 : result.assistant.width);

describe('measured panel budgets', () => {
  it('keeps both requested widths when the center has room', () => {
    const layout = sidebarLayout(input);
    expect(layout.project.width).toBe(328); expect(layout.assistant.width).toBe(328);
    expect(layout.project.visible && layout.assistant.visible).toBe(true);
  });
  it('reduces both widths jointly without erasing the requested preferences', () => {
    const layout = sidebarLayout({ ...input, width: 960 });
    expect(layout.project.visible && layout.assistant.visible).toBe(true);
    expect(layout.project.width).toBeGreaterThanOrEqual(200);
    expect(layout.assistant.width).toBeGreaterThanOrEqual(260);
    expect(centerWidth(960, layout)).toBeCloseTo(320);
    expect(sidebarLayout(input).project.width).toBe(328);
  });
  for (const width of [782, 741, 720]) {
    it(`temporarily hides the assistant at ${width} logical pixels and restores it when widened`, () => {
      const layout = sidebarLayout({ ...input, width });
      expect(layout.project.visible).toBe(true); expect(layout.assistant.visible).toBe(false);
      expect(centerWidth(width, layout)).toBeGreaterThanOrEqual(320);
      expect(sidebarLayout(input).assistant.visible).toBe(true);
    });
  }
  it('a single explicit restore gives that panel precedence', () => {
    const layout = sidebarLayout({ ...input, width: 782, preferred: 'assistant' });
    expect(layout.assistant.visible).toBe(true); expect(layout.project.visible).toBe(false);
    expect(centerWidth(782, layout)).toBeGreaterThanOrEqual(320);
  });
  it('does not undo an explicit user collapse when the viewport grows', () => {
    const layout = sidebarLayout({ ...input, assistantRequested: false });
    expect(layout.assistant.visible).toBe(false);
  });
  it('keeps the editor usable at maximum zoom and exposes an explicitly restored tool as an overlay', () => {
    const small = { ...input, width: 386 };
    const initial = sidebarLayout(small);
    expect(initial.project.visible || initial.assistant.visible).toBe(false);
    expect(centerWidth(386, initial)).toBeGreaterThanOrEqual(320);
    const restored = sidebarLayout({ ...small, preferred: 'assistant' });
    expect(restored.assistant.visible && restored.assistant.overlay).toBe(true);
    expect(restored.assistant.width).toBeLessThanOrEqual(354);
    expect(centerWidth(386, restored)).toBeGreaterThanOrEqual(320);
  });
  it('bounds drag maxima by the other panel minimum and the reserved center', () => {
    const layout = sidebarLayout({ ...input, width: 960 });
    expect(layout.project.max + 260 + 32 + 320).toBeLessThanOrEqual(960.01);
    expect(layout.assistant.max + 200 + 32 + 320).toBeLessThanOrEqual(960.01);
  });
  it('reserves useful editor height with an expanded terminal at zoom three', () => {
    expect(terminalHeightLimit(459)).toBe(251);
    expect(459 - terminalHeightLimit(459) - 8).toBe(200);
  });
  it('keeps the supported small-window editor floor and never extends beyond the viewport', () => {
    expect(terminalHeightLimit(179)).toBe(71);
    expect(terminalHeightLimit(0)).toBe(0);
  });
});


it('a deliberate resize follows the pointer while preserving the other stored width', () => {
  const resized = sidebarLayout({ ...input, width: 960, projectWidth: 330, resizing: 'project' });
  expect(resized.project.width).toBe(330);
  expect(resized.assistant.width).toBe(278);
  expect(centerWidth(960, resized)).toBe(320);
  expect(sidebarLayout({ ...input, projectWidth: 330, resizing: 'project' }).assistant.width).toBe(328);
});
