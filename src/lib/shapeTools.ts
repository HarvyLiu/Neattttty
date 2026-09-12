// Shape tools for Neattttty: bucket fill.
//
// Bucket fill works in two layers:
//   1. Vector fast path (exact): the click is tested against real shape
//      geometry, topmost first. A hit inside a closed shape restyles it in
//      place — no pixels, no tracing, nothing to go wrong. This covers the
//      overwhelmingly common case (click a shape, it fills).
//   2. Raster fallback: for regions formed by several open strokes, the
//      scene is rasterized, flood-filled from the click, and the boundary
//      traced back to a polygon (marching squares + longest loop).
//
// Tolerances (6px gap bridging, tiny min-area) follow upstream's bucket
// fill (#11799, MIT (c) Excalidraw team); the pipeline here is original.

import { exportToSvg } from "@excalidraw/excalidraw";

export interface Pt {
  x: number;
  y: number;
}

export const BUCKET_KEY = "neattttty.bucket.v1";

/** Upstream-style quick palette cycled with B (no transparent on purpose). */
export const BUCKET_COLORS = [
  "#e03131",
  "#f76707",
  "#fcc419",
  "#94d82d",
  "#12b886",
  "#22b8cf",
  "#4dabf7",
  "#9775fa",
  "#f783ac",
  "#ffffff",
];

/** Ramer-Douglas-Peucker corner simplification. */
export function rdp(pts: Pt[], eps: number): Pt[] {
  const perp = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
  };
  if (pts.length <= 2) return [...pts];
  const first = pts[0];
  const last = pts[pts.length - 1];
  let idx = -1;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perp(pts[i], first, last);
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (idx >= 0 && max > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

// -----------------------------------------------------------------------------
// Vector fast path: point-in-closed-shape owner test.
// -----------------------------------------------------------------------------

const FILLABLE = new Set(["rectangle", "ellipse", "diamond", "freedraw", "line"]);

function strokePad(e: any): number {
  return (typeof e?.strokeWidth === "number" ? e.strokeWidth : 2) / 2 + 2;
}

/** Even-odd ray cast for closed polylines (absolute coords). */
function pointInLoop(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function absoluteLoop(e: any): Pt[] | null {
  const raw = e?.points as number[][] | undefined;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const ox = typeof e?.x === "number" ? e.x : 0;
  const oy = typeof e?.y === "number" ? e.y : 0;
  const pts = raw.map((q) => ({ x: ox + q[0], y: oy + q[1] }));
  // Closed loop: ends meet (within a few px or a small fraction of length).
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) > Math.max(8, 0.05 * len)) {
    return null;
  }
  return pts;
}

/**
 * Exact point-in-closed-shape test. Only unrotated shapes qualify (angle
 * must be unset/0) — rotated ones fall through to the raster fallback.
 */
function pointInClosedShape(e: any, p: Pt): boolean {
  if (!e || e.isDeleted || e.locked || (e.opacity ?? 100) <= 0) return false;
  if (!FILLABLE.has(e.type)) return false;
  if (e.angle) return false;
  if (typeof e.x !== "number" || typeof e.y !== "number") return false;
  const pad = strokePad(e);
  if (e.type === "rectangle") {
    const w = e.width ?? 0;
    const h = e.height ?? 0;
    return p.x >= e.x - pad && p.x <= e.x + w + pad && p.y >= e.y - pad && p.y <= e.y + h + pad;
  }
  if (e.type === "ellipse") {
    const rx = (e.width ?? 0) / 2 + pad;
    const ry = (e.height ?? 0) / 2 + pad;
    if (!(rx > 0) || !(ry > 0)) return false;
    const dx = (p.x - (e.x + (e.width ?? 0) / 2)) / rx;
    const dy = (p.y - (e.y + (e.height ?? 0) / 2)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (e.type === "diamond") {
    const hw = (e.width ?? 0) / 2 + pad;
    const hh = (e.height ?? 0) / 2 + pad;
    if (!(hw > 0) || !(hh > 0)) return false;
    const dx = Math.abs(p.x - (e.x + (e.width ?? 0) / 2)) / hw;
    const dy = Math.abs(p.y - (e.y + (e.height ?? 0) / 2)) / hh;
    return dx + dy <= 1;
  }
  // freedraw / line: closed loop only.
  const loop = absoluteLoop(e);
  return loop !== null && pointInLoop(p, loop);
}

/** Topmost closed shape under the point, or null. */
export function findFillOwner(elements: any[], p: Pt): any | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (e && pointInClosedShape(e, p)) return e;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Raster fallback: rasterize -> flood fill -> vectorize to polygon.
// -----------------------------------------------------------------------------

interface Raster {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  /** scene -> raster: px = (scene + off) * scale */
  offX: number;
  offY: number;
  scale: number; // raster px per scene unit
}

/** Absolute content bbox of elements (shapes via x/y/w/h, strokes via points). */
function contentBBox(els: any[]): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const e of els) {
    if (typeof e?.x !== "number" || typeof e?.y !== "number") continue;
    let x1 = e.x;
    let y1 = e.y;
    let x2 = e.x + (e.width ?? 0);
    let y2 = e.y + (e.height ?? 0);
    if ((e.type === "line" || e.type === "freedraw") && Array.isArray(e.points)) {
      for (const p of e.points) {
        if (!Array.isArray(p)) continue;
        x1 = Math.min(x1, e.x + p[0]);
        y1 = Math.min(y1, e.y + p[1]);
        x2 = Math.max(x2, e.x + p[0]);
        y2 = Math.max(y2, e.y + p[1]);
      }
    }
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
    any = true;
  }
  return any ? [minX, minY, maxX, maxY] : null;
}

