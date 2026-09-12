// Shape tools for Neattttty: Draw-to-shape recognition + bucket flood fill.
//
// The official npm package is frozen at 0.18.1, which predates upstream's
// bucket fill (#11799) and draw-to-shape (#9313, "autoshape").
//   - Draw-to-shape recognition is ported nearly verbatim from upstream's
//     `packages/element/src/convertToShape.ts` (MIT (c) Excalidraw team):
//     moment-based features (PCA elongation/skew/kurtosis, hull fill,
//     corner-turn share, shaft deviation) matched against shape prototypes.
//     Triangle extras, element construction, and all editor wiring are ours.
//   - Bucket fill keeps our rasterize -> flood -> vectorize pipeline (the
//     upstream planar-arrangement engine is woven into monorepo internals
//     that don't exist in 0.18.1), with upstream's tolerances (6px gap
//     bridging, tiny min-area) applied.

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

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Ramer-Douglas-Peucker corner simplification. */
export function rdp(pts: Pt[], eps: number): Pt[] {
  const perp = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return dist(p, a);
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
// Upstream-ported shape recognition (moment-based, after convertToShape.ts).
// -----------------------------------------------------------------------------

export type RecognizedKind = "rectangle" | "diamond" | "ellipse" | "arrow" | "line" | "triangle" | "freedraw";

export interface ShapeRecognition {
  type: RecognizedKind;
  points: Pt[];
  /** [minX, minY, maxX, maxY] in the points' own coordinate frame. */
  boundingBox: [number, number, number, number];
}

const RESAMPLE_N = 64;
const RECOGNITION_MIN_SCREEN_SIZE = 25;
const CLOSED_GAP_MAX_RATIO = 0.15;
const LINEAR_MAX_ELONGATION = 0.25;
const ARROWHEAD_ZONE_RATIO = 0.5;
const LINEAR_MAX_SHAFT_DEVIATION = 0.15;
const ARROW_MIN_SKEW = 0.3;
const CLOSED_SHAPE_MAX_DISTANCE = 1.5;
const TURN_WINDOW = 3;
const HULL_FILL_RATIO_TOLERANCE = 0.2;
const CORNER_TURN_SHARE_TOLERANCE = 0.2;
const KURTOSIS_PRODUCT_TOLERANCE = 0.7;

const CLOSED_SHAPE_PROTOTYPES = [
  { type: "rectangle", hullFillRatio: 1, cornerTurnShare: 0.95, kurtosisProduct: 1.83 },
  { type: "diamond", hullFillRatio: 0.5, cornerTurnShare: 0.95, kurtosisProduct: 3.24 },
  { type: "ellipse", hullFillRatio: Math.PI / 4, cornerTurnShare: 0.55, kurtosisProduct: 2.25 },
] as const;

function resampleUpstream(pts: Pt[], n: number): Pt[] {
  let totalLen = 0;
  for (let i = 1; i < pts.length; i++) totalLen += dist(pts[i], pts[i - 1]);
  const interval = totalLen / (n - 1);
  let accumulated = 0;
  const result: Pt[] = [{ ...pts[0] }];
  let prev = pts[0];
  for (let i = 1; i < pts.length && result.length < n; i++) {
    const curr = pts[i];
    const segLen = dist(curr, prev);
    if (accumulated + segLen >= interval) {
      let remaining = interval - accumulated;
      while (remaining <= segLen + 1e-10) {
        const t = segLen === 0 ? 0 : remaining / segLen;
        const p = { x: prev.x + t * (curr.x - prev.x), y: prev.y + t * (curr.y - prev.y) };
        result.push(p);
        if (result.length === n) return result;
        prev = p;
        accumulated = 0;
        remaining += interval;
      }
      accumulated = segLen - (remaining - interval);
    } else {
      accumulated += segLen;
    }
    prev = curr;
  }
  while (result.length < n) result.push({ ...pts[pts.length - 1] });
  return result;
}

function getBoundsFromPoints(pts: Pt[]): [number, number, number, number] {
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
  return [minX, minY, maxX, maxY];
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function convexHull(pts: Pt[]): Pt[] {
  const sorted = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (sorted.length <= 1) return sorted;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function polygonAreaAbs(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

/** 2x2 PCA: principal (major, minor) axes + eigenvalues, largest first. */
function principalAxes(pts: Pt[]): { major: Pt; minor: Pt; l1: number; l2: number } {
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= n;
  syy /= n;
  sxy /= n;
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (trace / 2) * (trace / 2) - det));
  const l1 = trace / 2 + disc;
  const l2 = Math.max(0, trace / 2 - disc);
  let major: Pt;
  if (Math.abs(sxy) < 1e-12) {
    major = sxx >= syy ? { x: 1, y: 0 } : { x: 0, y: 1 };
  } else {
    major = { x: sxy, y: l1 - sxx };
    const len = Math.hypot(major.x, major.y) || 1;
    major = { x: major.x / len, y: major.y / len };
  }
  return { major, minor: { x: -major.y, y: major.x }, l1, l2 };
}

function moment(values: number[], order: 2 | 3 | 4): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  let m2 = 0;
  let mk = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    mk += Math.pow(d, order);
  }
  m2 /= n;
  mk /= n;
  if (m2 <= 0) return 0;
  return order === 2 ? m2 : mk / Math.pow(m2, order / 2);
}

