// Path geometry: parse SVG path data, apply affine transforms, flatten curves into polylines.
// Figma's vectorPaths / fillGeometry use SVG path syntax (absolute M/L/Q/C/Z), but the parser
// accepts the full command set so pasted or exported SVG paths work too (arcs excepted).

export interface Point {
  x: number;
  y: number;
}

export type Polyline = Point[];

/** Affine matrix in Figma's layout: [[a, c, e], [b, d, f]]  →  x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Transform = [[number, number, number], [number, number, number]];

export const IDENTITY: Transform = [
  [1, 0, 0],
  [0, 1, 0],
];

type Segment =
  | { kind: "L"; to: Point }
  | { kind: "Q"; c: Point; to: Point }
  | { kind: "C"; c1: Point; c2: Point; to: Point };

export interface Subpath {
  start: Point;
  segments: Segment[];
  closed: boolean;
}

const TOKEN = /[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Parse SVG path data into absolute subpaths of line / quadratic / cubic segments. */
export function parsePathData(d: string): Subpath[] {
  const tokens = d.match(TOKEN) ?? [];
  const subpaths: Subpath[] = [];
  let i = 0;
  let cmd = "";
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let current: Subpath | null = null;
  // Reflection points for the smooth S/T variants.
  let lastCubicCtrl: Point | null = null;
  let lastQuadCtrl: Point | null = null;

  const isCommand = (t: string | undefined) => t !== undefined && /^[A-Za-z]$/.test(t);
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || isCommand(t)) throw new Error(`Malformed path data near token ${i}: ${d.slice(0, 80)}`);
    return Number(t);
  };
  const ensureSubpath = () => {
    if (!current) {
      current = { start: { ...cur }, segments: [], closed: false };
      subpaths.push(current);
    }
    return current;
  };

  while (i < tokens.length) {
    if (isCommand(tokens[i])) cmd = tokens[i++]!;
    else if (cmd === "") throw new Error("Path data must start with a command");
    const rel = cmd === cmd.toLowerCase();
    const abs = (x: number, y: number): Point => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });

    switch (cmd.toUpperCase()) {
      case "M": {
        cur = abs(num(), num());
        start = { ...cur };
        current = { start: { ...cur }, segments: [], closed: false };
        subpaths.push(current);
        // Subsequent coordinate pairs after a moveto are implicit linetos.
        cmd = rel ? "l" : "L";
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "L": {
        const to = abs(num(), num());
        ensureSubpath().segments.push({ kind: "L", to });
        cur = to;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "H": {
        const x = num();
        const to = { x: rel ? cur.x + x : x, y: cur.y };
        ensureSubpath().segments.push({ kind: "L", to });
        cur = to;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "V": {
        const y = num();
        const to = { x: cur.x, y: rel ? cur.y + y : y };
        ensureSubpath().segments.push({ kind: "L", to });
        cur = to;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "C": {
        const c1 = abs(num(), num());
        const c2 = abs(num(), num());
        const to = abs(num(), num());
        ensureSubpath().segments.push({ kind: "C", c1, c2, to });
        cur = to;
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        break;
      }
      case "S": {
        const c1: Point = lastCubicCtrl ? { x: 2 * cur.x - lastCubicCtrl.x, y: 2 * cur.y - lastCubicCtrl.y } : { ...cur };
        const c2 = abs(num(), num());
        const to = abs(num(), num());
        ensureSubpath().segments.push({ kind: "C", c1, c2, to });
        cur = to;
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        break;
      }
      case "Q": {
        const c: Point = abs(num(), num());
        const to = abs(num(), num());
        ensureSubpath().segments.push({ kind: "Q", c, to });
        cur = to;
        lastQuadCtrl = c;
        lastCubicCtrl = null;
        break;
      }
      case "T": {
        const c: Point = lastQuadCtrl ? { x: 2 * cur.x - lastQuadCtrl.x, y: 2 * cur.y - lastQuadCtrl.y } : { ...cur };
        const to = abs(num(), num());
        ensureSubpath().segments.push({ kind: "Q", c, to });
        cur = to;
        lastQuadCtrl = c;
        lastCubicCtrl = null;
        break;
      }
      case "Z": {
        const sp = ensureSubpath();
        sp.closed = true;
        cur = { ...start };
        current = null;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "A":
        throw new Error("Arc commands (A) are not supported; Figma geometry never emits them");
      default:
        throw new Error(`Unknown path command ${cmd}`);
    }
  }
  return subpaths;
}

export function applyTransform(p: Point, m: Transform): Point {
  return {
    x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
    y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
  };
}

/** a ∘ b : apply b first, then a. */
export function multiply(a: Transform, b: Transform): Transform {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
    ],
  ];
}

export function invert(m: Transform): Transform {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error("Transform is not invertible");
  return [
    [d / det, -c / det, (c * f - d * e) / det],
    [-b / det, a / det, (b * e - a * f) / det],
  ];
}

export function scale(s: number): Transform {
  return [
    [s, 0, 0],
    [0, s, 0],
  ];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to the line through a and b (or to a when a ≈ b). */
function lineDistance(p: Point, a: Point, b: Point): number {
  const len = dist(a, b);
  if (len < 1e-12) return dist(p, a);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
}

function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, tol: number, out: Point[], depth = 0): void {
  const flat = Math.max(lineDistance(p1, p0, p3), lineDistance(p2, p0, p3));
  if (flat <= tol || depth > 16) {
    out.push(p3);
    return;
  }
  // de Casteljau split at t = 0.5
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(p0, p01, p012, m, tol, out, depth + 1);
  flattenCubic(m, p123, p23, p3, tol, out, depth + 1);
}

/**
 * Transform subpaths and flatten them into polylines.
 * Transforming control points first is exact for affine maps, so `tolerance` is in output units.
 * Closed subpaths end on their start point.
 */
export function toPolylines(subpaths: Subpath[], m: Transform = IDENTITY, tolerance = 0.025): Polyline[] {
  const result: Polyline[] = [];
  for (const sp of subpaths) {
    let cur = applyTransform(sp.start, m);
    const line: Point[] = [cur];
    for (const seg of sp.segments) {
      const to = applyTransform(seg.to, m);
      if (seg.kind === "L") {
        line.push(to);
      } else if (seg.kind === "Q") {
        // Elevate the quadratic to a cubic.
        const c = applyTransform(seg.c, m);
        const c1 = { x: cur.x + (2 / 3) * (c.x - cur.x), y: cur.y + (2 / 3) * (c.y - cur.y) };
        const c2 = { x: to.x + (2 / 3) * (c.x - to.x), y: to.y + (2 / 3) * (c.y - to.y) };
        flattenCubic(cur, c1, c2, to, tolerance, line);
      } else {
        flattenCubic(cur, applyTransform(seg.c1, m), applyTransform(seg.c2, m), to, tolerance, line);
      }
      cur = to;
    }
    if (sp.closed && dist(line[line.length - 1]!, line[0]!) > 1e-9) line.push({ ...line[0]! });
    const cleaned = dedupe(line);
    if (cleaned.length >= 2) result.push(cleaned);
  }
  return result;
}

function dedupe(line: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of line) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 1e-6) out.push(p);
  }
  return out;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bounds(lines: Polyline[]): Bounds | null {
  let b: Bounds | null = null;
  for (const line of lines)
    for (const p of line) {
      if (!b) b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      else {
        b.minX = Math.min(b.minX, p.x);
        b.minY = Math.min(b.minY, p.y);
        b.maxX = Math.max(b.maxX, p.x);
        b.maxY = Math.max(b.maxY, p.y);
      }
    }
  return b;
}

/**
 * Order paths so that inner shapes are cut before the shapes that contain them
 * (a cut-out outer shape can shift on the mat and spoil later inner cuts).
 * Approximation: ascending bounding-box area, which puts every contained path first.
 */
export function orderInsideOut(lines: Polyline[]): Polyline[] {
  const area = (l: Polyline) => {
    const b = bounds([l])!;
    return (b.maxX - b.minX) * (b.maxY - b.minY);
  };
  return [...lines].sort((a, b) => area(a) - area(b));
}