// Element types whose export markup is a single top-level translated group
// (verified against real exports). Anything else stops calibration pairing.
const CALIBRATABLE = new Set(["rectangle", "ellipse", "diamond", "line", "freedraw", "text"]);

/**
 * Render elements to a pixel buffer with an EXACT scene mapping.
 *
 * exportToSvg always rebases content to a 0-origin viewBox, so the viewBox
 * alone cannot map clicks. Instead we prepend a 2px calibration marker at a
 * known scene position: its rendered `<g transform>` gives the true offset,
 * verified for consensus against the leading shape-like elements.
 */
async function rasterize(
  elements: any[],
  files: any,
  debug?: (info: Record<string, unknown>) => void,
): Promise<Raster> {
  const box = contentBBox(elements);
  const markerX = (box ? box[0] : 0) - 50;
  const markerY = (box ? box[1] : 0) - 50;
  const marker = {
    id: "__calib",
    type: "rectangle",
    x: markerX,
    y: markerY,
    width: 2,
    height: 2,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    link: null,
    locked: false,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    updated: 1,
  };
  const svg = await exportToSvg({
    elements: [marker, ...elements],
    appState: { viewBackgroundColor: "#ffffff" } as any,
    files: files ?? {},
  } as any);
  const text = new XMLSerializer().serializeToString(svg);
  const vb = text.match(/viewBox="([^"]+)"/);
  const wm = text.match(/<svg[^>]*\bwidth="([\d.]+)"/);
  if (!vb || !wm) throw new Error("Could not rasterize the scene");
  const nums = vb[1].trim().split(/[\s,]+/).map(Number);
  if (nums.length < 4 || nums.some((n) => !isFinite(n))) throw new Error("Could not rasterize the scene");
  const vbW = nums[2];
  const vbH = nums[3];
  if (!(vbW > 0) || !(vbH > 0)) throw new Error("Could not rasterize the scene");
  const cw = Number(wm[1]);
  if (!(cw > 0)) throw new Error("Could not rasterize the scene");
  const scale = cw / vbW;
  // Calibrate: marker renders first; verify consensus on leading shapes.
  const stripped = text.replace(/<defs>[\s\S]*?<\/defs>/, "");
  const matches = [
    ...stripped.matchAll(/<g\b[^>]*\btransform="translate\(\s*(-?[\d.eE+]+)[,\s]+(-?[\d.eE+]+)/g),
  ].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  if (matches.length === 0) throw new Error("Could not map the canvas");
  const offs: [number, number][] = [[matches[0][0] - markerX, matches[0][1] - markerY]];
  let mi = 1;
  for (const e of elements) {
    if (mi >= matches.length) break;
    if (e?.angle || !CALIBRATABLE.has(e?.type)) break; // stop at first complex element
    if (typeof e?.x !== "number" || typeof e?.y !== "number") break;
    offs.push([matches[mi][0] - e.x, matches[mi][1] - e.y]);
    mi++;
  }
  const oxs = offs.map((o) => o[0]).sort((a, b) => a - b);
  const oys = offs.map((o) => o[1]).sort((a, b) => a - b);
  const med = (a: number[]) => a[Math.floor(a.length / 2)];
  const offX = med(oxs);
  const offY = med(oys);
  if (offs.some(([x, y]) => Math.abs(x - offX) > 1 || Math.abs(y - offY) > 1)) {
    throw new Error("Could not map the canvas");
  }
  debug?.({ stage: "calibrate", offX, offY, scale, samples: offs.length });
  const img = new Image();
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml;charset=utf-8" }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not rasterize the scene"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth || cw));
    canvas.height = Math.max(1, Math.round(img.naturalHeight || (cw * vbH) / vbW));
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("Could not rasterize the scene");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const px = g.getImageData(0, 0, canvas.width, canvas.height);
    return { data: px.data, w: canvas.width, h: canvas.height, offX, offY, scale: canvas.width / vbW };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const lum = (d: Uint8ClampedArray, i: number) => (d[i] + d[i + 1] + d[i + 2]) / 3;

