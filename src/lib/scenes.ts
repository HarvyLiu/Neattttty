// Scene storage for Neattttty v1.
// localStorage-backed (works in browser + Tauri webview) with portable
// `.excalidraw` JSON import/export. Native ~/Neattttty file sync is a v2 step.

export interface SceneData {
  elements: any[];
  appState?: Record<string, any>;
  files?: Record<string, any>;
}

export interface SceneMeta {
  id: string;
  name: string;
  collection: string;
  updatedAt: number;
  data: SceneData;
}

export interface TrashedScene extends SceneMeta {
  deletedAt: number;
  restoreTo: string;
}

const SCENES_KEY = "neattttty.scenes.v1";
const TRASH_KEY = "neattttty.trash.v1";
const ACTIVE_KEY = "neattttty.active.v1";

export function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full — v1 keeps in-memory only then */
  }
}

export function loadScenes(): SceneMeta[] {
  const list = read<SceneMeta[]>(SCENES_KEY, []);
  if (list.length > 0) return list;
  const seed: SceneMeta = {
    id: uid(),
    name: "welcome",
    collection: "Work",
    updatedAt: Date.now(),
    data: { elements: [], files: {} },
  };
  write(SCENES_KEY, [seed]);
  return [seed];
}

export function saveScenes(scenes: SceneMeta[]): void {
  write(SCENES_KEY, scenes);
}

export function loadTrash(): TrashedScene[] {
  return read<TrashedScene[]>(TRASH_KEY, []);
}

export function saveTrash(trash: TrashedScene[]): void {
  write(TRASH_KEY, trash);
}

export function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function purgeExpiredTrash(trash: TrashedScene[], days = 30): TrashedScene[] {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return trash.filter((t) => t.deletedAt > cutoff);
}

/** Portable `.excalidraw` file format (same shape the OSS editor uses). */
export function toExcalidrawFile(scene: SceneMeta): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "neattttty/0.1.0",
      elements: scene.data.elements ?? [],
      appState: {
        viewBackgroundColor: "#ffffff",
        gridSize: null,
        ...(scene.data.appState ?? {}),
      },
      files: scene.data.files ?? {},
    },
    null,
    2,
  );
}

export function downloadText(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function parseImportedFile(file: File): Promise<SceneData> {
  const text = await file.text();
  const json = JSON.parse(text);
  const elements = Array.isArray(json)
    ? json
    : Array.isArray(json.elements)
      ? json.elements
      : [];
  return {
    elements,
    appState: json.appState ?? {},
    files: json.files ?? {},
  };
}
