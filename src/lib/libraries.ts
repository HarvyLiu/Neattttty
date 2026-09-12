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

/**
 * Deep-clone elements with fresh ids so a library item can be stamped onto
 * the canvas repeatedly without id collisions. Internal references
 * (container, frame, bindings) are remapped; groupIds are kept so the
 * stamped group stays grouped.
 */
export function cloneElementsFresh(elements: any[]): any[] {
  const idMap = new Map<string, string>();
  const freshId = (old: unknown) => {
    const k = String(old ?? "");
    if (!k) return k;
    let v = idMap.get(k);
    if (!v) {
      v = uid();
      idMap.set(k, v);
    }
    return v;
  };
  return (elements ?? []).map((e: any) => {
    const c: any = JSON.parse(JSON.stringify(e ?? {}));
    c.id = freshId(e?.id) || uid();
    if (e?.containerId != null) c.containerId = freshId(e.containerId);
    if (e?.frameId != null) c.frameId = freshId(e.frameId);
    if (Array.isArray(e?.boundElements)) {
      c.boundElements = e.boundElements.map((b: any) => ({ ...b, id: freshId(b?.id) }));
    }
    if (e?.startBinding) c.startBinding = { ...e.startBinding, elementId: freshId(e.startBinding.elementId) };
    if (e?.endBinding) c.endBinding = { ...e.endBinding, elementId: freshId(e.endBinding.elementId) };
    if (e?.start && typeof e.start === "object" && e.start?.id) c.start = { ...e.start, id: freshId(e.start.id) };
    if (e?.end && typeof e.end === "object" && e.end?.id) c.end = { ...e.end, id: freshId(e.end.id) };
    return c;
  });
}

export interface CanvasView {
  scrollX?: number;
  scrollY?: number;
  width?: number;
  height?: number;
  zoom?: number | { value?: number };
}

/**
 * Shift elements so their bounding-box center lands on the viewport center.
 * Stamps appear in front of the user; the camera never moves.
 */
export function centerElementsInView(elements: any[], view: CanvasView): any[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements ?? []) {
    if (typeof e?.x !== "number" || typeof e?.y !== "number") continue;
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + (e.width ?? 0));
    maxY = Math.max(maxY, e.y + (e.height ?? 0));
  }
  if (!isFinite(minX) || !isFinite(minY)) return elements;
  const z =
    typeof view?.zoom === "number" ? view.zoom : (view?.zoom?.value ?? 1) || 1;
  const vw = view?.width ?? 800;
  const vh = view?.height ?? 600;
  const cx = vw / 2 / z - (view?.scrollX ?? 0);
  const cy = vh / 2 / z - (view?.scrollY ?? 0);
  const dx = cx - (minX + maxX) / 2;
  const dy = cy - (minY + maxY) / 2;
  if (dx === 0 && dy === 0) return elements;
  return elements.map((e: any) => ({ ...e, x: (e?.x ?? 0) + dx, y: (e?.y ?? 0) + dy }));
}

/** Save canvas-selected elements as a Personal library item. */
export function addPersonalItem(store: LibraryStore, elements: any[]): LibraryStore {
  const snap = JSON.parse(JSON.stringify(elements ?? []));
  const item = { id: uid(), status: "unpublished", created: Date.now(), elements: snap };
  const sources = withPersonal(store).sources.map((s) =>
    s.id === PERSONAL_ID ? { ...s, itemIds: [...s.itemIds, item.id] } : s,
  );
  return { items: [...store.items, item], sources };
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
