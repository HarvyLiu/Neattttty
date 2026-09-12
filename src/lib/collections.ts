// Collections (folders) for Neattttty. One level, each scene in exactly one.
// Scenes reference folders by id (SceneMeta.collection). Older installs stored
// the folder NAME there — migrated to ids on load (see below).

import { loadScenes, saveScenes, uid, type SceneMeta } from "./scenes";

export interface Collection {
  id: string;
  name: string;
}

const KEY = "neattttty.collections.v1";
const COLLAPSED_KEY = "neattttty.collapsed.v1";

function readCols(): Collection[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Collection[]) : [];
    return Array.isArray(list)
      ? list.filter((c) => c && typeof c.id === "string" && typeof c.name === "string")
      : [];
  } catch {
    return [];
  }
}

export function loadCollections(): Collection[] {
  return readCols();
}

export function saveCollections(cols: Collection[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cols));
  } catch {
    /* ignore */
  }
}

/** First-run / legacy bootstrap: folders from stored scene labels, else "Work". */
export function initCollections(): Collection[] {
  const stored = readCols();
  if (stored.length > 0) return stored;
  const names = [...new Set(loadScenes().map((s) => (s.collection || "").trim()).filter(Boolean))];
  const cols = (names.length > 0 ? names : ["Work"]).map((name) => ({ id: uid(), name }));
  saveCollections(cols);
  return cols;
}

/** Rewrite legacy name-labels (or dangling ids) to live folder ids. Idempotent. */
export function migrateSceneFolders(list: SceneMeta[], cols: Collection[]): SceneMeta[] {
  const fallback = cols[0]?.id ?? "Work";
  const ids = new Set(cols.map((c) => c.id));
  const byName = new Map(cols.map((c) => [c.name, c.id]));
  let changed = false;
  const next = list.map((s) => {
    if (ids.has(s.collection)) return s;
    changed = true;
    return { ...s, collection: byName.get(s.collection) ?? fallback };
  });
  if (changed) saveScenes(next);
  return next;
}

export function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const v = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function saveCollapsed(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
