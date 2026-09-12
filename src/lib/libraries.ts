// Library packs for Neattttty (import-only).
//
// Items live in the editor's native Library panel (search, Personal section,
// published section, click-to-insert, add-from-selection). This store is the
// cross-restart source of truth, synced both ways: hydrated into the editor
// on mount, editor changes merged back via onLibraryChange. Imports preserve
// publisher status, so installed packs show under the panel's published
// section while your own additions stay Personal.

import { loadSceneOrLibraryFromBlob, restoreLibraryItems } from "@excalidraw/excalidraw";
import { uid } from "./scenes";

export interface LibrarySource {
  id: string;
  name: string;
  kind: "file" | "link" | "local";
  addedAt: number;
  itemIds: string[];
}

export interface LibraryStore {
  items: any[];
  sources: LibrarySource[];
}

export const PERSONAL_ID = "personal";
const KEY = "neattttty.libraries.v1";
const LIB_URL_KEY = "neattttty.libraryUrl.v1";
export const LIBRARIES_SITE = "https://libraries.excalidraw.com/";

function blank(): LibraryStore {
  return { items: [], sources: [] };
}

function withPersonal(s: LibraryStore): LibraryStore {
  if (s.sources.some((x) => x.id === PERSONAL_ID)) return s;
  return {
    ...s,
    sources: [
      { id: PERSONAL_ID, name: "Personal", kind: "local", addedAt: Date.now(), itemIds: [] },
      ...s.sources,
    ],
  };
}

export function loadLibraryStore(): LibraryStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return withPersonal(blank());
    const s = JSON.parse(raw) as LibraryStore;
    if (!s || !Array.isArray(s.items) || !Array.isArray(s.sources)) return withPersonal(blank());
    return withPersonal(s);
  } catch {
    return withPersonal(blank());
  }
}

export function saveLibraryStore(s: LibraryStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const idsOf = (items: any[]): string[] =>
  (items ?? []).map((i) => String(i?.id ?? "")).filter(Boolean);

export function sigLibrary(items: any[]): string {
  return idsOf(items).sort().join(",");
}

/**
 * Merge editor-side items into the store (mirror semantics: the editor is
 * the source of truth for the item set). Unknown ids join Personal; ids
 * deleted in the panel leave the store. Returns [store, changed].
 */
export function syncFromEditor(store: LibraryStore, editorItems: any[]): [LibraryStore, boolean] {
  const incoming = (editorItems ?? []).filter((e) => e && typeof e.id === "string");
  const known = new Set(idsOf(store.items));
  const fresh = incoming.filter((e) => !known.has(String(e.id)));
  const present = new Set(idsOf(incoming));
  const changed =
    fresh.length > 0 ||
    store.items.length !== incoming.length ||
    store.items.some((e) => !present.has(String(e?.id)));
  if (!changed) return [store, false];
  const sources = withPersonal(store).sources.map((s) => {
    const kept = s.itemIds.filter((id) => present.has(id));
    return s.id === PERSONAL_ID
      ? { ...s, itemIds: [...kept, ...fresh.map((f) => String(f.id))] }
      : { ...s, itemIds: kept };
  });
  return [{ items: incoming, sources }, true];
}

export function addLibraryItems(
  store: LibraryStore,
  name: string,
  kind: LibrarySource["kind"],
  items: any[],
): LibraryStore {
  const withIds = items.map((it) =>
    it && typeof it.id === "string" && it.id ? it : { ...(it ?? {}), id: uid() },
  );
  const src: LibrarySource = {
    id: uid(),
    name,
    kind,
    addedAt: Date.now(),
    itemIds: idsOf(withIds),
  };
  return { items: [...store.items, ...withIds], sources: [...store.sources, src] };
}

export function removeLibrarySource(store: LibraryStore, id: string): LibraryStore {
  if (id === PERSONAL_ID) return store;
  const src = store.sources.find((s) => s.id === id);
  if (!src) return store;
  const drop = new Set(src.itemIds);
  return {
    items: store.items.filter((i) => !drop.has(String(i?.id))),
    sources: store.sources.filter((s) => s.id !== id),
  };
}

export async function importLibraryFile(file: File): Promise<any[]> {
  const contents = (await loadSceneOrLibraryFromBlob(file, null, null)) as any;
  const raw = contents?.data?.libraryItems ?? contents?.data?.library;
  if (contents?.type !== "excalidrawlib" && !Array.isArray(raw)) {
    throw new Error("That file is not an .excalidrawlib library");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("No library items in that file");
  }
  return restoreLibraryItems(raw, "unpublished");
}

export function parseAddLibraryLink(input: string): { libraryUrl: string; host: string } {
  const m = input.match(/#addLibrary=([^,\s&]+)/);
  if (!m) throw new Error("Not an excalidraw #addLibrary link (looks like …#addLibrary=<url>)");
  let libraryUrl = m[1];
  try {
    libraryUrl = decodeURIComponent(libraryUrl);
  } catch {
    /* use raw */
  }
  let u: URL;
  try {
    u = new URL(libraryUrl);
  } catch {
    throw new Error("Bad library URL in that link");
  }
  if (u.protocol !== "https:") throw new Error("Library URL must be https");
  return { libraryUrl, host: u.hostname };
}

export async function importLibraryFromUrl(libraryUrl: string): Promise<any[]> {
  let res: Response;
  try {
    res = await fetch(libraryUrl, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Download blocked — download the .excalidrawlib file and import it instead");
  }
  if (!res.ok) {
    throw new Error(
      `Download failed (HTTP ${res.status}) — download the .excalidrawlib file and import it instead`,
    );
  }
  const json = (await res.json()) as any;
  const raw = json?.libraryItems ?? (Array.isArray(json) ? json : null);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("No library items at that URL — download the .excalidrawlib file and import it instead");
  }
  return restoreLibraryItems(raw, "unpublished");
}

export function loadLibraryUrl(): string {
  try {
    return localStorage.getItem(LIB_URL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveLibraryUrl(v: string): void {
  try {
    localStorage.setItem(LIB_URL_KEY, v);
  } catch {
    /* ignore */
  }
}

/** Open a URL in the system browser (desktop) or a new tab (dev browser). */
export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
