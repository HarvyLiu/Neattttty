// Shape tools for Neattttty: Draw-to-shape recognition + bucket flood fill.
//
// The official npm package is frozen at 0.18.1, which predates upstream's
// bucket fill (#11799) and draw-to-shape (#9313). This re-implements both
// with the same pipelines: stroke analysis -> clean element replacement,
// and rasterize -> flood fill -> vectorize-to-polygon.

import { exportToSvg } from "@excalidraw/excalidraw";
import { uid } from "./scenes";

export interface Pt {
  x: number;
  y: number;
}

export const DRAW_SHAPE_KEY = "neattttty.drawshape.v1";
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

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

function bboxOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Resample a polyline to n equidistant points (for stable analysis). */
function resample(pts: Pt[], n = 64): Pt[] {
  const L = pathLength(pts);
  if (L === 0 || pts.length < 2) return [...pts];
  const step = L / (n - 1);
  const out: Pt[] = [{ ...pts[0] }];
  let acc = 0;
  let prev = pts[0];
  for (let i = 1; i < pts.length && out.length < n - 1; i++) {
    const cur = pts[i];
    let d = dist(prev, cur);
    while (acc + d >= step && out.length < n - 1) {
      const t = (step - acc) / d;
      const p = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
      out.push(p);
      prev = p;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  out.push({ ...pts[pts.length - 1] });
  return out;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return dist(p, a);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

/** Ramer-Douglas-Peucker corner simplification. */
export function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return [...pts];
  const first = pts[0];
  const last = pts[pts.length - 1];
  let idx = -1;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], first, last);
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

function angleAt(a: Pt, b: Pt, c: Pt): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const d1 = Math.hypot(v1.x, v1.y);
  const d2 = Math.hypot(v2.x, v2.y);
  if (d1 === 0 || d2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (d1 * d2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export type ShapeKind = "line" | "rectangle" | "ellipse" | "triangle" | "diamond";

export interface Recognized {
  kind: ShapeKind;
  box: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Recognize a freehand stroke (absolute scene coords) as a clean shape.
 * Returns null when nothing matches — the caller keeps the original stroke.
 */
export function recognizeStroke(abs: Pt[]): Recognized | null {
  if (abs.length < 6) return null;
  const box = bboxOf(abs);
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (Math.max(w, h) < 24) return null;
  const pts = resample(abs, 64);
  const L = pathLength(pts);
  if (L < 30) return null;
  const closed = dist(pts[0], pts[pts.length - 1]) < 0.14 * L;

  if (!closed) {
    // Straight open stroke -> line (needs length along >> across).
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, perpDist(p, pts[0], pts[pts.length - 1]));
    const span = dist(pts[0], pts[pts.length - 1]);
    if (span > 30 && maxDev < Math.max(6, 0.045 * L)) return { kind: "line", box };
    return null;
  }

  const diag = Math.hypot(w, h);
  const corners = rdp(pts, Math.max(2.5, 0.022 * diag));
  // Drop the duplicated closure point if present.
  const verts =
    corners.length > 2 && dist(corners[0], corners[corners.length - 1]) < 0.03 * L
      ? corners.slice(0, -1)
      : corners;

  if (verts.length === 3) return { kind: "triangle", box };
  if (verts.length === 4) {
    const angs = [0, 1, 2, 3].map((i) => angleAt(verts[i], verts[(i + 1) % 4], verts[(i + 2) % 4]));
    const rightish = angs.filter((a) => a > 70 && a < 110).length;
    // Diamond: vertices sit near edge midpoints (top/right/bottom/left).
    const nx = verts.map((v) => (v.x - box.minX) / (w || 1));
    const ny = verts.map((v) => (v.y - box.minY) / (h || 1));
    const order = [...nx.keys()].sort((a, b) => ny[a] - ny[b]);
    const diamondish =
      Math.abs(nx[order[0]] - 0.5) < 0.22 &&
      Math.abs(ny[order[0]]) < 0.22 &&
      Math.abs(nx[order[3]] - 0.5) < 0.22 &&
      Math.abs(ny[order[3]] - 1) < 0.22;
    if (diamondish && rightish < 4) return { kind: "diamond", box };
    if (rightish >= 3) return { kind: "rectangle", box };
    return null;
  }
  // Round closed blob -> ellipse (needs circularity).
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  const circularity = (4 * Math.PI * Math.abs(area2 / 2)) / (L * L || 1);
  if (verts.length <= 8 && circularity > 0.72) return { kind: "ellipse", box };
  return null;
}

export interface ShapeStyle {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  roughness: number;
}

/**
 * Build a clean element partial for a recognized shape. Triangles have no
 * native type, so they become closed freedraw polygons (same look).
 */
export function shapeToPartial(kind: ShapeKind, box: { minX: number; minY: number; maxX: number; maxY: number }, style: ShapeStyle): any {
  const w = Math.max(2, box.maxX - box.minX);
  const h = Math.max(2, box.maxY - box.minY);
  const base = {
    id: uid(),
    x: box.minX,
    y: box.minY,
    width: w,
    height: h,
    angle: 0,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    roughness: style.roughness,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: kind === "ellipse" ? { type: 3 } : null,
    boundElements: [],
    link: null,
    locked: false,
  };
  if (kind === "triangle") {
    return {
      ...base,
      type: "freedraw",
      points: [
        [w / 2, 0],
        [w, h],
        [0, h],
        [w / 2, 0],
      ],
      simulatePressure: false,
    };
  }
  if (kind === "line") {
    return { ...base, height: Math.max(2, h), type: "line", points: [[0, 0], [w, h]], startBinding: null, endBinding: null };
  }
  return { ...base, type: kind };
}

// ---------------------------------------------------------------------------
// Bucket fill: rasterize -> flood fill -> vectorize to polygon.
// ---------------------------------------------------------------------------

/** Absolute scene coords of a freedraw/linear element's points. */
export function absolutePoints(e: any): Pt[] {
  const ox = typeof e?.x === "number" ? e.x : 0;
  const oy = typeof e?.y === "number" ? e.y : 0;
  return ((e?.points ?? []) as number[][]).map((p) => ({ x: ox + p[0], y: oy + p[1] }));
}

interface Raster {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  /** scene coords of raster pixel (px, py) */
  vbX: number;
  vbY: number;
  scale: number; // raster px per scene unit
}

/** Render elements to a pixel buffer with an exact scene mapping (via SVG viewBox). */
async function rasterize(elements: any[], files: any): Promise<Raster> {
  const svg = await exportToSvg({
    elements,
    appState: { viewBackgroundColor: "#ffffff" } as any,
    files: files ?? {},
  } as any);
  const text = new XMLSerializer().serializeToString(svg);
  const vb = text.match(/viewBox="([\d.\-eE+ ]+)"/);
  const wm = text.match(/<svg[^>]*\bwidth="([\d.]+)"/);
  if (!vb || !wm) throw new Error("Could not rasterize the scene");
  const [vbX, vbY, vbW, vbH] = vb[1].trim().split(/\s+/).map(Number);
  const cw = Number(wm[1]);
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
    return { data: px.data, w: canvas.width, h: canvas.height, vbX, vbY, scale: (canvas.width / vbW) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const lum = (d: Uint8ClampedArray, i: number) => (d[i] + d[i + 1] + d[i + 2]) / 3;

/**
 * Flood-fill the enclosed region around a scene point. Returns the boundary
 * polygon in scene coords, or null when the area isn't enclosed (or is tiny).
 */
export async function floodRegion(
  elements: any[],
  files: any,
  click: Pt,
): Promise<Pt[] | null> {
  const rast = await rasterize(elements, files);
  const { data, w, h, vbX, vbY, scale } = rast;
  const sx = Math.round((click.x - vbX) * scale);
  const sy = Math.round((click.y - vbY) * scale);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

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

  // 4-way flood.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [sy * w + sx];
  seen[sy * w + sx] = 1;
  let touchedEdge = false;
  let count = 0;
  const maxCells = 1400 * 1400;
  while (stack.length > 0) {
    if (count++ > maxCells) return null; // absurdly large = open canvas
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
  if (touchedEdge || count < 400) return null;

  // Marching squares on the filled mask -> contour (pixel coords).
  const contour = traceContour(seen, w, h);
  if (contour.length < 8) return null;
  const scene = contour.map((p) => ({ x: vbX + p.x / scale, y: vbY + p.y / scale }));
  const simple = rdp(scene, 1.5);
  return simple.length >= 3 ? simple : null;
}

/** Isometric marching-squares contour trace with linear interpolation. */
function traceContour(mask: Uint8Array, w: number, h: number): Pt[] {
  const idx = (x: number, y: number) => y * w + x;
  const val = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[idx(x, y)];
  // Find a boundary start: filled cell with an empty left neighbor.
  let sx = -1;
  let sy = -1;
  outer: for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (mask[idx(x, y)] && !mask[idx(x - 1, y)]) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return [];
  const pts: Pt[] = [];
  // Moore-neighbor boundary following (clockwise), capped.
  let cx = sx;
  let cy = sy;
  let dx = 0;
  let dy = -1; // backtrack direction: came from the west
  const cap = w * h;
  for (let n = 0; n < cap; n++) {
    pts.push({ x: cx, y: cy });
    // Clockwise neighbor order starting after the backtrack direction.
    const order = [
      [dx, dy],
      [-dy, dx],
      [-dx, -dy],
      [dy, -dx],
    ];
    // Rotate so we check in boundary order: left-hand rule from entry dir.
    const seq = [order[3], order[0], order[1], order[2]];
    let moved = false;
    for (const [ox, oy] of seq) {
      const nx = cx + ox;
      const ny = cy + oy;
      if (val(nx, ny)) {
        dx = -ox;
        dy = -oy;
        cx = nx;
        cy = ny;
        moved = true;
        break;
      }
    }
    if (!moved) break;
    if (cx === sx && cy === sy && pts.length > 8) break;
  }
  return pts;
}
