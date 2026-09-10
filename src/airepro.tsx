import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { mermaidToScene } from "./lib/ai";

const SAMPLE = `flowchart TD
    A[Start here] --> B{Check thing?}
    B -->|Yes| C[Done now]
    B -->|No| D[Try again]
    D --> B`;

function Repro() {
  const [fires, setFires] = useState(0);
  const sigRef = useRef("");
  const apiRef = useRef<any>(null);

  const handleChange = (elements: any) => {
    const els: any[] = elements ?? [];
    let v = 0;
    let vn = 0;
    for (const e of els) {
      v += e?.version ?? 0;
      if (typeof e?.versionNonce === "number") vn = (vn + e.versionNonce) | 0;
    }
    const sig = `${els.length}|${v}|${vn}`;
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    setFires((f) => f + 1);
  };

  useEffect(() => {
    const t = window.setTimeout(() => {
      (async () => {
        try {
          const { elements } = await mermaidToScene(SAMPLE);
          (window as any).__count = Array.isArray(elements) ? elements.length : -1;
          apiRef.current?.updateScene?.({ elements });
          (window as any).__pushed = true;
          window.setTimeout(() => {
            try {
              apiRef.current?.scrollToContent?.(elements, { fitToContent: true });
            } catch {
              /* ignore */
            }
          }, 2000);
        } catch (err: any) {
          document.title = "PUSH-ERR: " + String(err?.message ?? err).slice(0, 160);
        }
      })();
    }, 1500);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div style={{ height: "100vh" }}>
      <div id="hud">
        fires={fires} pushed={String((window as any).__pushed ?? false)} els=
        {(window as any).__count ?? "…"}
      </div>
      <Excalidraw
        initialData={{ elements: [] }}
        onChange={handleChange}
        excalidrawAPI={(api: any) => {
          apiRef.current = api;
        }}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Repro />
  </React.StrictMode>,
);
