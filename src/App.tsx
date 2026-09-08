import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  Bot,
  Brush,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  FileDown,
  FileText,
  FileUp,
  Folder,
  Image as ImageIcon,
  LayoutDashboard,
  Menu,
  PanelLeft,
  Play,
  Plus,
  Presentation,
  RotateCcw,
  Save,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Trash2,
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
import { AI_DEFAULTS, generateDiagram, type AIConfig, type AIKind } from "./lib/ai";
import { downloadPng, downloadPptx, downloadSvg, listFrames } from "./lib/exporters";

type Flavor = "latte" | "frappe" | "macchiato" | "mocha";
const FLAVORS: Flavor[] = ["latte", "frappe", "macchiato", "mocha"];

const AI_STORE_KEY = "neattttty.ai.v1";
const NOTES_KEY = "neattttty.notes.v1";
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
  const [scenes, setScenes] = useState<SceneMeta[]>(() => purgeCheck(loadScenes()));
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
  const [dockTab, setDockTab] = useState<"scenes" | "slides">("slides");
  const [menuOpen, setMenuOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiCfg, setAiCfg] = useState<AIConfig>(loadAI);
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(NOTES_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
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

  // Freedraw tool detection: best-effort from onChange, plus a light poll
  // for tool switches onChange doesn't report. Read-only, never writes.
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
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      } catch {
        /* ignore */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [notes]);

  function purgeCheck(list: SceneMeta[]): SceneMeta[] {
    return list;
  }

  const switchScene = (id: string) => {
    setActiveId(id);
    saveActiveId(id);
    setMenuOpen(false);
    setDashOpen(false);
  };

  const createScene = (collection = "Work") => {
    const s: SceneMeta = {
      id: uid(),
      name: `untitled-${scenes.length + 1}`,
      collection,
      updatedAt: Date.now(),
      data: { elements: [], files: {} },
    };
    setScenes((prev) => [s, ...prev]);
    switchScene(s.id);
    showToast(`New scene in ${collection} — saved locally`);
  };

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

  const runAI = async () => {
    if (aiBusy || !aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const fresh = await generateDiagram(aiCfg, aiPrompt);
      const cur: any[] = apiRef.current?.getSceneElements?.() ?? active?.data.elements ?? [];
      const maxX = cur.reduce((m: number, e: any) => Math.max(m, (e?.x ?? 0) + (e?.width ?? 0)), 0);
      const dx = maxX > 0 ? maxX + 120 - 120 : 0;
      const shifted = fresh.map((e: any) => ({ ...e, x: (e.x ?? 0) + dx }));
      const next = [...cur, ...shifted];
      apiRef.current?.updateScene?.({ elements: next });
      setAiPrompt("");
      showToast(`AI added ${shifted.length} editable elements`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (aiCfg.kind === "ollama" && /failed|fetch|network/i.test(msg)) {
        showToast("Ollama not reachable — run `ollama serve` or switch model to BYOK");
      } else {
        showToast(msg);
      }
    } finally {
      setAiBusy(false);
    }
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
        saveScenes(scenes);
        showToast("Saved ✓ (local)");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenes, showToast]);

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
    search.trim() ? `${s.name} ${s.collection}`.toLowerCase().includes(search.toLowerCase()) : true,
  );
  const collections = [...new Set(scenes.map((s) => s.collection))];
  const noteKey = `${activeIdSafe}:${frames[Math.min(presentIdx, Math.max(frames.length - 1, 0))]?.id ?? "none"}`;

  return (
    <div className="app">
      <header className="appbar">
        <div className="brand-mini">
          <button className="iconbtn" onClick={() => setMenuOpen((v) => !v)} title="Menu" aria-label="Menu">
            <Menu size={17} />
          </button>
          <div className="filepill">
            <b>Neattttty</b>
            <small>
              ~/{active?.collection}/{active?.name}
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
          <aside className="rail">
            <div>
              <div className="side-h">Scenes · {scenes.length} on disk</div>
              <input className="search" placeholder="Search scenes…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div>
              {filtered.map((s) => (
                <button key={s.id} className={`scene-row${s.id === activeIdSafe ? " on" : ""}`} onClick={() => switchScene(s.id)}>
                  <span className="thumb" />
                  <span style={{ minWidth: 0 }}>
                    <b>{s.name}</b>
                    <small>
                      {s.collection} · {new Date(s.updatedAt).toLocaleDateString()}
                    </small>
                  </span>
                </button>
              ))}
              {filtered.length === 0 && <div style={{ fontSize: 12, color: "var(--subtext0)", padding: "0 4px" }}>No matches.</div>}
            </div>
            <div>
              <div className="side-h">Collections</div>
              {collections.map((c) => (
                <div className="coll-row" key={c}>
                  <span className="mi"><Folder size={14} /> {c}</span>
                  <span>{scenes.filter((s) => s.collection === c).length}</span>
                </div>
              ))}
            </div>
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
                }}
                onChange={handleChange}
                onPointerDown={() => flushConstantBrush()}
                theme={flavor === "latte" ? "light" : "dark"}
                name={`Neattttty — ${active.name}`}
                excalidrawAPI={(api: any) => {
                  apiRef.current = api;
                }}
              />
            </div>
          )}

          {menuOpen && (
            <div className="menu">
              <button onClick={() => fileInputRef.current?.click()}>
                <span className="mi"><FileUp size={15} /> Open scene file</span> <small>.excalidraw</small>
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
                  if (!active) return;
                  downloadText(`${active.name}.excalidraw`, toExcalidrawFile(active));
                  setMenuOpen(false);
                }}
              >
                <span className="mi"><FileDown size={15} /> Export scene JSON</span> <small>.excalidraw</small>
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  void downloadPng(active?.data.elements ?? [], active?.data.files ?? {}).catch((e) => showToast(String(e)));
                }}
              >
                <span className="mi"><ImageIcon size={15} /> Export PNG</span> <small>local</small>
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  void downloadSvg(active?.data.elements ?? [], active?.data.files ?? {}).catch((e) => showToast(String(e)));
                }}
              >
                <span className="mi"><Shapes size={15} /> Export SVG</span> <small>local</small>
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
              <button
                onClick={() => {
                  if (!window.confirm("Clear this canvas? (scene stays, elements removed)")) return;
                  apiRef.current?.updateScene?.({ elements: [] });
                  setMenuOpen(false);
                }}
              >
                <span className="mi"><RotateCcw size={15} /> Reset canvas</span> <small>clear</small>
              </button>
            </div>
          )}

          <div className="slides-dock">
            <div className="tabs">
              <button className={dockTab === "slides" ? "on" : ""} onClick={() => setDockTab("slides")}>
                Slides {frames.length > 0 ? `(${frames.length})` : ""}
              </button>
              <button className={dockTab === "scenes" ? "on" : ""} onClick={() => setDockTab("scenes")}>
                Scenes
              </button>
            </div>
            {dockTab === "slides" ? (
              <>
                <div className="list">
                  {frames.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--subtext0)", padding: 4 }}>
                      No frames yet. Use the <b>▦ Frame</b> tool on the canvas toolbar, then each frame becomes a slide here.
                    </div>
                  )}
                  {frames.map((f, i) => (
                    <button key={f.id} className={`slide-row${i === presentIdx ? " on" : ""}`} onClick={() => goToFrame(i)}>
                      <i />
                      <span>
                        <b style={{ fontSize: 12.5 }}>{i + 1} · {f.name}</b>
                      </span>
                    </button>
                  ))}
                </div>
                {frames.length > 0 && (
                  <div className="note-card">
                    <div style={{ fontSize: 11, color: "var(--subtext0)", marginBottom: 4 }}>Presenter note — slide {presentIdx + 1}</div>
                    <textarea
                      placeholder="Talking points… (saved locally)"
                      value={notes[noteKey] ?? ""}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [noteKey]: e.target.value }))}
                    />
                  </div>
                )}
                <div className="dock-foot">
                  <button className="btn" onClick={() => void exportPdf()}>
                    <FileText size={14} /> PDF
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      void downloadPptx(active?.data.elements ?? [], active?.data.files ?? {}, active?.name ?? "deck").catch((e) =>
                        showToast(String(e)),
                      )
                    }
                  >
                    <Presentation size={14} /> PPTX
                  </button>
                  <button className="btn primary" onClick={startPresent}>
                    <Play size={14} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="list">
                  {scenes.slice(0, 6).map((s) => (
                    <button key={s.id} className={`slide-row${s.id === activeIdSafe ? " on" : ""}`} onClick={() => switchScene(s.id)}>
                      <i />
                      <span>
                        <b style={{ fontSize: 12.5 }}>{s.name}</b>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="dock-foot">
                  <button className="btn" style={{ flex: 1 }} onClick={() => setDashOpen(true)}>
                    Open dashboard
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="ai-dock">
            <button className="model" onClick={() => setAiSettingsOpen(true)} title="AI model settings">
              <Bot size={13} />
              <span className="pulse" />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {`${KIND_LABELS[aiCfg.kind]} · ${aiCfg.model}`}
              </span>
            </button>
            <input
              placeholder="Ask AI: “login flow with retry…” → editable boxes"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runAI();
              }}
              disabled={aiBusy}
            />
            <button className="go" onClick={() => void runAI()} disabled={aiBusy || !aiPrompt.trim()}>
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
                    {s.collection} · {s.data.elements.length} els
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
                <span className="mi" style={{ justifyContent: "center" }}><Download size={15} /> Import file</span>
                <br />
                <small>.excalidraw</small>
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
                        deleted {new Date(t.deletedAt).toLocaleDateString()} → {t.restoreTo}
                      </small>
                      <div className="row">
                        <button
                          className="btn"
                          onClick={() => {
                            setScenes((prev) => [{ ...t, collection: t.restoreTo, updatedAt: Date.now() }, ...prev]);
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
        accept=".excalidraw,.json,application/json"
        style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            const data = await parseImportedFile(f);
            const s: SceneMeta = {
              id: uid(),
              name: f.name.replace(/\.excalidraw$|\.json$/i, "") || "imported",
              collection: "Work",
              updatedAt: Date.now(),
              data,
            };
            setScenes((prev) => [s, ...prev]);
            switchScene(s.id);
            showToast(`Imported ${s.name} (${data.elements.length} elements)`);
          } catch {
            showToast("Could not read that file as .excalidraw JSON");
          }
        }}
      />
    </div>
  );
}
