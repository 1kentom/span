/** Selected interface artwork from the user-provided rounded linear Iconsax collection. */
export const menuIconAssets = {
  save: "save", discard: "discard", cancel: "cancel", cut: "cut", copy: "copy", duplicate: "copy",
  paste: "paste", path: "copy", file: "file", folder: "folder", trash: "trash", rename: "rename",
  install: "install",
  newFile: "new-file", newFolder: "new-folder", openFolder: "open-folder",
  search: "search", keyboard: "keyboard", filter: "filter", reset: "reset",
} as const;
export type MenuIconName = keyof typeof menuIconAssets;

const aliases: Record<string, string> = {
  path: "copy", Path: "copy", FolderRoute: "copy", "folder-route": "copy", FolderConnection: "copy",
  Copy: "copy", Trash: "trash", CloseCircle: "close-circle", TickCircle: "tick-circle",
  DocumentText: "file", Folder2: "folder", Edit2: "rename",
  "arrow-down4": "arrow-down4", "arrow-up3": "arrow-up3", "arrow-left4": "arrow-left4", "arrow-right4": "arrow-right4",
  ArrowDown: "arrow-down4", ArrowDown2: "arrow-down4", ArrowUp: "arrow-up3", ArrowRight: "arrow-right4",
};

export function iconAssetPath(name: string): string {
  const action = name.startsWith("menu-") ? menuIconAssets[name.slice(5) as MenuIconName] : undefined;
  const selected = action || aliases[name];
  if (selected) return `/icons/rounded-linear/${selected}.svg`;
  return /^[\w-]+$/.test(name) ? `/icons/${name}.svg` : "/icons/rounded-linear/file.svg";
}