interface StrokeFeatures {
  gapRatio: number;
  elongation: number;
  majorSkew: number;
  hullFillRatio: number;
  cornerTurnShare: number;
  kurtosisProduct: number;
  shaftDeviationRatio: number;
}

function shaftDeviationRatio(pts: Pt[]): number {
  const start = pts[0];
  let tip = start;
  let tipDistance = 0;
  for (const p of pts) {
    const d = dist(p, start);
    if (d > tipDistance) {
      tipDistance = d;
      tip = p;
    }
  }
  if (tipDistance === 0) return 0;
  let maxDev = 0;
  for (const p of pts) {
    if (dist(p, tip) <= ARROWHEAD_ZONE_RATIO * tipDistance) continue;
    maxDev = Math.max(maxDev, distToSegment(p, start, tip));
  }
  return maxDev / tipDistance;
}

function windowedTurns(pts: Pt[]): number[] {
  const turns: number[] = [];
  for (let i = TURN_WINDOW; i < pts.length - TURN_WINDOW; i++) {
    const a = pts[i - TURN_WINDOW];
    const b = pts[i];
    const c = pts[i + TURN_WINDOW];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    turns.push(Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)));
  }
  return turns;
}

function cornerTurnShare(pts: Pt[]): number {
  const turns = windowedTurns(pts);
  const total = turns.reduce((s, t) => s + t, 0);
  if (total === 0) return 0;
  const taken = new Array<boolean>(turns.length).fill(false);
  let top4 = 0;
  for (let c = 0; c < 4; c++) {
    let peak = -1;
    let peakTurn = 0;
    for (let i = 0; i < turns.length; i++) {
      if (!taken[i] && turns[i] > peakTurn) {
        peakTurn = turns[i];
        peak = i;
      }
    }
    if (peak < 0) break;
    for (let i = peak - TURN_WINDOW; i <= peak + TURN_WINDOW; i++) {
      if (i >= 0 && i < turns.length && !taken[i]) {
        top4 += turns[i];
        taken[i] = true;
      }
    }
  }
  return top4 / total;
}

function extractFeatures(points: Pt[]): StrokeFeatures {
  const pts = resampleUpstream(points, RESAMPLE_N);
  let path = 0;
  for (let i = 1; i < pts.length; i++) path += dist(pts[i], pts[i - 1]);
  const gap = dist(pts[pts.length - 1], pts[0]);
  const { major, l1, l2 } = principalAxes(pts);
  // Orient the major axis so skew is <= 0 by construction (upstream).
  let mx = major.x;
  let my = major.y;
  const proj0 = pts.map((p) => p.x * mx + p.y * my);
  const skew0 = moment(proj0, 3);
  if (skew0 > 0) {
    mx = -mx;
    my = -my;
  }
  const proj = pts.map((p) => p.x * mx + p.y * my);
  const hull = convexHull(pts);
  const [minX, minY, maxX, maxY] = getBoundsFromPoints(pts);
  const boxArea = (maxX - minX) * (maxY - minY);
  return {
    gapRatio: path > 0 ? gap / path : 0,
    elongation: l1 > 0 ? Math.sqrt(Math.max(0, l2 / l1)) : 0,
    majorSkew: moment(proj, 3),
    hullFillRatio: boxArea > 0 ? polygonAreaAbs(hull) / boxArea : 0,
    cornerTurnShare: cornerTurnShare(pts),
    kurtosisProduct:
      moment(
        pts.map((p) => p.x),
        4,
      ) *
      moment(
        pts.map((p) => p.y),
        4,
      ),
    shaftDeviationRatio: shaftDeviationRatio(pts),
  };
}

type ClosedKind = "rectangle" | "diamond" | "ellipse";

function classifyClosedStroke(f: StrokeFeatures): ClosedKind | "freedraw" {
  let best: ClosedKind | "freedraw" = "freedraw";
  let bestDistance = CLOSED_SHAPE_MAX_DISTANCE;
  for (const p of CLOSED_SHAPE_PROTOTYPES) {
    const distance = Math.hypot(
      (f.hullFillRatio - p.hullFillRatio) / HULL_FILL_RATIO_TOLERANCE,
      (f.cornerTurnShare - p.cornerTurnShare) / CORNER_TURN_SHARE_TOLERANCE,
      (f.kurtosisProduct - p.kurtosisProduct) / KURTOSIS_PRODUCT_TOLERANCE,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p.type;
    }
  }
  return best;
}

