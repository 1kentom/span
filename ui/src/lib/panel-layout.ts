export type Sidebar = 'project' | 'assistant';
export const MIN_CENTER_WIDTH = 320;
const PADDING = 16;
const HANDLES = 16;
const minimum = { project: 200, assistant: 260 };

export interface SidebarLayoutInput {
  width: number;
  projectRequested: boolean;
  assistantRequested: boolean;
  projectWidth: number;
  assistantWidth: number;
  /** The last deliberately opened panel takes precedence when both cannot fit. */
  preferred?: Sidebar;
  resizing?: Sidebar;
}
export interface SidebarFit { visible: boolean; overlay: boolean; width: number; max: number }

/** Preferences remain untouched. This is the temporary fit for the measured logical viewport. */
export function sidebarLayout(input: SidebarLayoutInput): { project: SidebarFit; assistant: SidebarFit } {
  const width = Math.max(0, input.width);
  const center = Math.min(MIN_CENTER_WIDTH, Math.max(0, width - PADDING - HANDLES));
  const budget = Math.max(0, width - PADDING - HANDLES - center);
  let project = input.projectRequested;
  let assistant = input.assistantRequested;
  const preferred = input.preferred ?? 'project';
  if (project && assistant && budget < minimum.project + minimum.assistant) {
    if (preferred === 'project') assistant = false; else project = false;
  }
  if (project && budget < minimum.project) project = false;
  if (assistant && budget < minimum.assistant) assistant = false;
  const overlay = input.preferred && !(input.preferred === 'project' ? project : assistant)
    && (input.preferred === 'project' ? input.projectRequested : input.assistantRequested) ? input.preferred : undefined;
  const cap = (side: Sidebar, other: boolean) => Math.max(0, Math.min(1000, Math.max(minimum[side], width * .42), budget - (other ? minimum[side === 'project' ? 'assistant' : 'project'] : 0)));
  let left = project ? Math.min(Math.max(minimum.project, input.projectWidth), cap('project', assistant)) : 0;
  let right = assistant ? Math.min(Math.max(minimum.assistant, input.assistantWidth), cap('assistant', project)) : 0;
  if (project && assistant && left + right > budget) {
    if (input.resizing === 'project') right = budget - left;
    else if (input.resizing === 'assistant') left = budget - right;
    else {
      const excess = left + right - minimum.project - minimum.assistant;
      const available = budget - minimum.project - minimum.assistant;
      left = minimum.project + (excess ? (left - minimum.project) * available / excess : 0);
      right = budget - left;
    }
  }
  const overlayMax = Math.max(0, Math.min(1000, width - PADDING - HANDLES));
  const projectOverlay = overlay === 'project';
  const assistantOverlay = overlay === 'assistant';
  return {
    project: { visible: project || projectOverlay, overlay: projectOverlay, width: projectOverlay ? Math.min(Math.max(minimum.project, input.projectWidth), overlayMax) : left, max: projectOverlay ? overlayMax : cap('project', assistant) },
    assistant: { visible: assistant || assistantOverlay, overlay: assistantOverlay, width: assistantOverlay ? Math.min(Math.max(minimum.assistant, input.assistantWidth), overlayMax) : right, max: assistantOverlay ? overlayMax : cap('assistant', project) },
  };
}

/** Keep room for tabs, Markdown controls and editor lines before allocating terminal height. */
export function terminalHeightLimit(height: number): number {
  const editor = Math.min(200, Math.max(100, height * .45));
  return Math.max(0, Math.min(1000, height * .7, height - editor - 8));
}
