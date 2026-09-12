import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  Bot,
  Brush,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  FileText,
  FileUp,
  Folder,
  FolderPlus,
  LayoutDashboard,
  Menu,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  Presentation,
  Save,
  SendHorizontal,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";
import {
  downloadText,
  loadActiveId,
  loadScenes,
  loadTrash,
  parseImportedFile,
  purgeExpiredTrash,
  saveActiveId,
  saveScenes,
  saveTrash,
  toExcalidrawFile,
  uid,
  type SceneMeta,
  type TrashedScene,
} from "./lib/scenes";
import {
  initCollections,
  loadCollapsed,
  migrateSceneFolders,
  saveCollapsed,
  saveCollections,
  type Collection,
} from "./lib/collections";
import ContextMenu, { type CtxItem } from "./components/ContextMenu";
import {
  copyText,
  loadLibraryStore,
  saveLibraryStore,
  sigLibrary,
  syncFromEditor,
  type LibraryStore,
} from "./lib/libraries";
import { AI_DEFAULTS, generateMermaid, generateWireframe, mermaidToScene, shiftScene, type AIConfig, type AIKind, type MermaidScene } from "./lib/ai";
import { downloadPptx, listFrames, svgForElements } from "./lib/exporters";

type Flavor = "latte" | "frappe" | "macchiato" | "mocha";
const FLAVORS: Flavor[] = ["latte", "frappe", "macchiato", "mocha"];

const AI_STORE_KEY = "neattttty.ai.v1";
const FLAVOR_KEY = "neattttty.flavor";
const BRUSH_KEY = "neattttty.brush.v2";

function loadAI(): AIConfig {  try {
    const raw = localStorage.getItem(AI_STORE_KEY);
    if (raw) return { ...defaultAI(), ...(JSON.parse(raw) as Partial<AIConfig>) };
  } catch {
    /* ignore */
  }
  return defaultAI();
}

function defaultAI(): AIConfig {
  return {
    kind: "ollama",
    model: AI_DEFAULTS.ollama.model,
    baseUrl: AI_DEFAULTS.ollama.baseUrl,
    apiKey: "",
    apiStyle: "chat",
  };
}

const KIND_LABELS: Record<AIKind, string> = {
  ollama: "ollama",
  "local-openai": "local",
  openai: "openai",
  openrouter: "openrouter",
  anthropic: "anthropic",
  gemini: "gemini",
  "opencode-zen": "zen",
  custom: "custom",
};

/**
 * Cheap content signature for a scene snapshot.
 * Excalidraw re-fires onChange after parent re-renders even when nothing
 * changed — accepting every notification into state loops forever
 * (React #185). onChange always delivers the FULL elements array, so
 * skipping an identical notification is lossless: the next real edit
 * carries complete content.
 */
function sigFor(elements: any[], files: any, bg: unknown): string {
  let v = 0;
  let vn = 0;
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    v += e?.version ?? 0;
    if (typeof e?.versionNonce === "number") vn = (vn + e.versionNonce) | 0;
  }
  const fk = files ? Object.keys(files).length : 0;
  return `${elements.length}|${v}|${vn}|${fk}|${bg ?? ""}`;
}

/** Brush pressure default, styled like the editor's own properties panel.
 *  Rendered contextually (see appbar tool options). Sets the default for NEW
 *  strokes; per-stroke retouching still lives in the canvas Pressure row. */