/**
 * Flood-fill the enclosed region around a scene point. Returns the boundary
 * polygon in scene coords, or null when the area isn't enclosed.
 */
export async function floodRegion(
  elements: any[],
  files: any,
  click: Pt,
  debug?: (info: Record<string, unknown>) => void,
): Promise<Pt[] | null> {
  let rast: Raster;
  try {
    rast = await rasterize(elements, files, debug);
  } catch (err) {
    debug?.({ stage: "raster-error", message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  const { data, w, h, offX, offY, scale } = rast;
  const sx = Math.round((click.x + offX) * scale);
  const sy = Math.round((click.y + offY) * scale);
  debug?.({ stage: "raster", w, h, offX, offY, scale, clickPx: [sx, sy] });
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
    debug?.({ stage: "bounds", verdict: "outside" });
    return null;
  }

  // Barriers = drawn pixels (anything clearly off-white), dilated 1px to
  // close hairline gaps in hand-drawn strokes.
  const bar = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lum(data, (y * w + x) * 4) < 238) bar[y * w + x] = 1;
    }
  }
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bar[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) dil[ny * w + nx] = 1;
        }
      }
    }
  }
  if (dil[sy * w + sx]) return null; // clicked straight onto ink
  let barrierCount = 0;
  for (let i = 0; i < dil.length; i++) if (dil[i]) barrierCount++;
  debug?.({ stage: "barriers", barrierCount });

  // 4-way flood. Caps are relative: tiny regions are fine, only
  // canvas-filling floods abort.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [sy * w + sx];
  seen[sy * w + sx] = 1;
  let touchedEdge = false;
  let count = 0;
  const maxCells = Math.floor(w * h * 0.95);
  while (stack.length > 0) {
    if (count++ > maxCells) return null; // open canvas, not a region
    const cur = stack.pop() as number;
    const cx = cur % w;
    const cy = (cur / w) | 0;
    if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchedEdge = true;
    if (cx > 0 && !seen[cur - 1] && !dil[cur - 1]) {
      seen[cur - 1] = 1;
      stack.push(cur - 1);
    }
    if (cx < w - 1 && !seen[cur + 1] && !dil[cur + 1]) {
      seen[cur + 1] = 1;
      stack.push(cur + 1);
    }
    if (cy > 0 && !seen[cur - w] && !dil[cur - w]) {
      seen[cur - w] = 1;
      stack.push(cur - w);
    }
    if (cy < h - 1 && !seen[cur + w] && !dil[cur + w]) {
      seen[cur + w] = 1;
      stack.push(cur + w);
    }
  }
  if (touchedEdge || count < 64) {
    debug?.({ stage: "flood", count, touchedEdge, verdict: "reject" });
    return null;
  }
  debug?.({ stage: "flood", count, touchedEdge, verdict: "ok" });

  // Marching squares on the filled mask -> longest loop wins (islands get
  // painted over).
  const contour = traceContour(seen, w, h);
  if (contour.length < 8) return null;
  let cArea2 = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    cArea2 += a.x * b.y - b.x * a.y;
  }
  const cArea = Math.abs(cArea2 / 2);
  if (!(cArea > 0) || Math.abs(cArea - count) / count > 0.6) {
    debug?.({ stage: "trace", contourLen: contour.length, cArea, count, verdict: "reject" });
    return null;
  }
  debug?.({ stage: "trace", contourLen: contour.length, cArea, count, verdict: "ok" });
  const scene = contour.map((p) => ({ x: p.x / scale - offX, y: p.y / scale - offY }));
  const simple = rdp(scene, 1.5);
  return simple.length >= 3 ? simple : null;
}

