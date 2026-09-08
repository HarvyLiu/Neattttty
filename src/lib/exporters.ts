// Export helpers: PNG / SVG via the OSS editor utils, PPTX via pptxgenjs (original code).
import { exportToCanvas, exportToSvg } from "@excalidraw/excalidraw";
import { downloadText } from "./scenes";

export async function downloadPng(elements: any[], files: any): Promise<void> {
  const canvas = await exportToCanvas({
    elements,
    appState: { viewBackgroundColor: "#ffffff" } as any,
    files: files ?? {},
  } as any);
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = "neattttty.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function downloadSvg(elements: any[], files: any): Promise<void> {
  const svg = await exportToSvg({
    elements,
    appState: { viewBackgroundColor: "#ffffff" } as any,
    files: files ?? {},
  } as any);
  const text = new XMLSerializer().serializeToString(svg);
  downloadText("neattttty.svg", text, "image/svg+xml");
}

interface FrameInfo {
  id: string;
  name: string;
  x: number;
  y: number;
}

export function listFrames(elements: any[]): FrameInfo[] {
  return (elements ?? [])
    .filter((e: any) => e?.type === "frame")
    .map((e: any) => ({ id: e.id, name: String(e.name ?? "Frame"), x: e.x ?? 0, y: e.y ?? 0 }))
    .sort((a: FrameInfo, b: FrameInfo) => a.x - b.x || a.y - b.y);
}

/** One PPTX slide per frame: render frame children to PNG, add as slide image. */
export async function downloadPptx(elements: any[], files: any, deckName: string): Promise<void> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const frames = listFrames(elements);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";

  const renderSlide = async (els: any[]) => {
    const canvas = await exportToCanvas({
      elements: els,
      appState: { viewBackgroundColor: "#ffffff" } as any,
      files: files ?? {},
    } as any);
    return canvas.toDataURL("image/png");
  };

  if (frames.length === 0) {
    const img = await renderSlide(elements);
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addImage({ data: img, x: 0.4, y: 0.4, w: 12.53, h: 6.7 });
  } else {
    for (const f of frames) {
      const kids = elements.filter((e: any) => e.frameId === f.id || e.id === f.id);
      const img = await renderSlide(kids.length > 0 ? kids : elements);
      const slide = pptx.addSlide();
      slide.background = { color: "FFFFFF" };
      slide.addText(f.name, { x: 0.4, y: 0.1, fontSize: 14, bold: true, color: "4C4F69" });
      slide.addImage({ data: img, x: 0.4, y: 0.6, w: 12.53, h: 6.5 });
    }
  }
  const safe = (deckName || "neattttty").replace(/[^\w\-]+/g, "-").slice(0, 60) || "neattttty";
  await pptx.writeFile({ fileName: `${safe}.pptx` });
}