function BrushSeg({ constant, onPick }: { constant: boolean; onPick: (v: boolean) => void }) {
  return (
    <div className="brush-seg compact">
      <button
        className={constant ? "" : "on"}
        onClick={() => onPick(false)}
        title="Simulated pressure (variable width)"
        aria-pressed={!constant}
      >
        <svg width="24" height="14" viewBox="0 0 26 16" fill="none" aria-hidden="true">
          <path
            d="M2 11 C 5 4, 8 4, 10.5 10 S 15 16, 17.5 9 S 22 5, 24 10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        className={constant ? "on" : ""}
        onClick={() => onPick(true)}
        title="Constant width (no pressure)"
        aria-pressed={constant}
      >
        <svg width="24" height="14" viewBox="0 0 26 16" fill="none" aria-hidden="true">
          <path d="M3 8 H23" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export default function App() {
  const [collections, setCollections] = useState<Collection[]>(initCollections);
  const [scenes, setScenes] = useState<SceneMeta[]>(() =>
    migrateSceneFolders(purgeCheck(loadScenes()), collections),
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const [libStore, setLibStore] = useState<LibraryStore>(loadLibraryStore);
  const libSigRef = useRef<string>(sigLibrary(libStore.items));
  const [trash, setTrash] = useState<TrashedScene[]>(() => purgeExpiredTrash(loadTrash()));
  const [activeId, setActiveId] = useState<string>(() => {
    const saved = loadActiveId();
    return saved ?? "";
  });
  const [flavor, setFlavor] = useState<Flavor>(() => {
    const f = localStorage.getItem(FLAVOR_KEY);
    return FLAVORS.includes(f as Flavor) ? (f as Flavor) : "mocha";
  });
  const [railOpen, setRailOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTab, setAiTab] = useState<"generate" | "mermaid" | "wireframe">("generate");
  const [wfBusy, setWfBusy] = useState(false);
  const [wfSnap, setWfSnap] = useState<{ dataUrl: string; count: number; whole: boolean; els: any[] } | null>(null);
  const [wfHtml, setWfHtml] = useState("");
  const [wfView, setWfView] = useState<"preview" | "code">("preview");
  const [wfInstructions, setWfInstructions] = useState("");
  const [chat, setChat] = useState<Array<{ role: "user" | "assistant"; text: string; time: string }>>([]);
  const [draftMermaid, setDraftMermaid] = useState("");
  const [mermaidTabCode, setMermaidTabCode] = useState("");
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const previewSceneRef = useRef<MermaidScene | null>(null);
  const [aiCfg, setAiCfg] = useState<AIConfig>(loadAI);
  const [presenting, setPresenting] = useState(false);
  const [presentIdx, setPresentIdx] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  /** Optional constant-width brush (no pressure simulation) for new strokes.
   *  Off by default = stock editor behavior; drawings are never touched
   *  mid-gesture, flattening happens once the stroke is finished. */
  const [constantBrush, setConstantBrush] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BRUSH_KEY) === "constant";
    } catch {
      return false;
    }
  });

  const apiRef = useRef<any>(null);
  const activeIdRef = useRef(activeId);
  const toastTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  /** Last persisted signature per scene — breaks onChange echo loops. */
  const sceneSigRef = useRef<Record<string, string>>({});
  /** Pressure strokes already flattened to constant — never touch again. */
  const flattenedRef = useRef<Set<string>>(new Set());
  const constantBrushRef = useRef(constantBrush);
  constantBrushRef.current = constantBrush;

  const active = scenes.find((s) => s.id === activeId) ?? scenes[0];
  const activeIdSafe = active?.id ?? "";
  activeIdRef.current = activeIdSafe;

  const frames = useMemo(() => listFrames(active?.data.elements ?? []), [active]);
  const isTauri = typeof (window as any).__TAURI__ !== "undefined";

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const pickBrush = useCallback(
    (constant: boolean) => {
      setConstantBrush(constant);
      try {
        localStorage.setItem(BRUSH_KEY, constant ? "constant" : "pressure");
      } catch {
        /* ignore */
      }
      showToast(constant ? "Brush: constant width (no pressure)" : "Brush: pressure simulation on");
    },
    [showToast],
  );

  const [activeTool, setActiveTool] = useState<string>("selection");
  const activeToolRef = useRef("selection");
  const syncTool = useCallback((t: unknown) => {
    if (typeof t === "string" && t && activeToolRef.current !== t) {
      activeToolRef.current = t;
      setActiveTool(t);
    }
  }, []);

  // Freedraw tool detection: best-effort poll for tool switches
  // onChange doesn't report. Read-only, never writes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      try {
        syncTool(apiRef.current?.getAppState?.()?.activeTool?.type);
      } catch {
        /* editor not ready */
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [syncTool]);

  // Persist (debounced by nature of effect batching on edits)
  useEffect(() => {
    const t = window.setTimeout(() => saveScenes(scenes), 400);
    return () => window.clearTimeout(t);
  }, [scenes]);
  useEffect(() => {
    const t = window.setTimeout(() => saveTrash(trash), 400);
    return () => window.clearTimeout(t);
  }, [trash]);
  useEffect(() => {
    const t = window.setTimeout(() => saveCollections(collections), 400);
    return () => window.clearTimeout(t);
  }, [collections]);
  useEffect(() => {
    const t = window.setTimeout(() => saveCollapsed(collapsed), 400);
    return () => window.clearTimeout(t);
  }, [collapsed]);
  useEffect(() => {
    const t = window.setTimeout(() => saveLibraryStore(libStore), 400);
    return () => window.clearTimeout(t);
  }, [libStore]);
  useEffect(() => {
    document.documentElement.dataset.flavor = flavor;
    try {
      localStorage.setItem(FLAVOR_KEY, flavor);
    } catch {
      /* ignore */
    }
  }, [flavor]);
  useEffect(() => {
    try {
      localStorage.setItem(AI_STORE_KEY, JSON.stringify(aiCfg));
    } catch {
      /* ignore */
    }
  }, [aiCfg]);

  function purgeCheck(list: SceneMeta[]): SceneMeta[] {
    return list;
  }

  const switchScene = (id: string) => {
    setActiveId(id);
    saveActiveId(id);
    setMenuOpen(false);
    setDashOpen(false);
  };

  const fallbackId = collections[0]?.id ?? "Work";
  const collName = (id: string) => collections.find((c) => c.id === id)?.name ?? id;

  const createScene = (collectionId: string = fallbackId) => {
    const s: SceneMeta = {
      id: uid(),
      name: `untitled-${scenes.length + 1}`,
      collection: collectionId,
      updatedAt: Date.now(),
      data: { elements: [], files: {} },
    };
    setScenes((prev) => [s, ...prev]);
    switchScene(s.id);
    showToast(`New scene in ${collName(collectionId)} — saved locally`);
  };

  const createCollection = () => {
    const input = window.prompt("New folder name:", `Folder ${collections.length + 1}`);
    if (input === null) return;
    const name = input.trim();
    if (!name) {
      showToast("Folder name can't be empty");
      return;
    }
    if (collections.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      showToast(`Folder "${name}" already exists`);
      return;
    }
    const c: Collection = { id: uid(), name };
    setCollections((prev) => [...prev, c]);
    setCollapsed((prev) => ({ ...prev, [c.id]: false }));
    showToast(`Folder "${name}" created`);
  };

  const handleLibraryChange = (items: any) => {
    const [next, changed] = syncFromEditor(libStore, items);
    if (!changed) return;
    libSigRef.current = sigLibrary(next.items);
    setLibStore(next);
  };

  /** Parse files into scenes inside a folder. Skips unreadable files with a summary. */
  const importManyFiles = async (files: File[], folderId: string): Promise<void> => {
    const made: SceneMeta[] = [];
    let skipped = 0;
    for (const f of files) {
      try {
        const data = await parseImportedFile(f);
        made.push({
          id: uid(),
          name: f.name.replace(/\.excalidraw$|\.json$/i, "") || "imported",
          collection: folderId,
          updatedAt: Date.now(),
          data,
        });
      } catch {
        skipped += 1;
      }
    }
    if (made.length === 0) {
      showToast("Could not read any of those files as .excalidraw JSON");
      return;
    }
    setScenes((prev) => [...made, ...prev]);
    switchScene(made[0].id);
    showToast(
      `Imported ${made.length} scene(s) into "${collName(folderId)}"${skipped > 0 ? `, skipped ${skipped}` : ""}`,
    );
  };
  /** Get-or-create a folder by name (no prompt). Returns its id. */
  const ensureCollection = (rawName: string): string => {
    const name = rawName.trim() || "Imported";
    const hit = collections.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    const c: Collection = { id: uid(), name };
    setCollections((prev) => [...prev, c]);
    setCollapsed((prev) => ({ ...prev, [c.id]: false }));
    return c.id;
  };

  const renameCollection = (id: string) => {
    const cur = collections.find((c) => c.id === id);
    if (!cur) return;
    const name = window.prompt("Rename folder:", cur.name)?.trim();
    if (!name || name === cur.name) return;
    if (collections.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) {
      showToast(`Folder "${name}" already exists`);
      return;
    }
    setCollections((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
  };

  const deleteCollection = (id: string) => {
    const cur = collections.find((c) => c.id === id);
    if (!cur) return;
    if (collections.length <= 1) {
      showToast("Keep at least one folder");
      return;
    }
    const contained = scenes.filter((s) => s.collection === id).length;
    if (
      !window.confirm(
        `Delete folder "${cur.name}"?${contained > 0 ? ` ${contained} scene(s) move to another folder.` : ""}`,
      )
    )
      return;
    const rest = collections.filter((c) => c.id !== id);
    const target = rest[0].id;
    setScenes((prev) =>
      prev.map((s) => (s.collection === id ? { ...s, collection: target, updatedAt: Date.now() } : s)),
    );
    setTrash((prev) => prev.map((t) => (t.restoreTo === id ? { ...t, restoreTo: target } : t)));
    setCollections(rest);
    setCollapsed((prev) => {
      const v = { ...prev };
      delete v[id];
      return v;
    });
    showToast(`Deleted folder "${cur.name}"`);
  };

  const moveScene = (sceneId: string, collectionId: string) => {
    const scene = scenes.find((s) => s.id === sceneId);
    const folder = collections.find((c) => c.id === collectionId);
    if (!scene || !folder || scene.collection === collectionId) return;
    setScenes((prev) =>
      prev.map((s) => (s.id === sceneId ? { ...s, collection: collectionId, updatedAt: Date.now() } : s)),
    );
    showToast(`Moved "${scene.name}" → ${folder.name}`);
  };

  /** Minimal shape we need from a contextmenu event (matches React's synthetic event). */
  interface CtxEvent {
    clientX: number;
    clientY: number;
    preventDefault(): void;
    stopPropagation(): void;
  }
  const openCtx = (e: CtxEvent, items: CtxItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, items });
  };
  const sceneCtx = (s: SceneMeta): CtxItem[] => {
    const others = collections.filter((c) => c.id !== s.collection);
    return [
      { label: "Open", action: () => switchScene(s.id) },
      others.length > 0
        ? {
            label: "Move to",
            children: others.map((c) => ({ label: c.name, action: () => moveScene(s.id, c.id) })),
          }
        : { label: "Move to", disabled: true },
      { label: "Duplicate", action: () => duplicateScene(s.id) },
      { label: "Delete", danger: true, action: () => trashScene(s.id) },
    ];
  };
  const folderCtx = (c: Collection): CtxItem[] => [
    { label: "New scene here", action: () => createScene(c.id) },
    { label: "Rename folder", action: () => renameCollection(c.id) },
    { label: "Delete folder", danger: true, action: () => deleteCollection(c.id) },
  ];

  const duplicateScene = (id: string) => {
    const src = scenes.find((s) => s.id === id);
    if (!src) return;
    const copy: SceneMeta = {
      ...src,
      id: uid(),
      name: `${src.name}-copy`,
      updatedAt: Date.now(),
      data: JSON.parse(JSON.stringify(src.data)),
    };
    setScenes((prev) => [copy, ...prev]);
    switchScene(copy.id);
  };

  const trashScene = (id: string) => {
    const src = scenes.find((s) => s.id === id);
    if (!src) return;
    if (scenes.length <= 1) {
      showToast("Keep at least one scene — duplicate first");
      return;
    }
    setTrash((prev) => [{ ...src, deletedAt: Date.now(), restoreTo: src.collection }, ...prev]);
    const rest = scenes.filter((s) => s.id !== id);
    setScenes(rest);
    switchScene(rest[0].id);
    showToast("Moved to trash (30-day restore)");
  };

  const handleChange = useCallback((elements: any, appState: any, files: any) => {
    const id = activeIdRef.current;
    const els: any[] = elements ?? [];
    syncTool(appState?.activeTool?.type);
    const bg = appState?.viewBackgroundColor;
    const sig = sigFor(els, files, bg);
    if (sceneSigRef.current[id] === sig) return; // echo, not an edit
    sceneSigRef.current[id] = sig;
    setScenes((prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              updatedAt: Date.now(),
              data: {
                elements: [...els],
                files: { ...(files ?? {}) },
                appState: { viewBackgroundColor: bg },
              },
            }
          : s,
      ),
    );
  }, [syncTool]);

  // Constant-brush option: flatten previously committed pressure strokes.
  // Runs at pointer-down (and when the option is switched on). Never touches
  // the stroke of the current gesture: a fresh stroke starts with a single
  // point, and only strokes with 2+ points are eligible. Strokes the user
  // retouches in the canvas Pressure panel afterwards are recorded as
  // flattened and left alone.
  const flushConstantBrush = useCallback(() => {
    if (!constantBrushRef.current) return;
    const api = apiRef.current;
    const els: any[] = api?.getSceneElements?.() ?? [];
    if (els.length === 0) return;
    const flat = flattenedRef.current;
    let changed = false;
    const next = els.map((e: any) => {
      if (e?.type !== "freedraw" || !e.simulatePressure || flat.has(e.id)) return e;
      if ((e.points?.length ?? 0) < 2) return e;
      flat.add(e.id);
      changed = true;
      return {
        ...e,
        simulatePressure: false,
        version: (e.version ?? 0) + 1,
        versionNonce: (Math.random() * 2147483647) | 0,
      };
    });
    if (changed) {
      try {
        api?.updateScene?.({ elements: next });
      } catch {
        /* ignore — stroke stays as drawn */
      }
    }
  }, []);

  useEffect(() => {
    if (constantBrush) flushConstantBrush();
  }, [constantBrush, flushConstantBrush]);

  // Prime the signature baseline whenever the active scene changes, so the
  // mount-time onChange (scene normalization echo) is skipped, not stored.
  useEffect(() => {
    const s = scenes.find((x) => x.id === activeIdSafe);
    if (s) {
      sceneSigRef.current[activeIdSafe] = sigFor(
        s.data.elements ?? [],
        s.data.files,
        s.data.appState?.viewBackgroundColor,
      );
      flattenedRef.current = new Set();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdSafe]);

  const stamp = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const buildPreview = async (code: string) => {
    setPreviewError(null);
    setPreviewSvg(null);
    previewSceneRef.current = null;
    const scene = await mermaidToScene(code);
    const svg = await svgForElements(scene.elements, scene.files);
    previewSceneRef.current = scene;
    setDraftMermaid(scene.mermaid);
    setPreviewSvg(svg);
    setShowCode(false);
  };

  const runAiPrompt = async (prompt: string) => {
    const clean = prompt.trim();
    if (!clean || aiBusy) return;
    setAiOpen(true);
    setAiTab("generate");
    setAiBusy(true);
    setChat((prev) => [...prev, { role: "user", text: clean, time: stamp() }]);
    setAiPrompt("");
    try {
      const code = await generateMermaid(aiCfg, clean);
      setChat((prev) => [...prev, { role: "assistant", text: code, time: stamp() }]);
      await buildPreview(code);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (aiCfg.kind === "ollama" && /failed|fetch|network|unreachable/i.test(msg)) {
        showToast("Ollama not reachable — run `ollama serve` or switch model to BYOK");
      } else {
        showToast(msg);
      }
    } finally {
      setAiBusy(false);
    }
  };

  const refreshPreview = async () => {
    if (aiBusy || !draftMermaid.trim()) return;
    setAiBusy(true);
    try {
      await buildPreview(draftMermaid);
    } catch (err: any) {
      setPreviewError(err?.message ?? String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const previewPastedMermaid = async () => {
    if (aiBusy || !mermaidTabCode.trim()) return;
    setAiBusy(true);
    try {
      await buildPreview(mermaidTabCode);
    } catch (err: any) {
      setPreviewError(err?.message ?? String(err));
      showToast(err?.message ?? String(err));
    } finally {
      setAiBusy(false);
    }
  };

  /** Snapshot selection (or whole scene) as a downscaled JPEG data URL. */
  const captureWireframe = async () => {
    const els: any[] = apiRef.current?.getSceneElements?.() ?? active?.data.elements ?? [];
    let ids: Record<string, boolean> = {};
    try {
      ids = apiRef.current?.getAppState?.()?.selectedElementIds ?? {};
    } catch {
      /* ignore */
    }
    const sel = els.filter((e) => ids[e?.id] && !e?.isDeleted);
    const use = sel.length > 0 ? sel : els.filter((e) => !e?.isDeleted);
    if (use.length === 0) {
      showToast("Draw a wireframe first");
      return null;
    }
    const { exportToCanvas } = await import("@excalidraw/excalidraw");
    const canvas = await (exportToCanvas as any)({
      elements: use,
      appState: { viewBackgroundColor: "#ffffff" },
      files: active?.data.files ?? {},
    });
    const scale = Math.min(1, 1536 / Math.max(canvas.width, canvas.height));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(canvas.width * scale));
    out.height = Math.max(1, Math.round(canvas.height * scale));
    const g = out.getContext("2d");
    if (!g) throw new Error("Could not rasterize the canvas");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0, out.width, out.height);
    return { dataUrl: out.toDataURL("image/jpeg", 0.85), count: use.length, whole: sel.length === 0, els: use };
  };

  const runWireframe = async () => {
    if (wfBusy) return;
    setWfBusy(true);
    try {
      let snap = wfSnap;
      if (!snap) {
        const cap = await captureWireframe();
        if (!cap) return;
        snap = cap;
        setWfSnap(snap);
      }
      const html = await generateWireframe(aiCfg, snap.dataUrl, wfInstructions);
      setWfHtml(html);
      setWfView("preview");
    } catch (err: any) {
      showToast(err?.message ?? String(err));
    } finally {
      setWfBusy(false);
    }
  };

  const copyWireframe = async () => {
    if (!wfHtml) return;
    try {
      await copyText(wfHtml);
      showToast("Code copied");
    } catch {
      showToast("Could not copy");
    }
  };

  /** Insert the generated page as a live preview frame right of the source. */
  const insertWireframe = async () => {
    if (!wfHtml) {
      showToast("Generate code first");
      return;
    }
    try {
      const { restoreElements } = await import("@excalidraw/excalidraw");
      const src: any[] = wfSnap?.els ?? [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      for (const e of src) {
        if (typeof e?.x !== "number" || typeof e?.y !== "number") continue;
        minX = Math.min(minX, e.x);
        minY = Math.min(minY, e.y);
        if (typeof e?.width === "number") maxX = Math.max(maxX, e.x + e.width);
      }
      const W = 880;
      const H = 620;
      const partial = {
        id: uid(),
        type: "frame",
        name: "AI Frame",
        x: isFinite(maxX) ? maxX + 80 : 80,
        y: isFinite(minY) ? minY : 80,
        width: W,
        height: H,
        customData: { generationData: { status: "done", html: wfHtml } },
      };
      const restored = (restoreElements as any)([partial], null) as any[];
      if (!Array.isArray(restored) || restored.length === 0) throw new Error("Could not build the frame");
      const cur: any[] = apiRef.current?.getSceneElements?.() ?? active?.data.elements ?? [];
      apiRef.current?.updateScene?.({ elements: [...cur, ...restored] });
      setAiOpen(false);
      showToast("Inserted live preview frame — resize it to test responsiveness");
    } catch (err: any) {
      showToast(err?.message ?? String(err));
    }
  };

  const insertPreview = () => {
    const scene = previewSceneRef.current;
    if (!scene || scene.elements.length === 0) {
      showToast("Nothing to insert — generate or preview first");
      return;
    }
    const cur: any[] = apiRef.current?.getSceneElements?.() ?? active?.data.elements ?? [];
    let maxX = -Infinity;
    for (const e of cur) {
      if (typeof e?.x === "number" && typeof e?.width === "number") maxX = Math.max(maxX, e.x + e.width);
    }
    const shifted = shiftScene(scene.elements, isFinite(maxX) ? maxX + 120 : 120);
    try {
      apiRef.current?.updateScene?.({ elements: [...cur, ...shifted] });
    } catch (err: any) {
      showToast(String(err?.message ?? err));
      return;
    }
    setAiOpen(false);
    showToast(`Inserted ${shifted.length} editable elements — drag them anywhere`);
  };

  const newAiChat = () => {
    setChat([]);
    setDraftMermaid("");
    setPreviewSvg(null);
    setPreviewError(null);
    previewSceneRef.current = null;
  };

  const goToFrame = (idx: number) => {
    const f = frames[idx];
    if (!f) return;
    setPresentIdx(idx);
    const els: any[] = active?.data.elements ?? [];
    const target = els.filter((e: any) => e.id === f.id || e.frameId === f.id);
    try {
      apiRef.current?.scrollToContent?.(target.length > 0 ? target : els, { fitToContent: true });
    } catch {
      /* older API — ignore */
    }
  };

  const startPresent = () => {
    if (frames.length === 0) {
      showToast("Add a Frame (▦ tool) to make slides first");
      return;
    }
    setPresentIdx(0);
    setPresenting(true);
    try {
      void document.documentElement.requestFullscreen?.();
    } catch {
      /* ignore */
    }
    window.setTimeout(() => goToFrame(0), 60);
  };

  const stopPresent = () => {
    setPresenting(false);
    try {
      if (document.fullscreenElement) void document.exitFullscreen?.();
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        goToFrame(Math.min(presentIdx + 1, frames.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goToFrame(Math.max(presentIdx - 1, 0));
      } else if (e.key === "Escape") {
        stopPresent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting, presentIdx, frames, activeIdSafe]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Flush the live canvas into the mirror first, so the save holds
        // exactly what's on screen — never a stale echo.
        let next = scenes;
        try {
          const els = apiRef.current?.getSceneElements?.();
          if (Array.isArray(els)) {
            let bg: unknown;
            try {
              bg = apiRef.current?.getAppState?.()?.viewBackgroundColor;
            } catch {
              bg = undefined;
            }
            const id = activeIdRef.current;
            sceneSigRef.current[id] = sigFor(
              els,
              active?.data.files,
              bg ?? active?.data.appState?.viewBackgroundColor,
            );
            next = scenes.map((s) =>
              s.id === id
                ? {
                    ...s,
                    data: {
                      ...s.data,
                      elements: [...els],
                      ...(bg !== undefined
                        ? { appState: { ...(s.data.appState ?? {}), viewBackgroundColor: bg } }
                        : null),
                    },
                  }
                : s,
            );
            setScenes(next);
          }
        } catch {
          /* fall back to the mirror as-is */
        }
        saveScenes(next);
        showToast("Saved ✓ (local)");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenes, showToast, active]);

  const exportPdf = async () => {
    try {
      const { exportToCanvas } = await import("@excalidraw/excalidraw");
      const canvas = await (exportToCanvas as any)({
        elements: active?.data.elements ?? [],
        appState: { viewBackgroundColor: "#ffffff" },
        files: active?.data.files ?? {},
      });
      const url = canvas.toDataURL("image/png");
      const w = window.open("", "_blank", "width=1000,height=750");
      if (!w) throw new Error("popup-blocked");
      w.document.write(
        `<html><head><title>${active?.name ?? "neattttty"}</title></head><body style="margin:0;display:flex;align-items:center;justify-content:center;background:#fff"><img src="${url}" style="max-width:100%"/><script>onload=()=>{setTimeout(()=>print(),300)}<\/script></body></html>`,
      );
      w.document.close();
    } catch {
      showToast("Print popup blocked — use PNG export instead");
    }
  };

  const filtered = scenes.filter((s) =>
    search.trim() ? `${s.name} ${collName(s.collection)}`.toLowerCase().includes(search.toLowerCase()) : true,
  );

  return (
    <div className="app">
      <header className="appbar" onContextMenu={(e) => e.preventDefault()}>
        <div className="brand-mini">
          <button className="iconbtn" onClick={() => setMenuOpen((v) => !v)} title="Menu" aria-label="Menu">
            <Menu size={17} />
          </button>
          <div className="filepill">
            <b>Neattttty</b>
            <small>
              ~/{active ? collName(active.collection) : ""}/{active?.name}
            </small>
            <span className="saved">● {isTauri ? "desktop · local" : "local"}</span>
          </div>
        </div>
        {activeTool === "freedraw" && (
          <div className="tool-opts" role="group" aria-label="Brush settings" title="Brush default for new strokes">
            <Brush size={14} />
            <BrushSeg constant={constantBrush} onPick={pickBrush} />
          </div>
        )}
        <div className="flavors">
          {FLAVORS.map((f) => (
            <button key={f} className={flavor === f ? "on" : ""} onClick={() => setFlavor(f)}>
              <i style={{ background: "#A6D189" }} />
              {f}
            </button>
          ))}
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setRailOpen((v) => !v)} title="Toggle scenes panel">
            <PanelLeft size={14} /> {railOpen ? "Hide" : "Scenes"}
          </button>
          <button className="btn" onClick={() => setDashOpen(true)}>
            <LayoutDashboard size={14} /> Dashboard
          </button>
          <button className="btn primary" onClick={startPresent}>
            <Play size={14} /> Present
          </button>
        </div>
      </header>

      <div className="main">
        {railOpen && (
          <aside className="rail" onContextMenu={(e) => e.preventDefault()}>
            <div>
              <div className="side-h">Scenes · {scenes.length} on disk</div>
              <input className="search" placeholder="Search scenes…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <button className="btn newfolder" onClick={createCollection}>
                <Plus size={13} /> New folder
              </button>
            </div>
            {collections.map((c) => {
              const items = filtered.filter((s) => s.collection === c.id);
              const total = scenes.filter((s) => s.collection === c.id).length;
              const isCollapsed = !!collapsed[c.id];
              return (
                <div key={c.id} className="coll-group">
                  <div className="coll-head" onContextMenu={(e) => openCtx(e, folderCtx(c))}>
                    <button
                      className="coll-toggle"
                      onClick={() => setCollapsed((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
                      title={isCollapsed ? "Expand" : "Collapse"}
                      aria-expanded={!isCollapsed}
                    >
                      <span className="chev">{isCollapsed ? "▸" : "▾"}</span>
                      <Folder size={14} />
                      <b>{c.name}</b>
                      <small>{total}</small>
                    </button>
                    <span className="coll-tools">
                      <button className="tool" onClick={() => createScene(c.id)} title={`New scene in ${c.name}`} aria-label={`New scene in ${c.name}`}>
                        <Plus size={13} />
                      </button>
                      <button className="tool" onClick={() => renameCollection(c.id)} title="Rename folder" aria-label={`Rename ${c.name}`}>
                        <Pencil size={12} />
                      </button>
                      <button className="tool danger" onClick={() => deleteCollection(c.id)} title="Delete folder" aria-label={`Delete ${c.name}`}>
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                  {!isCollapsed &&
                    items.map((s) => (
                      <div
                        key={s.id}
                        className="scene-row-wrap"
                        style={{ position: "relative" }}
                        onContextMenu={(e) => openCtx(e, sceneCtx(s))}
                      >
                        <button className={`scene-row${s.id === activeIdSafe ? " on" : ""}`} onClick={() => switchScene(s.id)}>
                          <span className="thumb" />
                          <span style={{ minWidth: 0 }}>
                            <b>{s.name}</b>
                            <small>
                              {collName(s.collection)} · {new Date(s.updatedAt).toLocaleDateString()}
                            </small>
                          </span>
                        </button>
                        {scenes.length > 1 && (
                          <button
                            className="scene-del"
                            onClick={(e) => {
                              e.stopPropagation();
                              trashScene(s.id);
                            }}
                            aria-label={`Delete ${s.name}`}
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  {!isCollapsed && items.length === 0 && (
                    <div className="coll-empty">{search.trim() ? "No matches." : "Drop scenes here."}</div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && search.trim() !== "" && collections.every((c) => !filtered.some((s) => s.collection === c.id)) && (
              <div style={{ fontSize: 12, color: "var(--subtext0)", padding: "0 4px" }}>No matches.</div>
            )}
            <div className="trash-box">
              <span className="mi"><Trash2 size={13} /> Trash: {trash.length} · restores 30 days</span>
              {trash.length > 0 && (
                <button className="btn" style={{ width: "100%", marginTop: 8, height: 30 }} onClick={() => setDashOpen(true)}>
                  Review trash
                </button>
              )}
            </div>
          </aside>
        )}

        <div className="canvas-zone">
          {active && (
            <div className="excalidraw-host" key={active.id}>
              <Excalidraw
                initialData={{
                  elements: active.data.elements,
                  appState: { viewBackgroundColor: "#ffffff", ...(active.data.appState ?? {}) },
                  scrollToContent: active.data.elements.length > 0,
                  libraryItems: libStore.items,
                }}
                onChange={handleChange}
                onLibraryChange={handleLibraryChange}
                onPointerDown={() => flushConstantBrush()}
                theme={flavor === "latte" ? "light" : "dark"}
                name={`Neattttty — ${active.name}`}
                excalidrawAPI={(api: any) => {
                  apiRef.current = api;
                }}
              >
                <MainMenu>
                  <MainMenu.DefaultItems.LoadScene />
                  <MainMenu.DefaultItems.SaveToActiveFile />
                  <MainMenu.DefaultItems.SaveAsImage />
                  <MainMenu.DefaultItems.Export />
                  <MainMenu.Item icon={<FileText size={15} />} onSelect={() => void exportPdf()}>
                    Export PDF
                  </MainMenu.Item>
                  <MainMenu.Item
                    icon={<Presentation size={15} />}
                    onSelect={() =>
                      void downloadPptx(
                        active?.data.elements ?? [],
                        active?.data.files ?? {},
                        active?.name ?? "deck",
                      ).catch((e) => showToast(String(e)))
                    }
                  >
                    Export PPTX
                  </MainMenu.Item>
                  <MainMenu.Separator />
                  <MainMenu.DefaultItems.ClearCanvas />
                  <MainMenu.DefaultItems.ChangeCanvasBackground />
                  <MainMenu.Separator />
                  <MainMenu.DefaultItems.SearchMenu />
                  <MainMenu.DefaultItems.CommandPalette />
                  <MainMenu.DefaultItems.Help />
                  <MainMenu.Group title="Generate">
                    <MainMenu.Item
                      icon={<Sparkles size={15} />}
                      onSelect={() => {
                        setAiTab("generate");
                        setAiOpen(true);
                      }}
                    >
                      Text to diagram
                    </MainMenu.Item>
                    <MainMenu.Item
                      icon={<Sparkles size={15} />}
                      onSelect={() => {
                        setAiTab("wireframe");
                        setAiOpen(true);
                      }}
                    >
                      Wireframe to code
                    </MainMenu.Item>
                  </MainMenu.Group>
                </MainMenu>
              </Excalidraw>
            </div>
          )}

          {menuOpen && (
            <div className="menu">
              <button onClick={() => fileInputRef.current?.click()}>
                <span className="mi"><FileUp size={15} /> Open scene file(s)</span> <small>.excalidraw</small>
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  folderInputRef.current?.click();
                }}
              >
                <span className="mi"><FolderPlus size={15} /> Import folder…</span> <small>many files</small>
              </button>
              <button
                onClick={() => {
                  saveScenes(scenes);
                  setMenuOpen(false);
                  showToast("Saved ✓ (local)");
                }}
              >
                <span className="mi"><Save size={15} /> Save now</span> <small>Ctrl+S</small>
              </button>
              <button onClick={() => createScene()}>
                <span className="mi"><Plus size={15} /> New scene</span> <small>disk</small>
              </button>
              <button onClick={() => { setMenuOpen(false); setDashOpen(true); }}>
                <span className="mi"><LayoutDashboard size={15} /> Dashboard</span> <small>{scenes.length} scenes</small>
              </button>
              <hr />
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setAiSettingsOpen(true);
                }}
              >
                <span className="mi"><SlidersHorizontal size={15} /> AI model settings</span> <small>{KIND_LABELS[aiCfg.kind]}</small>
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setHelpOpen(true);
                }}
              >
                <span className="mi"><CircleHelp size={15} /> Help & shortcuts</span> <small>?</small>
              </button>
            </div>
          )}

          <div className="ai-dock" onContextMenu={(e) => e.preventDefault()}>
            <button className="model" onClick={() => setAiSettingsOpen(true)} title="AI model settings">
              <Bot size={13} />
              <span className="pulse" />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {`${KIND_LABELS[aiCfg.kind]} · ${aiCfg.model}`}
              </span>
            </button>
            <input
              placeholder="Ask AI: “login flow…” → chat, preview, insert"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runAiPrompt(aiPrompt);
              }}
              disabled={aiBusy}
            />
            <button className="go" onClick={() => void runAiPrompt(aiPrompt)} disabled={aiBusy || !aiPrompt.trim()}>
              {aiBusy ? "…" : <><Sparkles size={14} /> Generate</>}
            </button>
          </div>

          {presenting && (
            <div className="present-bar">
              <span>
                Slide {presentIdx + 1} / {frames.length} — {frames[presentIdx]?.name}
              </span>
              <button className="btn" onClick={() => goToFrame(Math.max(presentIdx - 1, 0))} aria-label="Previous slide">
                <ChevronLeft size={15} />
              </button>
              <button className="btn" onClick={() => goToFrame(Math.min(presentIdx + 1, frames.length - 1))} aria-label="Next slide">
                <ChevronRight size={15} />
              </button>
              <button className="btn primary" onClick={stopPresent}>
                Done <span className="kbd">esc</span>
              </button>
            </div>
          )}

          {ctx && (
            <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />
          )}
          {toast && <div className="toast">{toast}</div>}
        </div>
      </div>

      {dashOpen && (
        <div className="overlay" style={{ position: "fixed" }} onClick={(e) => e.target === e.currentTarget && setDashOpen(false)}>
          <div className="dialog">
            <h3>Dashboard — {scenes.length} scenes, local</h3>
            <p>
              Stored on this machine + portable <span className="mono">.excalidraw</span> files. Trash restores for 30 days.
            </p>
            <div className="grid">
              {scenes.map((s) => (
                <div className="card" key={s.id} onClick={() => switchScene(s.id)} style={s.id === activeIdSafe ? { borderColor: "var(--green)" } : {}}>
                  <b>{s.name}</b>
                  <br />
                  <small>
                    {collName(s.collection)} · {s.data.elements.length} els
                  </small>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        duplicateScene(s.id);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadText(`${s.name}.excalidraw`, toExcalidrawFile(s));
                      }}
                    >
                      File
                    </button>
                    <button
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        const name = window.prompt("Rename scene:", s.name);
                        if (name?.trim()) setScenes((prev) => prev.map((x) => (x.id === s.id ? { ...x, name: name.trim() } : x)));
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        trashScene(s.id);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
              <button className="card new" onClick={() => createScene()}>
                <span className="mi" style={{ justifyContent: "center" }}><Plus size={15} /> New scene</span>
                <br />
                <small>on disk</small>
              </button>
              <button className="card new" onClick={() => fileInputRef.current?.click()}>
                <span className="mi" style={{ justifyContent: "center" }}><Download size={15} /> Import files</span>
                <br />
                <small>.excalidraw</small>
              </button>
              <button className="card new" onClick={() => folderInputRef.current?.click()}>
                <span className="mi" style={{ justifyContent: "center" }}><FolderPlus size={15} /> Import folder</span>
                <br />
                <small>many .excalidraw</small>
              </button>
            </div>
            {trash.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>Trash ({trash.length})</h3>
                <div className="grid">
                  {trash.map((t) => (
                    <div className="card" key={t.id}>
                      <b>{t.name}</b>
                      <br />
                      <small>
                        deleted {new Date(t.deletedAt).toLocaleDateString()} → {collName(t.restoreTo)}
                      </small>
                      <div className="row">
                        <button
                          className="btn"
                          onClick={() => {
                            const target = collections.some((c) => c.id === t.restoreTo)
                              ? t.restoreTo
                              : (collections.find((c) => c.name === t.restoreTo)?.id ?? fallbackId);
                            setScenes((prev) => [{ ...t, collection: target, updatedAt: Date.now() }, ...prev]);
                            setTrash((prev) => prev.filter((x) => x.id !== t.id));
                            switchScene(t.id);
                          }}
                        >
                          Restore
                        </button>
                        <button className="btn" onClick={() => setTrash((prev) => prev.filter((x) => x.id !== t.id))}>
                          Delete forever
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => setTrash([])}>
                    Empty trash
                  </button>
                </div>
              </>
            )}
            <div className="row">
              <button className="btn primary" onClick={() => setDashOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {aiSettingsOpen && (
        <div className="overlay" style={{ position: "fixed" }} onClick={(e) => e.target === e.currentTarget && setAiSettingsOpen(false)}>
          <div className="dialog" style={{ maxWidth: 560 }}>
            <h3>AI model settings</h3>
            <p>
              Offline default: Ollama at <span className="mono">localhost:11434</span>. For OpenCode Zen, paste a key
              from <span className="mono">opencode.ai</span> — a Zen account with billing on file is required even
              for free models, otherwise the server rejects the key. Zen defaults to the free Spark model
              (Responses style); chat-style models like Kimi/DeepSeek need Chat Completions. Some endpoints block
              browser tabs — the desktop app relays requests, so prefer it. BYOK keys stay in this machine's
              local storage only.
            </p>
            <div className="row">
              <label className="f">
                Provider
                <select
                  value={aiCfg.kind}
                  onChange={(e) => {
                    const kind = e.target.value as AIKind;
                    setAiCfg((prev) => ({
                      ...prev,
                      kind,
                      model: AI_DEFAULTS[kind].model,
                      baseUrl: AI_DEFAULTS[kind].baseUrl,
                      // Zen's free default is a Responses-API model; everything
                      // else defaults to Chat Completions (still switchable).
                      apiStyle: kind === "opencode-zen" ? "responses" : "chat",
                    }));
                  }}
                >
                  <option value="ollama">Ollama (offline)</option>
                  <option value="local-openai">Local OpenAI-compatible (LM Studio)</option>
                  <option value="openai">OpenAI (BYOK)</option>
                  <option value="openrouter">OpenRouter (BYOK)</option>
                  <option value="anthropic">Anthropic (BYOK)</option>
                  <option value="gemini">Gemini via OpenAI-compat (BYOK)</option>
                  <option value="opencode-zen">OpenCode Zen (BYOK)</option>
                  <option value="custom">Custom OpenAI-compatible (BYOK)</option>
                </select>
              </label>
              <label className="f">
                Model
                <input value={aiCfg.model} onChange={(e) => setAiCfg((prev) => ({ ...prev, model: e.target.value }))} />
              </label>
            </div>
            <div className="row">
              <label className="f">
                Base URL / endpoint
                <input value={aiCfg.baseUrl} onChange={(e) => setAiCfg((prev) => ({ ...prev, baseUrl: e.target.value }))} />
              </label>
              {(aiCfg.kind === "opencode-zen" || aiCfg.kind === "custom") && (
                <label className="f">
                  API style
                  <select
                    value={aiCfg.apiStyle ?? "chat"}
                    onChange={(e) =>
                      setAiCfg((prev) => ({ ...prev, apiStyle: e.target.value as AIConfig["apiStyle"] }))
                    }
                  >
                    <option value="chat">Chat Completions (/chat/completions)</option>
                    <option value="responses">Responses (/responses)</option>
                  </select>
                </label>
              )}
              {aiCfg.kind !== "ollama" && aiCfg.kind !== "local-openai" && (
                <label className="f">
                  API key (this machine only)
                  <input
                    type="password"
                    value={aiCfg.apiKey}
                    placeholder="sk-…"
                    onChange={(e) => setAiCfg((prev) => ({ ...prev, apiKey: e.target.value }))}
                  />
                </label>
              )}
            </div>
            <div className="row">
              <button className="btn primary" onClick={() => setAiSettingsOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {aiOpen && (
        <div className="overlay" style={{ position: "fixed" }} onClick={(e) => e.target === e.currentTarget && !aiBusy && setAiOpen(false)}>
          <div className="dialog ai-dialog">
            <div className="ai-head">
              <div className="tabs">
                <button className={aiTab === "generate" ? "on" : ""} onClick={() => setAiTab("generate")}>
                  Text to diagram <span className="beta">AI Beta</span>
                </button>
                <button className={aiTab === "mermaid" ? "on" : ""} onClick={() => setAiTab("mermaid")}>
                  Mermaid
                </button>
                <button className={aiTab === "wireframe" ? "on" : ""} onClick={() => setAiTab("wireframe")}>
                  Wireframe
                </button>
              </div>
              <button className="iconbtn" onClick={() => !aiBusy && setAiOpen(false)} aria-label="Close AI dialog">
                <X size={16} />
              </button>
            </div>
            {aiTab === "wireframe" ? (
              <div className="ai-body">
                <div className="chat-col">
                  <div style={{ fontSize: 13, color: "var(--subtext0)" }}>
                    Sends a snapshot of your{" "}
                    {wfSnap ? (wfSnap.whole ? `whole scene (${wfSnap.count} els)` : `selection (${wfSnap.count} els)`) : "canvas (selection if any, else whole scene)"}{" "}
                    to a vision model. Needs a vision-capable model — any cloud default works; local
                    Ollama needs one like <span className="mono">qwen2.5vl</span>.
                  </div>
                  {wfSnap && (
                    <img
                      src={wfSnap.dataUrl}
                      alt="Wireframe snapshot"
                      style={{ width: "100%", borderRadius: 10, border: "1px solid var(--panel-border)" }}
                    />
                  )}
                  <textarea
                    className="preview-code"
                    style={{ minHeight: 70 }}
                    value={wfInstructions}
                    onChange={(e) => setWfInstructions(e.target.value)}
                    placeholder="Extra instructions (optional): e.g. dark sidebar, 3-step checkout…"
                    spellCheck={false}
                  />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn"
                      onClick={() => {
                        setWfSnap(null);
                        setWfHtml("");
                      }}
                      disabled={wfBusy}
                    >
                      Re-capture
                    </button>
                    <button className="btn primary" onClick={() => void runWireframe()} disabled={wfBusy}>
                      {wfBusy ? "Generating…" : wfHtml ? "Regenerate" : "Generate code"}
                    </button>
                  </div>
                </div>
                <div className="preview-col">
                  <div className="preview-card">
                    {wfView === "preview" ? (
                      wfHtml ? (
                        <iframe title="Wireframe preview" className="preview-frame" sandbox="allow-scripts" srcDoc={wfHtml} />
                      ) : (
                        <div style={{ fontSize: 13, color: "var(--subtext0)", padding: 12 }}>
                          Preview appears here.
                        </div>
                      )
                    ) : (
                      <textarea
                        className="preview-code"
                        value={wfHtml}
                        readOnly
                        placeholder="Generated HTML appears here."
                        spellCheck={false}
                      />
                    )}
                  </div>
                  <div className="preview-foot">
                    <button className="linklike" onClick={() => setWfView((v) => (v === "preview" ? "code" : "preview"))}>
                      {wfView === "preview" ? "View code →" : "View preview →"}
                    </button>
                    <button className="btn" style={{ height: 30, fontSize: 12 }} onClick={() => void copyWireframe()} disabled={!wfHtml}>
                      Copy
                    </button>
                    <button
                      className="btn"
                      style={{ height: 30, fontSize: 12 }}
                      onClick={() => wfHtml && downloadText("wireframe.html", wfHtml, "text/html")}
                      disabled={!wfHtml}
                    >
                      File
                    </button>
                    <button className="btn primary" onClick={() => void insertWireframe()} disabled={!wfHtml}>
                      <Plus size={14} /> Insert frame →
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--subtext0)" }}>
                    Insert places a live preview frame on your canvas — resize it to test
                    responsiveness. The preview runs sandboxed.
                  </div>
                </div>
              </div>
            ) : aiTab === "generate" ? (
              <div className="ai-body">
                <div className="chat-col">
                  <div className="chat-top">
                    <span className="mono" style={{ fontSize: 11, color: "var(--subtext0)" }}>
                      {KIND_LABELS[aiCfg.kind]} · {aiCfg.model}
                    </span>
                    <button className="btn" style={{ height: 28, fontSize: 12 }} onClick={newAiChat} disabled={aiBusy}>
                      New chat
                    </button>
                  </div>
                  <div className="chat-list">
                    {chat.length === 0 && (
                      <div style={{ fontSize: 13, color: "var(--subtext0)" }}>
                        Describe a diagram — e.g. “login flow with retry”, “ERD for users and orders”.
                        The assistant drafts Mermaid code; you preview it and insert what you like.
                      </div>
                    )}
                    {chat.map((m, i) => (
                      <div key={i} className={`msg ${m.role}`}>
                        <div className="msg-head">
                          <b>{m.role === "user" ? "You" : "AI Assistant"}</b>
                          <small>{m.time}</small>
                        </div>
                        {m.role === "user" ? (
                          <div>{m.text}</div>
                        ) : (
                          <pre>{m.text}</pre>
                        )}
                      </div>
                    ))}
                    {aiBusy && <div style={{ fontSize: 13, color: "var(--subtext0)" }}>Drafting diagram…</div>}
                  </div>
                  <div className="ai-inputrow">
                    <input
                      placeholder="Continue refining your diagram…"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void runAiPrompt(aiPrompt);
                      }}
                      disabled={aiBusy}
                    />
                    <button className="btn primary" onClick={() => void runAiPrompt(aiPrompt)} disabled={aiBusy || !aiPrompt.trim()} aria-label="Send">
                      <SendHorizontal size={15} />
                    </button>
                  </div>
                </div>
                <div className="preview-col">
                  <div className="preview-card">
                    {previewError ? (
                      <div className="preview-error">{previewError}</div>
                    ) : previewSvg && !showCode ? (
                      <div className="preview-svg" dangerouslySetInnerHTML={{ __html: previewSvg }} />
                    ) : (
                      <textarea
                        className="preview-code"
                        value={draftMermaid}
                        onChange={(e) => setDraftMermaid(e.target.value)}
                        placeholder="Mermaid code appears here — edit it, then Update preview."
                        spellCheck={false}
                      />
                    )}
                  </div>
                  <div className="preview-foot">
                    <button className="linklike" onClick={() => setShowCode((v) => !v)}>
                      {showCode ? "View preview →" : "View as Mermaid →"}
                    </button>
                    {!showCode && draftMermaid && (
                      <button className="btn" style={{ height: 30, fontSize: 12 }} onClick={() => void refreshPreview()} disabled={aiBusy}>
                        Update preview
                      </button>
                    )}
                    <button className="btn primary" onClick={insertPreview} disabled={!previewSceneRef.current || aiBusy}>
                      <Plus size={14} /> Insert →
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--subtext0)" }}>
                    Insert places editable shapes on your canvas — move, restyle, ungroup freely.
                  </div>
                </div>
              </div>
            ) : (
              <div className="ai-body single">
                <div className="chat-col">
                  <div style={{ fontSize: 13, color: "var(--subtext0)" }}>
                    Paste any Mermaid diagram (flowchart, sequence, class, ER…) to preview it and insert it as
                    editable shapes.
                  </div>
                  <textarea
                    className="preview-code tall"
                    value={mermaidTabCode}
                    onChange={(e) => setMermaidTabCode(e.target.value)}
                    placeholder={"flowchart TD\n    A[Start] --> B{Ready?}\n    B -->|Yes| C[Go]"}
                    spellCheck={false}
                  />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn primary" onClick={() => void previewPastedMermaid()} disabled={aiBusy || !mermaidTabCode.trim()}>
                      Preview
                    </button>
                  </div>
                </div>
                <div className="preview-col">
                  <div className="preview-card">
                    {previewError ? (
                      <div className="preview-error">{previewError}</div>
                    ) : previewSvg ? (
                      <div className="preview-svg" dangerouslySetInnerHTML={{ __html: previewSvg }} />
                    ) : (
                      <div style={{ fontSize: 13, color: "var(--subtext0)", padding: 12 }}>
                        Preview appears here.
                      </div>
                    )}
                  </div>
                  <div className="preview-foot">
                    <span />
                    <button className="btn primary" onClick={insertPreview} disabled={!previewSceneRef.current || aiBusy}>
                      <Plus size={14} /> Insert →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {helpOpen && (
        <div className="overlay" style={{ position: "fixed" }} onClick={(e) => e.target === e.currentTarget && setHelpOpen(false)}>
          <div className="dialog" style={{ maxWidth: 520 }}>
            <h3>Neattttty basics</h3>
            <p>
              is the OSS Excalidraw editor with a local shell. Draw with the floating canvas toolbar. Frames (▦) become slides
              in the right dock. <span className="kbd">Ctrl+S</span> saves locally. Present with <span className="kbd">→</span> /{" "}
              <span className="kbd">←</span>, exit with <span className="kbd">esc</span>. AI dock: offline Ollama by default, BYOK in
              model settings. Not affiliated with Excalidraw.
            </p>
            <div className="row">
              <button className="btn primary" onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".excalidraw,.json,application/json"
        style={{ display: "none" }}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length === 0) return;
          if (files.length === 1) {
            const f = files[0];
            try {
              const data = await parseImportedFile(f);
              const s: SceneMeta = {
                id: uid(),
                name: f.name.replace(/\.excalidraw$|\.json$/i, "") || "imported",
                collection: fallbackId,
                updatedAt: Date.now(),
                data,
              };
              setScenes((prev) => [s, ...prev]);
              switchScene(s.id);
              showToast(`Imported ${s.name} (${data.elements.length} elements)`);
            } catch {
              showToast("Could not read that file as .excalidraw JSON");
            }
            return;
          }
          const folderName = window.prompt(`Import ${files.length} files into a new folder:`, "Imported");
          if (folderName === null) return;
          await importManyFiles(files, ensureCollection(folderName));
        }}
      />
      <input
        ref={(el) => {
          folderInputRef.current = el;
          // Not in React's input prop types — set directly. Works in Chromium/WebView2.
          if (el) el.setAttribute("webkitdirectory", "");
        }}
        type="file"
        style={{ display: "none" }}
        onChange={async (e) => {
          const all = [...(e.target.files ?? [])];
          e.target.value = "";
          if (all.length === 0) return;
          const files = all.filter((f) => /\.excalidraw$|\.json$/i.test(f.name));
          if (files.length === 0) {
            showToast("No .excalidraw files in that folder");
            return;
          }
          const topDir = (all[0].webkitRelativePath || "").split("/")[0] || "Imported";
          const folderName = window.prompt(`Import ${files.length} file(s) into a new folder:`, topDir);
          if (folderName === null) return;
          await importManyFiles(files, ensureCollection(folderName));
        }}
      />
    </div>
  );
}