/**
 * Marching-squares contour extraction: per-cell edge segments from the
 * standard 16-case table, then greedy-joined into loops (longest wins).
 * Deterministic — no crawler state to go wrong.
 */
function traceContour(mask: Uint8Array, w: number, h: number): Pt[] {
  type Seg = [Pt, Pt];
  const segs: Seg[] = [];
  const CAP = 200000;
  for (let y = 0; y < h - 1 && segs.length < CAP; y++) {
    for (let x = 0; x < w - 1 && segs.length < CAP; x++) {
      const tl = mask[y * w + x] ? 1 : 0;
      const tr = mask[y * w + x + 1] ? 1 : 0;
      const br = mask[(y + 1) * w + x + 1] ? 1 : 0;
      const bl = mask[(y + 1) * w + x] ? 1 : 0;
      const idx = tl * 8 + tr * 4 + br * 2 + bl;
      if (idx === 0 || idx === 15) continue;
      const N: Pt = { x: x + 0.5, y };
      const E: Pt = { x: x + 1, y: y + 0.5 };
      const S: Pt = { x: x + 0.5, y: y + 1 };
      const W: Pt = { x, y: y + 0.5 };
      const ctr = (tl + tr + br + bl) / 4;
      switch (idx) {
        case 1:
        case 14:
          segs.push([W, S]);
          break;
        case 2:
        case 13:
          segs.push([S, E]);
          break;
        case 3:
        case 12:
          segs.push([W, E]);
          break;
        case 4:
        case 11:
          segs.push([N, E]);
          break;
        case 6:
        case 9:
          segs.push([N, S]);
          break;
        case 7:
        case 8:
          segs.push([N, W]);
          break;
        case 5:
          if (ctr >= 0.5) {
            segs.push([N, E]);
            segs.push([W, S]);
          } else {
            segs.push([N, W]);
            segs.push([S, E]);
          }
          break;
        case 10:
          if (ctr >= 0.5) {
            segs.push([N, W]);
            segs.push([S, E]);
          } else {
            segs.push([N, E]);
            segs.push([W, S]);
          }
          break;
      }
    }
  }
  if (segs.length === 0) return [];
  // Join segments into CLOSED loops. Index BOTH endpoints: marching-squares
  // segments have arbitrary orientation, so looking up only starts misses
  // every continuation that points into the current vertex (the walk then
  // dies mid-loop and yields a half contour).
  const key = (p: Pt) => `${p.x},${p.y}`;
  const byPoint = new Map<string, number[]>();
  const addIdx = (k: string, i: number) => {
    const l = byPoint.get(k);
    if (l) l.push(i);
    else byPoint.set(k, [i]);
  };
  segs.forEach((s, i) => {
    addIdx(key(s[0]), i);
    addIdx(key(s[1]), i);
  });
  const used = new Array<boolean>(segs.length).fill(false);
  let best: Pt[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    // Tentative walk: only committed when it closes back on its start.
    // Unclosed walks are discarded WITHOUT consuming segments, so a later
    // start can still complete the loop.
    const local = new Set<number>([i]);
    const loop: Pt[] = [segs[i][0], segs[i][1]];
    let closed = false;
    for (let guard = 0; guard < segs.length; guard++) {
      const end = loop[loop.length - 1];
      if (key(end) === key(loop[0]) && loop.length > 4) {
        closed = true;
        break;
      }
      const cand = (byPoint.get(key(end)) ?? []).find((j) => !used[j] && !local.has(j));
      if (cand === undefined) break;
      local.add(cand);
      const s = segs[cand];
      loop.push(key(s[0]) === key(end) ? s[1] : s[0]);
    }
    if (!closed) continue;
    for (const j of local) used[j] = true;
    if (loop.length > best.length) best = loop;
  }
  return best;
}