function classifyOpenStroke(f: StrokeFeatures): "arrow" | "line" | "freedraw" {
  if (f.elongation > LINEAR_MAX_ELONGATION || f.shaftDeviationRatio > LINEAR_MAX_SHAFT_DEVIATION) {
    return "freedraw";
  }
  return Math.abs(f.majorSkew) >= ARROW_MIN_SKEW ? "arrow" : "line";
}

/** Upstream supplement: triangles have no prototype, detect via 3 corners. */
function isTriangleStroke(pts: Pt[], pathLen: number): boolean {
  const diag = Math.hypot(
    Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)),
    Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)),
  );
  for (const k of [1, 2]) {
    const corners = rdp(pts, Math.max(2.5, 0.022 * diag * k));
    const verts =
      corners.length > 2 && dist(corners[0], corners[corners.length - 1]) < 0.03 * pathLen
        ? corners.slice(0, -1)
        : corners;
    if (verts.length === 3) return true;
  }
  return false;
}

/**
 * Recognize a freehand stroke (absolute scene coords). Returns the shape
 * type plus the original points and bbox for element construction.
 */
export function recognizeShape(points: Pt[], zoom = 1): ShapeRecognition {
  const boundingBox = getBoundsFromPoints(points);
  const [minX, minY, maxX, maxY] = boundingBox;
  const maxDim = Math.max(maxX - minX, maxY - minY);
  if (points.length < 3 || maxDim * zoom < RECOGNITION_MIN_SCREEN_SIZE) {
    return { type: "freedraw", points, boundingBox };
  }
  const features = extractFeatures(points);
  let type: RecognizedKind =
    features.gapRatio > CLOSED_GAP_MAX_RATIO
      ? classifyOpenStroke(features)
      : classifyClosedStroke(features);
  if (type === "freedraw" && features.gapRatio <= CLOSED_GAP_MAX_RATIO) {
    let path = 0;
    for (let i = 1; i < points.length; i++) path += dist(points[i], points[i - 1]);
    if (isTriangleStroke(points, path)) type = "triangle";
  }
  return { type, points, boundingBox };
}

/** Arrow tip = bbox-perimeter point farthest from the drawn start. */
function getArrowEndpoint(points: Pt[], boundingBox: [number, number, number, number], start: Pt): Pt {
  const [minX, minY, maxX, maxY] = boundingBox;
  const w = maxX - minX;
  const h = maxY - minY;
  if (w === 0 && h === 0) return points[points.length - 1];
  const perimeter: Pt[] = [
    { x: minX, y: minY },
    { x: (minX + maxX) / 2, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: (minY + maxY) / 2 },
    { x: maxX, y: maxY },
    { x: (minX + maxX) / 2, y: maxY },
    { x: minX, y: maxY },
    { x: minX, y: (minY + maxY) / 2 },
  ];
  let ideal = { x: maxX, y: maxY };
  let idealDist = -1;
  for (const pp of perimeter) {
    const d = dist(pp, start);
    if (d > idealDist) {
      idealDist = d;
      ideal = pp;
    }
  }
  let best = points[points.length - 1];
  let bestDist = Infinity;
  for (const pt of points) {
    const d = dist(pt, ideal);
    if (d < bestDist) {
      bestDist = d;
      best = pt;
    }
  }
  return best;
}

export interface ShapeStyle {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  roughness: number;
  opacity: number;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  frameId?: string | null;
}

/**
 * Build a clean element partial from a recognition result. Lines/arrows are
 * normalized to positive width/height; triangles (no native type) become
 * closed freedraw polygons.
 */
