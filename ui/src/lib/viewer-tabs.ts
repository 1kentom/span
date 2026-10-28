/**
 * Workbench tabs that show an attachment in the shared file viewer. They are not workspace files:
 * the workbench never reads, saves, persists or sends them to a language server. The path carries
 * the attachment id and its display name, both URI encoded, so the tab label needs no lookup.
 */
export const VIEWER_TAB_PREFIX = "span:viewer:";

export const viewerTabPath = (id: string, name: string) => `${VIEWER_TAB_PREFIX}${encodeURIComponent(id)}/${encodeURIComponent(name)}`;

export const isViewerTab = (path: string) => path.startsWith(VIEWER_TAB_PREFIX);

function parts(path: string): [string, string] | undefined {
  if (!isViewerTab(path)) return undefined;
  const rest = path.slice(VIEWER_TAB_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  try { return [decodeURIComponent(rest.slice(0, slash)), decodeURIComponent(rest.slice(slash + 1))]; } catch { return undefined; }
}

export const viewerTabId = (path: string) => parts(path)?.[0];

export const viewerTabName = (path: string) => parts(path)?.[1] || "Attachment";
