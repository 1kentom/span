export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