export function buildRecognizedElement(rec: ShapeRecognition, style: ShapeStyle): any {
  const [minX, minY, maxX, maxY] = rec.boundingBox;
  const w = Math.max(2, maxX - minX);
  const h = Math.max(2, maxY - minY);
  const base = {
    id: uid(),
    x: minX,
    y: minY,
    width: w,
    height: h,
    angle: 0,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    roughness: style.roughness,
    opacity: style.opacity,
    groupIds: [],
    frameId: style.frameId ?? null,
    boundElements: [],
    link: null,
    locked: false,
  };
  if (rec.type === "triangle") {
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
  if (rec.type === "line" || rec.type === "arrow") {
    const p0 = rec.points[0];
    let p1 = rec.points[rec.points.length - 1];
    if (rec.type === "arrow") {
      p1 = getArrowEndpoint(rec.points, rec.boundingBox, p0);
      const len = dist(p0, p1);
      if (len < 60) {
        // short arrow-looking scribble: plain line instead (upstream rule)
        const lx = Math.min(p0.x, p1.x);
        const ly = Math.min(p0.y, p1.y);
        return {
          ...base,
          type: "line",
          x: lx,
          y: ly,
          width: Math.max(2, Math.abs(p1.x - p0.x)),
          height: Math.max(2, Math.abs(p1.y - p0.y)),
          points: [
            [p0.x - lx, p0.y - ly],
            [p1.x - lx, p1.y - ly],
          ],
          startBinding: null,
          endBinding: null,
        };
      }
    }
    const lx = Math.min(p0.x, p1.x);
    const ly = Math.min(p0.y, p1.y);
    return {
      ...base,
      type: rec.type,
      x: lx,
      y: ly,
      width: Math.max(2, Math.abs(p1.x - p0.x)),
      height: Math.max(2, Math.abs(p1.y - p0.y)),
      points: [
        [p0.x - lx, p0.y - ly],
        [p1.x - lx, p1.y - ly],
      ],
      startBinding: null,
      endBinding: null,
      startArrowhead: rec.type === "arrow" ? (style.startArrowhead ?? null) : undefined,
      endArrowhead: rec.type === "arrow" ? (style.endArrowhead ?? "arrow") : undefined,
    };
  }
  return { ...base, type: rec.type };
}

// -----------------------------------------------------------------------------
// Bucket fill: rasterize -> flood fill -> vectorize to polygon.
// -----------------------------------------------------------------------------

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
  const vb = text.match(/viewBox="([^"]+)"/);
  const wm = text.match(/<svg[^>]*\bwidth="([\d.]+)"/);
  if (!vb || !wm) throw new Error("Could not rasterize the scene");
  const nums = vb[1].trim().split(/[\s,]+/).map(Number);
  if (nums.length < 4 || nums.some((n) => !isFinite(n))) throw new Error("Could not rasterize the scene");
  const [vbX, vbY, vbW, vbH] = nums;
  if (!(vbW > 0) || !(vbH > 0)) throw new Error("Could not rasterize the scene");
  const cw = Number(wm[1]);
  if (!(cw > 0)) throw new Error("Could not rasterize the scene");
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
    return { data: px.data, w: canvas.width, h: canvas.height, vbX, vbY, scale: canvas.width / vbW };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const lum = (d: Uint8ClampedArray, i: number) => (d[i] + d[i + 1] + d[i + 2]) / 3;

/**
 * Flood-fill the enclosed region around a scene point. Returns the boundary
 * polygon in scene coords, or null when the area isn't enclosed.
 */
export async function floodRegion(elements: any[], files: any, click: Pt): Promise<Pt[] | null> {
  const rast = await rasterize(elements, files);
  const { data, w, h, vbX, vbY, scale } = rast;
  const sx = Math.round((click.x - vbX) * scale);
  const sy = Math.round((click.y - vbY) * scale);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

  // Barriers = drawn pixels (anything clearly off-white), dilated 1px to
  // close hairline gaps in hand-drawn strokes (upstream bridges ~6 scene px).
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

  // 4-way flood. Caps are relative to the raster: tiny regions are fine
  // (upstream min-area is ~4 scene px²), only canvas-filling floods abort.
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
  if (touchedEdge || count < 64) return null;

  // Marching squares on the filled mask -> longest loop wins (islands get
  // painted over, matching upstream's pre-hole-support behavior).
  const contour = traceContour(seen, w, h);
  if (contour.length < 8) return null;
  let cArea2 = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    cArea2 += a.x * b.y - b.x * a.y;
  }
  const cArea = Math.abs(cArea2 / 2);
  if (!(cArea > 0) || Math.abs(cArea - count) / count > 0.6) return null;
  const scene = contour.map((p) => ({ x: vbX + p.x / scale, y: vbY + p.y / scale }));
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
  // Join segments into loops via shared endpoints (0.5-grid => exact keys).
  const key = (p: Pt) => `${p.x},${p.y}`;
  const byStart = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const k = key(s[0]);
    const l = byStart.get(k);
    if (l) l.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Array<boolean>(segs.length).fill(false);
  let best: Pt[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop: Pt[] = [segs[i][0], segs[i][1]];
    for (let guard = 0; guard < segs.length; guard++) {
      const end = loop[loop.length - 1];
      if (key(end) === key(loop[0]) && loop.length > 4) break;
      const cand = (byStart.get(key(end)) ?? []).find((j) => !used[j]);
      if (cand === undefined) break;
      used[cand] = true;
      const s = segs[cand];
      loop.push(key(s[0]) === key(end) ? s[1] : s[0]);
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}
