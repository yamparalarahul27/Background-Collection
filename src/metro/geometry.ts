/* ============================================================
   Path geometry for the metro schematic.

   A line's polyline becomes a list of segments with cumulative
   lengths. posAt(d) walks the path by distance and returns the
   point + heading — this is what moves the trains. Stations get
   a pathDist by projecting their (x, y) onto the nearest point
   of the path (projection, not vertex-matching, so nudging a
   station in the editor keeps its approach ring working).
   ============================================================ */

import type { Point } from './data';

export interface Segment {
  ax: number; ay: number;
  dx: number; dy: number;
  len: number;
  angle: number; // degrees
  cum: number;   // cumulative length at segment start
}

export interface Geometry {
  segs: Segment[];
  total: number;
  pathD: string;
  posAt(d: number): { x: number; y: number; angle: number };
  /** Like posAt, but extrapolates past the ends along the terminal segment —
      lets a multi-coach train slide in/out of a terminus instead of bunching. */
  posAtExt(d: number): { x: number; y: number; angle: number };
  distanceOf(x: number, y: number): number;
}

export function buildGeometry(pts: Point[], isLoop: boolean): Geometry {
  const segs: Segment[] = [];
  let total = 0;
  const n = pts.length;
  const count = isLoop ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    segs.push({ ax: a[0], ay: a[1], dx, dy, len, angle: Math.atan2(dy, dx) * 180 / Math.PI, cum: total });
    total += len;
  }

  function posAt(d: number) {
    d = ((d % total) + total) % total;
    for (const s of segs) {
      if (d <= s.len + 0.01) {
        const t = s.len > 0 ? d / s.len : 0;
        return { x: s.ax + t * s.dx, y: s.ay + t * s.dy, angle: s.angle };
      }
      d -= s.len;
    }
    return { x: segs[0].ax, y: segs[0].ay, angle: segs[0].angle };
  }

  /** Path distance of the closest point on the polyline to (x, y). */
  function distanceOf(x: number, y: number): number {
    let best = Infinity, bestDist = 0;
    for (const s of segs) {
      const lenSq = s.len * s.len;
      let t = lenSq > 0 ? ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = s.ax + t * s.dx, py = s.ay + t * s.dy;
      const dSq = (x - px) * (x - px) + (y - py) * (y - py);
      if (dSq < best) { best = dSq; bestDist = s.cum + t * s.len; }
    }
    return bestDist;
  }

  function posAtExt(d: number) {
    if (d < 0) {
      const s = segs[0];
      const u = s.len > 0 ? d / s.len : 0;
      return { x: s.ax + u * s.dx, y: s.ay + u * s.dy, angle: s.angle };
    }
    if (d > total) {
      const s = segs[segs.length - 1];
      const over = d - total;
      const u = s.len > 0 ? 1 + over / s.len : 1;
      return { x: s.ax + u * s.dx, y: s.ay + u * s.dy, angle: s.angle };
    }
    return posAt(d);
  }

  const pathD = isLoop
    ? `M ${pts[0].join(',')} ${pts.slice(1).map(p => `L ${p.join(',')}`).join(' ')} Z`
    : `M ${pts[0].join(',')} ${pts.slice(1).map(p => `L ${p.join(',')}`).join(' ')}`;

  return { segs, total, pathD, posAt, posAtExt, distanceOf };
}

/* ---------- parallel track offsetting ----------
   Double-track rendering: each direction's track is the centreline
   offset perpendicular by ±o. Positive o = left of travel (matching
   left-hand running). Corners are mitered by intersecting the two
   adjacent offset lines — fine for schematic 45°/90° bends. */

export function offsetPolyline(pts: Point[], o: number): Point[] {
  if (pts.length < 2) return pts.slice();
  // Per-segment unit left-normals (screen coords, y down).
  const normals: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([dy / len, -dx / len]);
  }
  const out: Point[] = [];
  out.push([pts[0][0] + normals[0][0] * o, pts[0][1] + normals[0][1] * o]);
  for (let i = 1; i < pts.length - 1; i++) {
    const nA = normals[i - 1], nB = normals[i];
    const a: Point = [pts[i][0] + nA[0] * o, pts[i][1] + nA[1] * o];
    const b: Point = [pts[i][0] + nB[0] * o, pts[i][1] + nB[1] * o];
    const dA: Point = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    const dB: Point = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]];
    const cross = dA[0] * dB[1] - dA[1] * dB[0];
    if (Math.abs(cross) < 1e-6) {
      out.push(a); // collinear — no corner
    } else {
      // Intersect line (a, dA) with line (b, dB).
      const t = ((b[0] - a[0]) * dB[1] - (b[1] - a[1]) * dB[0]) / cross;
      out.push([a[0] + dA[0] * t, a[1] + dA[1] * t]);
    }
  }
  const nZ = normals[normals.length - 1];
  const last = pts[pts.length - 1];
  out.push([last[0] + nZ[0] * o, last[1] + nZ[1] * o]);
  return out;
}

export function polylinePathD(pts: Point[]): string {
  return `M ${pts[0].join(',')} ${pts.slice(1).map(p => `L ${p.join(',')}`).join(' ')}`;
}

/* ---------- corner rounding ----------
   Replaces each interior corner with a sampled quadratic fillet so
   tracks curve like real alignments. Returning a densified polyline
   (rather than bezier path commands) keeps everything downstream —
   train motion, offsetting, distance projection — working unchanged
   on straight segments. */

export function roundCorners(pts: Point[], radius: number, samples = 8): Point[] {
  if (pts.length < 3) return pts.slice();
  const out: Point[] = [pts[0].slice() as Point];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1];
    const vAx = p[0] - a[0], vAy = p[1] - a[1];
    const vBx = b[0] - p[0], vBy = b[1] - p[1];
    const lA = Math.hypot(vAx, vAy) || 1, lB = Math.hypot(vBx, vBy) || 1;
    const uAx = vAx / lA, uAy = vAy / lA, uBx = vBx / lB, uBy = vBy / lB;
    const cross = uAx * uBy - uAy * uBx;
    if (Math.abs(cross) < 1e-4) { out.push(p.slice() as Point); continue; }
    const dot = Math.max(-1, Math.min(1, uAx * uBx + uAy * uBy));
    const turn = Math.acos(dot);
    // Tangent length for the fillet, clamped so adjacent corners never overlap.
    const t = Math.min(radius * Math.tan(turn / 2), lA / 2 - 1, lB / 2 - 1);
    if (t <= 0.5) { out.push(p.slice() as Point); continue; }
    const p1x = p[0] - uAx * t, p1y = p[1] - uAy * t;
    const p2x = p[0] + uBx * t, p2y = p[1] + uBy * t;
    for (let s = 0; s <= samples; s++) {
      const u = s / samples, w = 1 - u;
      out.push([w * w * p1x + 2 * w * u * p[0] + u * u * p2x,
                w * w * p1y + 2 * w * u * p[1] + u * u * p2y]);
    }
  }
  out.push(pts[pts.length - 1].slice() as Point);
  return out;
}
