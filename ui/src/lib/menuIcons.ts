/** Selected interface artwork from the user-provided rounded linear Iconsax collection. */
export const menuIconAssets = {
  save: "save", discard: "discard", cancel: "cancel", cut: "cut", copy: "copy", duplicate: "copy",
  paste: "paste", path: "copy", file: "file", folder: "folder", trash: "trash", rename: "rename",
  newFolder: "new-folder", openFolder: "open-folder",
  search: "search", keyboard: "keyboard", filter: "filter", reset: "reset",
} as const;
/** Owner-chosen rounded outline glyphs, vendored as top-level icons (see public/icons/status-provenance.json). */
export const outlineMenuAssets = { install: "ActionDownload", newFile: "ActionNewFile" } as const;
export type MenuIconName = keyof typeof menuIconAssets | keyof typeof outlineMenuAssets;

const aliases: Record<string, string> = {
  path: "copy", Path: "copy", FolderRoute: "copy", "folder-route": "copy", FolderConnection: "copy",
  Copy: "copy", Trash: "trash", CloseCircle: "close-circle", TickCircle: "tick-circle",
  DocumentText: "file", Folder2: "folder", Edit2: "rename",
  "arrow-down4": "arrow-down4", "arrow-up3": "arrow-up3", "arrow-left4": "arrow-left4", "arrow-right4": "arrow-right4",
  ArrowDown: "arrow-down4", ArrowDown2: "arrow-down4", ArrowUp: "arrow-up3", ArrowRight: "arrow-right4",
};

export function iconAssetPath(name: string): string {
  const key = name.startsWith("menu-") ? name.slice(5) : "";
  if (Object.hasOwn(outlineMenuAssets, key)) return `/icons/${outlineMenuAssets[key as keyof typeof outlineMenuAssets]}.svg`;
  const action = key ? menuIconAssets[key as keyof typeof menuIconAssets] : undefined;
  const selected = action || aliases[name];
  if (selected) return `/icons/rounded-linear/${selected}.svg`;
  return /^[\w-]+$/.test(name) ? `/icons/${name}.svg` : "/icons/rounded-linear/file.svg";
}
