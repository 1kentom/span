// One door for UI state kept in localStorage. Stored values outlive the code that wrote them, so every read
// validates the shape and falls back instead of throwing: a value in an old or broken shape must never stop the
// app from starting. A value that fails validation is removed, so the next run starts clean.

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** What a read needs. Without `removeItem` a rejected value is just ignored. */
type ReadableStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "removeItem">>;

/** Every key Span writes starts with one of these. "Reset interface state" clears exactly these keys. */
export const SPAN_STORAGE_PREFIXES = ["span.", "span:"] as const;

export const isSpanStorageKey = (key: string) => SPAN_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));

export function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the validated value stored as JSON under `key`, or `fallback`. `validate` returns the value to use (it may
 * repair or narrow the parsed value) or `undefined` when the shape is not acceptable. Unparseable or rejected values
 * are deleted. Storage that is missing or throws reads as `fallback` and is left alone.
 */
export function readStored<T>(key: string, validate: (value: unknown) => T | undefined, fallback: T, storage: ReadableStorage | undefined = browserStorage()): T {
  let raw: string | null;
  try {
    raw = storage ? storage.getItem(key) : null;
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  let result: T | undefined;
  try {
    result = validate(JSON.parse(raw));
  } catch {
    result = undefined;
  }
  if (result !== undefined) return result;
  try {
    storage?.removeItem?.(key);
  } catch {
    /* storage can be read only */
  }
  return fallback;
}

/** Stores `value` as JSON. Best effort: returns false when storage is unavailable or full. */
export function writeStored(key: string, value: unknown, storage: StorageLike | undefined = browserStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** A plain object (not null, not an array). */
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Validator for a record of records: keeps entries whose value passes `entry`, drops the rest. */
export function recordOf<T>(entry: (value: unknown) => T | undefined) {
  return (value: unknown): Record<string, T> | undefined => {
    if (!isRecord(value)) return undefined;
    const out: Record<string, T> = {};
    for (const [key, item] of Object.entries(value)) {
      const checked = entry(item);
      if (checked !== undefined) out[key] = checked;
    }
    return out;
  };
}

/** Validator for an array of strings: non string items are dropped. */
export const stringArray = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);

/** Validator for a record whose values are strings: other values are dropped. */
export const stringRecord = (value: unknown): Record<string, string> | undefined =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;

/** Removes every Span key (see SPAN_STORAGE_PREFIXES) and returns how many were removed. Settings files and chats are not in localStorage and stay. */
export function clearSpanStorage(storage: (StorageLike & Pick<Storage, "key" | "length">) | undefined = browserStorage() as Storage | undefined): number {
  if (!storage) return 0;
  let keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && isSpanStorageKey(key)) keys.push(key);
    }
  } catch {
    keys = [];
  }
  let removed = 0;
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      /* keep going: clear what can be cleared */
    }
  }
  return removed;
}

/** The names of the Span keys present, with anything after a path-carrying prefix redacted. For diagnostics only. */
export function spanStorageKeyNames(storage: Pick<Storage, "key" | "length"> | undefined = browserStorage() as Storage | undefined): string[] {
  const names = new Set<string>();
  try {
    for (let index = 0; storage && index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !isSpanStorageKey(key)) continue;
      // Keys such as span:run-selected:<folder> or span.agents.mode:<folder> carry a path after the first separator.
      names.add(key.replace(/^(span[.:][^:/\\]*?)[:/\\].*$/, "$1:<redacted>"));
    }
  } catch {
    /* diagnostics only */
  }
  return [...names].sort();
}
