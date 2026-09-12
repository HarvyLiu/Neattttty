// Library persistence for Neattttty.
//
// The canvas toolbar's library button is the one and only library door:
// browsing, file import, and add-from-selection all happen in the editor's
// native panel. This store only keeps items across restarts: hydrated into
// the editor on mount, editor changes merged back via onLibraryChange.

import { openUrl } from "@tauri-apps/plugin-opener";

export interface LibraryStore {
  items: any[];
}

const KEY = "neattttty.libraries.v1";

const idsOf = (items: any[]): string[] =>
  (items ?? []).map((i) => String(i?.id ?? "")).filter(Boolean);

/** De-duplicate by id, keeping the first occurrence (self-heals old doubles). */
function dedupe(items: any[]): any[] {
  const seen = new Set<string>();
  return (items ?? []).filter((i) => {
    const id = String(i?.id ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function loadLibraryStore(): LibraryStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { items: [] };
    const s = JSON.parse(raw) as any;
    // Current shape {items} or legacy {items, sources}.
    const items = Array.isArray(s) ? s : (s?.items ?? []);
    if (!Array.isArray(items)) return { items: [] };
    return { items: dedupe(items) };
  } catch {
    return { items: [] };
  }
}

export function saveLibraryStore(s: LibraryStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function sigLibrary(items: any[]): string {
  return idsOf(items).sort().join(",");
}

/**
 * Merge editor-side items into the store (mirror semantics: the editor is
 * the source of truth for the item set). Returns [store, changed].
 */
export function syncFromEditor(store: LibraryStore, editorItems: any[]): [LibraryStore, boolean] {
  const incoming = dedupe((editorItems ?? []).filter((e) => e && typeof e.id === "string"));
  const prevSig = sigLibrary(store.items);
  if (sigLibrary(incoming) === prevSig && store.items.length === incoming.length) return [store, false];
  return [{ items: incoming }, true];
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* clipboard API unavailable — legacy fallback below */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    ta.remove();
  }
}

/**
 * Open a URL in the system browser (desktop) or a new tab (dev browser).
 * Returns how it went so callers can tell the user; never throws.
 */
export async function openExternal(url: string): Promise<"opened" | "copied" | "failed"> {
  try {
    await openUrl(url);
    return "opened";
  } catch {
    /* fall through to clipboard */
  }
  try {
    await copyText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
