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

  const pathD = isLoop
    ? `M ${pts[0].join(',')} ${pts.slice(1).map(p => `L ${p.join(',')}`).join(' ')} Z`
    : `M ${pts[0].join(',')} ${pts.slice(1).map(p => `L ${p.join(',')}`).join(' ')}`;

  return { segs, total, pathD, posAt, distanceOf };
}
