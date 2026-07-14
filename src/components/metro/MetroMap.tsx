'use client';

/* ============================================================
   NAMMA METRO — interactive schematic map of Bengaluru's metro.

   A React port of the hand-tuned Tokyo Transit map concept:
   - polyline geometry engine drives trains by path distance
   - dashed approach rings pulse as trains near stations
   - click a line to focus it, click a station for details
   - day/night mode with headlamps, warm windows, ambient glow
   - Ctrl+Shift+D opens the Station Editor (nudge positions,
     labels, orientation — export a Claude-ready diff)

   Static SVG is rendered declaratively; the animation loop
   mutates only train transforms and ring opacities via refs.
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LINE_MAP, lineData, buildStationMap, ORIENT_DEFAULTS,
  MAP_CX, MAP_CY, LEGEND_FOOTER,
  type LabelDir, type PillOrient, type Station, type Point,
} from '@/metro/data';
import { buildGeometry, offsetPolyline, polylinePathD, roundCorners, type Geometry } from '@/metro/geometry';
import { TUNNELS } from '@/metro/data';
import {
  COMPRESS, buildProfile, distAt, poolSize, currentHeadway,
  istHour, isPeak, SERVICE_START, SERVICE_END, type Profile,
} from '@/metro/service';

const APPROACH_DIST = 80;
const DASH_SPEED = 12;
/** Left-hand running: each direction's track (and its trains) sits this many
    px to the left of the direction of travel. */
const TRACK_OFFSET = 4;
const TRACK_WIDTH = 2.5;
/** Fillet radius for track corners. */
const CURVE_RADIUS = 18;
/** Centre-to-centre distance between coaches of a trainset. */
const COACH_SPACING = 9.7;

/* ---------- Overrides (Station Editor) ---------- */

interface StationOverride {
  x?: number; y?: number;
  label?: LabelDir;
  orient?: PillOrient;
  en?: string; kn?: string;
}
type Overrides = Record<string, StationOverride>;

const LS_KEY = 'nm-station-overrides';

function loadOverrides(): Overrides {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}

/* ---------- Label offset recipes ---------- */

function labelOffsets(dir: LabelDir) {
  switch (dir) {
    case 'top':    return { enDx: 0,   enDy: -24, knDx: 0,   knDy: -13, anchor: 'middle' as const };
    case 'bottom': return { enDx: 0,   enDy: 23,  knDx: 0,   knDy: 34,  anchor: 'middle' as const };
    case 'right':  return { enDx: 19,  enDy: -2,  knDx: 19,  knDy: 9,   anchor: 'start' as const };
    case 'left':   return { enDx: -19, enDy: -2,  knDx: -19, knDy: 9,   anchor: 'end' as const };
  }
}

/* ---------- Pill sizing for interchange stations ---------- */

function pillSize(n: number, orient: PillOrient) {
  const cSp = 9;
  if (orient === 'V') return { pw: 13, ph: (n - 1) * cSp + 13 };
  return { pw: (n - 1) * cSp + 17, ph: 13 };
}

/** Perimeter of a rounded rect — used to segment multicolor dashes evenly. */
function roundedRectPerimeter(w: number, h: number, r: number) {
  return 2 * Math.max(0, w - 2 * r) + 2 * Math.max(0, h - 2 * r) + 2 * Math.PI * r;
}

export default function MetroMap() {
  /* ---------- state ---------- */
  const [night, setNight] = useState(false);
  const [focusedLine, setFocusedLine] = useState(-1);
  const [selectedStation, setSelectedStation] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const [devMode, setDevMode] = useState(false);
  const [devSelected, setDevSelected] = useState<string | null>(null);
  const [devStep, setDevStep] = useState(1);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [devMsg, setDevMsg] = useState<'' | 'saved' | 'copied'>('');

  useEffect(() => {
    // One-time hydration from external systems (localStorage + URL). Done
    // post-mount so server and client render identical initial markup.
    setOverrides(loadOverrides());
    setPreview(new URLSearchParams(window.location.search).get('preview') === '1');
  }, []);

  /* ---------- derived data ---------- */

  const stations = useMemo(() => {
    const map = buildStationMap();
    for (const [id, ov] of Object.entries(overrides)) {
      const s = map.get(id);
      if (!s) continue;
      if (ov.x !== undefined) s.x = ov.x;
      if (ov.y !== undefined) s.y = ov.y;
      if (ov.label) s.label = ov.label;
      if (ov.en) { s.en = ov.en; s.enLines = undefined; }
      if (ov.kn) s.kn = ov.kn;
    }
    return map;
  }, [overrides]);

  const allStations = useMemo(() => [...stations.values()], [stations]);

  /** Polylines follow overridden station positions: any vertex that
      coincides with a station's base position moves with it. */
  const effectivePts = useMemo<Point[][]>(() => {
    return lineData.map(ld =>
      ld.points.map(([px, py]) => {
        const base = ld.stations.find(s => s.x === px && s.y === py);
        if (base) {
          const cur = stations.get(base.id);
          if (cur) return [cur.x, cur.y] as Point;
        }
        return [px, py] as Point;
      })
    );
  }, [stations]);

  /** Densified centreline with corners rounded into fillet curves —
      trains steer smoothly through bends and tracks render as curves. */
  const densePts = useMemo<Point[][]>(() => {
    return effectivePts.map(pts => roundCorners(pts, CURVE_RADIUS));
  }, [effectivePts]);

  const geometries = useMemo<Geometry[]>(() => {
    return lineData.map((ld, li) => buildGeometry(densePts[li], ld.cfg.loop));
  }, [densePts]);

  /** Double track: one parallel path per direction, offset ±TRACK_OFFSET. */
  const trackPaths = useMemo<[string, string][]>(() => {
    return densePts.map(pts => [
      polylinePathD(offsetPolyline(pts, TRACK_OFFSET)),
      polylinePathD(offsetPolyline(pts, -TRACK_OFFSET)),
    ]);
  }, [densePts]);

  /** Tunnel overlays: a background-coloured band over the corridor between
      the tunnel's end stations (+ portal pad). Trains render underneath, so
      they visibly dim underground and re-emerge at the portals. */
  const tunnelPaths = useMemo(() => {
    return TUNNELS.map(tn => {
      const li = lineData.findIndex(ld => ld.cfg.id === tn.line);
      const geo = geometries[li];
      const sd = lineData[li].stations;
      const distOf = (id: string) => {
        const st = stations.get(id);
        return st && sd.some(s => s.id === id) ? geo.distanceOf(st.x, st.y) : 0;
      };
      let d1 = distOf(tn.from), d2 = distOf(tn.to);
      if (d1 > d2) [d1, d2] = [d2, d1];
      const dA = Math.max(0, d1 - tn.pad);
      const dB = Math.min(geo.total, d2 + tn.pad);
      const pts: Point[] = [];
      for (let d = dA; d < dB; d += 8) { const p = geo.posAt(d); pts.push([p.x, p.y]); }
      const pe = geo.posAt(dB); pts.push([pe.x, pe.y]);
      const portals = [dA, dB].map(d => {
        const p = geo.posAt(d);
        const rad = p.angle * Math.PI / 180;
        return { x: p.x, y: p.y, nx: Math.sin(rad), ny: -Math.cos(rad) };
      });
      return { li, d: polylinePathD(pts), portals, color: lineData[li].cfg.color };
    });
  }, [geometries, stations]);

  /** Per line: path distance of each of its stations (for ring proximity). */
  const stationDists = useMemo(() => {
    return lineData.map((ld, li) => {
      const m = new Map<string, number>();
      ld.stations.forEach(sd => {
        const s = stations.get(sd.id)!;
        m.set(sd.id, geometries[li].distanceOf(s.x, s.y));
      });
      return m;
    });
  }, [stations, geometries]);

  const getOrient = useCallback((s: Station): PillOrient => {
    return overrides[s.id]?.orient ?? ORIENT_DEFAULTS[s.id] ??
      ((s.label === 'left' || s.label === 'right') ? 'V' : 'H');
  }, [overrides]);

  /** Per-line motion profile (dwell + accel/brake between ordered stations). */
  const profiles = useMemo<Profile[]>(() => {
    return lineData.map((ld, li) => buildProfile(ld.stations.map(sd => stationDists[li].get(sd.id)!)));
  }, [stationDists]);

  /** Train elements needed per direction to cover a full trip at peak frequency. */
  const pools = useMemo(() => lineData.map((ld, li) => poolSize(profiles[li], ld.cfg)), [profiles]);

  // Live clock for the service-status line. Starts null so the statically
  // prerendered markup never disagrees with the viewer's clock (hydration),
  // then ticks every 30s.
  const [svcNow, setSvcNow] = useState<Date | null>(null);
  useEffect(() => {
    setSvcNow(new Date());
    const iv = setInterval(() => setSvcNow(new Date()), 30_000);
    return () => clearInterval(iv);
  }, []);

  /* ---------- refs for the animation loop ---------- */

  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  /** [lineIdx][direction][slot] — pooled train elements, reused across departures. */
  const trainPools = useRef<(SVGGElement | null)[][][]>([]);
  const ringRefs = useRef<Map<string, (SVGRectElement | null)[]>>(new Map());
  const geomRef = useRef(geometries);
  const distsRef = useRef(stationDists);
  const profRef = useRef(profiles);
  const poolsRef = useRef(pools);
  useEffect(() => {
    geomRef.current = geometries;
    distsRef.current = stationDists;
    profRef.current = profiles;
    poolsRef.current = pools;
  }, [geometries, stationDists, profiles, pools]);

  /* ---------- animation ---------- */

  useEffect(() => {
    let raf = 0;
    /** Path distances of every train currently on each line (both directions). */
    const activeDists: number[][] = lineData.map(() => []);

    const frame = (rafNow: number) => {
      const t = rafNow / 1000;
      // Absolute wall-clock anchors the departure lattice, so every visitor
      // sees the same service state and reloads don't reshuffle trains.
      const now = Date.now() / 1000;
      const wallDate = new Date();

      lineData.forEach((ld, li) => {
        const geo = geomRef.current[li];
        const profile = profRef.current[li];
        const pool = poolsRef.current[li];
        const active = activeDists[li];
        active.length = 0;

        const headwayReal = currentHeadway(ld.cfg, wallDate);
        for (let dir = 0; dir < 2; dir++) {
          const slots = trainPools.current[li]?.[dir] ?? [];
          if (headwayReal == null) {
            // Service closed — the network sleeps.
            for (const el of slots) if (el) el.style.display = 'none';
            continue;
          }
          const H = headwayReal / COMPRESS;
          const phase = dir ? H / 2 : 0; // stagger the two directions
          const latest = Math.floor((now - phase) / H);
          for (let k = 0; k < pool; k++) {
            const n = latest - k; // departure number; slot follows one train for its whole trip
            const slot = ((n % pool) + pool) % pool;
            const el = slots[slot];
            if (!el) continue;
            const elapsed = now - (n * H + phase);
            const d = distAt(profile, elapsed);
            if (d == null) { el.style.display = 'none'; continue; }
            // Direction B runs the mirrored profile from the far terminus.
            const dist = dir ? geo.total - d : d;
            el.style.display = '';
            // Each coach is placed on the path independently, so the
            // trainset articulates through curves. Coaches trail behind
            // the head against the direction of travel; posAtExt lets
            // the tail slide in from beyond the terminus.
            const coaches = el.children;
            const trail = dir ? 1 : -1;
            for (let ci = 0; ci < coaches.length; ci++) {
              const pt = geo.posAtExt(dist + trail * ci * COACH_SPACING);
              const heading = dir ? pt.angle + 180 : pt.angle;
              const rad = heading * Math.PI / 180;
              const ox = Math.sin(rad) * TRACK_OFFSET;
              const oy = -Math.cos(rad) * TRACK_OFFSET;
              (coaches[ci] as SVGGElement).setAttribute('transform',
                `translate(${(pt.x + ox).toFixed(2)},${(pt.y + oy).toFixed(2)}) rotate(${heading.toFixed(2)})`);
            }
            active.push(dist);
          }
        }
      });

      // Rings: max proximity across every line serving the station.
      ringRefs.current.forEach((els, sid) => {
        let maxP = 0;
        lineData.forEach((ld, li) => {
          const sd = distsRef.current[li].get(sid);
          if (sd === undefined) return;
          for (const trainDist of activeDists[li]) {
            const d = Math.abs(sd - trainDist);
            if (d < APPROACH_DIST) maxP = Math.max(maxP, 1 - d / APPROACH_DIST);
          }
        });
        const op = (maxP * 0.6).toFixed(3);
        els.forEach(el => {
          if (!el) return;
          el.setAttribute('opacity', op);
          if (maxP > 0) {
            const base = parseFloat(el.dataset.baseOffset || '0');
            el.setAttribute('stroke-dashoffset', (base - t * DASH_SPEED).toFixed(2));
          }
        });
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---------- pan / zoom ---------- */

  const tfRef = useRef({ x: 0, y: 0, k: 0.5 });
  const applyTf = useCallback(() => {
    const { x, y, k } = tfRef.current;
    gRef.current?.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
  }, []);

  const homeTf = useCallback(() => {
    const w = window.innerWidth, h = window.innerHeight;
    const k = Math.min(w / 2250, h / 1800) * 0.95;
    return { x: w / 2 - MAP_CX * k, y: h / 2 - MAP_CY * k, k };
  }, []);

  const previewTf = useCallback(() => {
    // Frame the central spine (Majestic / MG Road area).
    const w = window.innerWidth, h = window.innerHeight;
    const k = 0.85;
    return { x: w / 2 - 900 * k, y: h / 2 - 720 * k, k };
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const w = window.innerWidth / 2, h = window.innerHeight / 2;
    const tf = tfRef.current;
    const k2 = Math.max(0.25, Math.min(5, tf.k * factor));
    const r = k2 / tf.k;
    tfRef.current = { x: w - (w - tf.x) * r, y: h - (h - tf.y) * r, k: k2 };
    applyTf();
  }, [applyTf]);

  const resetView = useCallback(() => {
    tfRef.current = homeTf();
    applyTf();
  }, [homeTf, applyTf]);

  const previewRef = useRef(preview);
  useEffect(() => {
    previewRef.current = preview;
    tfRef.current = preview ? previewTf() : homeTf();
    applyTf();
  }, [preview, homeTf, previewTf, applyTf]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let lastPinch = 0;

    const onWheel = (e: WheelEvent) => {
      if (previewRef.current) return;
      e.preventDefault();
      const tf = tfRef.current;
      const factor = Math.exp(-e.deltaY * 0.002);
      const k2 = Math.max(0.25, Math.min(5, tf.k * factor));
      const r = k2 / tf.k;
      tfRef.current = { x: e.clientX - (e.clientX - tf.x) * r, y: e.clientY - (e.clientY - tf.y) * r, k: k2 };
      applyTf();
    };

    const onDown = (e: PointerEvent) => {
      if (previewRef.current) return;
      if ((e.target as Element).closest('.station-group')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      svg.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (pointers.size === 1) {
        tfRef.current.x += e.clientX - prev.x;
        tfRef.current.y += e.clientY - prev.y;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        applyTf();
      } else if (pointers.size === 2) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastPinch > 0) {
          const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          const tf = tfRef.current;
          const k2 = Math.max(0.25, Math.min(5, tf.k * dist / lastPinch));
          const r = k2 / tf.k;
          tfRef.current = { x: cx - (cx - tf.x) * r, y: cy - (cy - tf.y) * r, k: k2 };
          applyTf();
        }
        lastPinch = dist;
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastPinch = 0;
    };

    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    return () => {
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
    };
  }, [applyTf]);

  /* ---------- Station Editor ---------- */

  const devRef = useRef({ devMode, devSelected, devStep });
  useEffect(() => { devRef.current = { devMode, devSelected, devStep }; }, [devMode, devSelected, devStep]);

  const nudge = useCallback((dx: number, dy: number) => {
    const { devSelected: id, devStep: step } = devRef.current;
    if (!id) return;
    setOverrides(prev => {
      const s = buildStationMap().get(id);
      const cur = prev[id] ?? {};
      const x = (cur.x ?? s?.x ?? 0) + dx * step;
      const y = (cur.y ?? s?.y ?? 0) + dy * step;
      return { ...prev, [id]: { ...cur, x, y } };
    });
    setDirtyIds(prev => new Set(prev).add(id));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setDevMode(m => {
          if (m) setDevSelected(null);
          return !m;
        });
        return;
      }
      const { devMode: dm, devSelected: id } = devRef.current;
      if (!dm || !id) return;
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') return;
      const arrows: Record<string, [number, number]> = {
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      };
      const a = arrows[e.key];
      if (a) {
        e.preventDefault();
        const mult = e.shiftKey ? 10 : 1;
        nudge(a[0] * mult, a[1] * mult);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudge]);

  const setOverrideField = useCallback((id: string, field: StationOverride) => {
    setOverrides(prev => ({ ...prev, [id]: { ...prev[id], ...field } }));
    setDirtyIds(prev => new Set(prev).add(id));
  }, []);

  const saveOverrides = useCallback(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(overrides));
    setDevMsg('saved');
    setTimeout(() => setDevMsg(''), 2500);
  }, [overrides]);

  const resetOverrides = useCallback(() => {
    localStorage.removeItem(LS_KEY);
    setOverrides({});
    setDirtyIds(new Set());
    setDevSelected(null);
  }, []);

  const copyPrompt = useCallback(async () => {
    const base = buildStationMap();
    const ids = new Set([...Object.keys(overrides), ...dirtyIds]);
    const sections: string[] = [];
    for (const ld of lineData) {
      const rows: string[] = [];
      for (const sd of ld.stations) {
        if (!ids.has(sd.id)) continue;
        const o = base.get(sd.id)!;
        const ov = overrides[sd.id] ?? {};
        const diffs: string[] = [];
        const fx = ov.x ?? o.x, fy = ov.y ?? o.y;
        if (fx !== sd.x || fy !== sd.y) diffs.push(`- **position**: \`{x:${sd.x}, y:${sd.y}}\` → \`{x:${fx}, y:${fy}}\``);
        if (ov.label && ov.label !== sd.label) diffs.push(`- **label direction**: \`'${sd.label}'\` → \`'${ov.label}'\``);
        if (ov.en && ov.en !== sd.en) diffs.push(`- **en**: \`'${sd.en}'\` → \`'${ov.en}'\``);
        if (ov.kn && ov.kn !== sd.kn) diffs.push(`- **kn**: \`'${sd.kn}'\` → \`'${ov.kn}'\``);
        if (ov.orient) diffs.push(`- **pill orientation**: set \`'${ov.orient}'\` in \`ORIENT_DEFAULTS\``);
        if (diffs.length) rows.push(`### \`${sd.id}\`\n${diffs.join('\n')}\n`);
      }
      if (rows.length) sections.push(`## ${ld.cfg.id}Stations\n\n${rows.join('\n')}`);
    }
    if (!sections.length) { alert('No overrides to export. Make some edits first.'); return; }
    const text = [
      'Bake the following Station Editor overrides into `src/metro/data.ts`. For each station, find its entry in the matching stations array and update the listed fields in place (also update the matching vertex in the line\'s points array when a position changes). Do NOT alter unlisted fields.',
      '',
      `Total stations changed: **${sections.reduce((n, s) => n + (s.match(/###/g)?.length ?? 0), 0)}**`,
      '',
      ...sections,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setDevMsg('copied');
      setTimeout(() => setDevMsg(''), 2500);
    } catch {
      console.log(text);
      alert('Clipboard unavailable — prompt logged to console.');
    }
  }, [overrides, dirtyIds]);

  /* ---------- interaction helpers ---------- */

  const clickStation = useCallback((id: string) => {
    if (devRef.current.devMode) { setDevSelected(id); return; }
    setFocusedLine(-1);
    setSelectedStation(id);
  }, []);

  const clearAll = useCallback(() => {
    setSelectedStation(null);
    setFocusedLine(-1);
  }, []);

  /* ---------- render helpers ---------- */

  const isInterchange = (s: Station) => s.lines.size > 1;

  const focusedCfg = focusedLine >= 0 ? lineData[focusedLine].cfg : null;
  const selStation = selectedStation ? stations.get(selectedStation) : null;
  const devStationObj = devSelected ? stations.get(devSelected) : null;

  const rootClass = [
    'metro-root',
    night ? 'night' : '',
    preview ? 'preview-mode' : '',
    focusedLine >= 0 ? 'has-focus' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass}>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Noto+Sans+Kannada:wght@300;400;500;600&display=swap"
        rel="stylesheet"
      />

      <svg id="nm-map" ref={svgRef}>
        <defs>
          <pattern id="nm-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle className="grid-dot" cx="10" cy="10" r="0.6" />
          </pattern>
          <linearGradient id="nm-headlamp" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#FFF8E1" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#FFF8E1" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="nm-station-glow">
            <stop offset="0%" stopColor="#FFEEBB" stopOpacity="1" />
            <stop offset="100%" stopColor="#FFEEBB" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect className="bg-rect" width="100%" height="100%" />
        <rect width="100%" height="100%" fill="url(#nm-grid)" />

        <g ref={gRef}>
          {/* ambient station glow — bottom-most layer, night only */}
          <g className="ambient-layer">
            {allStations.map(s => (
              <circle
                key={s.id}
                className={`station-ambient${isInterchange(s) ? ' is-xch' : ''}`}
                cx={s.x} cy={s.y} r={isInterchange(s) ? 24 : 18}
                fill="url(#nm-station-glow)"
              />
            ))}
          </g>

          {/* line glows (night) + double tracks + hit areas */}
          {lineData.map((ld, li) => (
            <g key={ld.cfg.id} className={`line-grp${focusedLine >= 0 && focusedLine !== li ? ' dimmed' : ''}`}>
              <path className="line-glow" d={geometries[li].pathD} fill="none"
                stroke={ld.cfg.color} strokeWidth={TRACK_OFFSET * 2 + 10}
                strokeLinecap="round" strokeLinejoin="round" />
              {trackPaths[li].map((d, ti) => (
                <path key={ti} className="line-path" d={d} fill="none"
                  stroke={ld.cfg.color} strokeWidth={TRACK_WIDTH}
                  strokeLinecap="round" strokeLinejoin="round"
                  onClick={e => { e.stopPropagation(); setSelectedStation(null); setFocusedLine(li); }} />
              ))}
              <path className="line-hit" d={geometries[li].pathD} fill="none"
                stroke="transparent" strokeWidth={22}
                strokeLinecap="round" strokeLinejoin="round"
                onClick={e => { e.stopPropagation(); setSelectedStation(null); setFocusedLine(li); }} />
            </g>
          ))}

          {/* approach rings — one set per unique station, multicolor at interchanges */}
          {allStations.map(s => {
            const colors = [...s.lines].map(lid => LINE_MAP[lid].color);
            const n = colors.length;
            const gap = 2;
            let hx: number, hy: number, hw: number, hh: number, hrx: number;
            if (isInterchange(s)) {
              const { pw, ph } = pillSize(n, getOrient(s));
              hx = s.x - pw / 2 - gap; hy = s.y - ph / 2 - gap;
              hw = pw + gap * 2; hh = ph + gap * 2;
              hrx = Math.min(pw, ph) / 2 + gap;
            } else {
              hx = s.x - 9; hy = s.y - 9; hw = 18; hh = 18; hrx = 1.5;
            }
            const segLen = roundedRectPerimeter(hw, hh, hrx) / n;
            return colors.map((c, i) => (
              <rect
                key={`${s.id}-ring-${i}`}
                ref={el => {
                  const arr = ringRefs.current.get(s.id) ?? [];
                  arr[i] = el;
                  ringRefs.current.set(s.id, arr);
                }}
                x={hx} y={hy} width={hw} height={hh} rx={hrx}
                fill="none" stroke={c} strokeWidth={1.2}
                strokeDasharray={n === 1 ? '4 3' : `4 ${segLen - 4}`}
                strokeDashoffset={n === 1 ? 0 : -i * segLen}
                data-base-offset={n === 1 ? 0 : -i * segLen}
                opacity={0}
              />
            ));
          })}

          {/* trains — pooled per line and direction; the schedule loop
              shows/places them, so they start hidden */}
          {lineData.map((ld, li) => (
            <g key={`trains-${ld.cfg.id}`}>
              {[0, 1].map(dir =>
                Array.from({ length: pools[li] }, (_, slot) => (
                  <g
                    key={`${dir}-${slot}`}
                    className={`train-car${focusedLine >= 0 && focusedLine !== li ? ' dimmed' : ''}`}
                    style={{ display: 'none' }}
                    ref={el => {
                      const byLine = (trainPools.current[li] ??= []);
                      (byLine[dir] ??= [])[slot] = el;
                    }}
                  >
                    {Array.from({ length: ld.cfg.coaches }, (_, ci) => (
                      <g key={ci} className="coach">
                        {ci === 0 && (
                          <polygon className="train-headlamp" points="4,-2 38,-8 38,8 4,2" fill="url(#nm-headlamp)" />
                        )}
                        <rect className="train-glow" x={-6.5} y={-4.5} width={13} height={9} rx={3.5} fill={ld.cfg.color} />
                        <rect x={-4} y={-2.75} width={8} height={5.5} rx={2} fill={ld.cfg.color} opacity={0.9} />
                        <rect className="train-window" x={-2.6} y={-1} width={5.2} height={2} rx={1} />
                      </g>
                    ))}
                  </g>
                ))
              )}
            </g>
          ))}

          {/* tunnel sections — drawn ABOVE trains so they dim underground,
              below stations so markers stay crisp */}
          {tunnelPaths.map((tn, i) => (
            <g key={`tunnel-${i}`} className={`tunnel-grp${focusedLine >= 0 && focusedLine !== tn.li ? ' dimmed' : ''}`}>
              <path className="tunnel-overlay" d={tn.d} fill="none"
                strokeWidth={TRACK_OFFSET * 2 + TRACK_WIDTH + 4} strokeLinecap="butt" />
              {tn.portals.map((p, pi) => (
                <line key={pi} className="tunnel-portal"
                  x1={p.x + p.nx * 8.5} y1={p.y + p.ny * 8.5}
                  x2={p.x - p.nx * 8.5} y2={p.y - p.ny * 8.5}
                  stroke={tn.color} strokeWidth={1.6} />
              ))}
            </g>
          ))}

          {/* stations */}
          {allStations.map(s => {
            const ic = isInterchange(s);
            const colors = [...s.lines].map(lid => LINE_MAP[lid].color);
            const dimmed = focusedCfg ? !s.lines.has(focusedCfg.id) : false;
            const isLocal = !!s.local && !ic;
            const off = labelOffsets(s.label);
            const enLines = s.enLines ?? [s.en];
            const knYExtra = (enLines.length - 1) * 13;
            const devSel = devMode && devSelected === s.id;

            return (
              <g
                key={s.id}
                className={[
                  'station-group',
                  ic ? 'is-xch' : '',
                  isLocal ? 'is-local' : '',
                  dimmed ? 'dimmed' : '',
                  devSel ? 'dev-selected' : '',
                ].filter(Boolean).join(' ')}
                onClick={e => { e.stopPropagation(); clickStation(s.id); }}
              >
                {ic ? (() => {
                  const orient = getOrient(s);
                  const { pw, ph } = pillSize(colors.length, orient);
                  const px = s.x - pw / 2, py = s.y - ph / 2;
                  const rx = Math.min(pw, ph) / 2;
                  const cSp = 9;
                  return (
                    <>
                      <rect className="station-mask" x={px - 2} y={py - 2} width={pw + 4} height={ph + 4} rx={rx + 2} />
                      <rect className="station-marker pill-bg" x={px} y={py} width={pw} height={ph} rx={rx}
                        strokeWidth={1.5} strokeDasharray={s.underground ? '3 2' : undefined} />
                      <rect className="station-warm" x={px} y={py} width={pw} height={ph} rx={rx} fill="#FFEEBB" />
                      {colors.map((c, i) => (
                        <circle
                          key={i}
                          className="pill-dot"
                          cx={orient === 'V' ? s.x : s.x - (colors.length - 1) * cSp / 2 + i * cSp}
                          cy={orient === 'V' ? s.y - (colors.length - 1) * cSp / 2 + i * cSp : s.y}
                          r={3.5} fill={c}
                        />
                      ))}
                    </>
                  );
                })() : (
                  <>
                    <rect className="station-mask" x={s.x - 7} y={s.y - 7} width={14} height={14} rx={1.5} />
                    <rect className="station-marker" x={s.x - 5} y={s.y - 5} width={10} height={10} rx={0.8}
                      stroke={colors[0]} strokeWidth={1.5}
                      strokeDasharray={s.underground ? '2.4 1.7' : undefined} />
                    <rect className="station-warm" x={s.x - 3.5} y={s.y - 3.5} width={7} height={7} rx={0.5} fill="#FFEEBB" />
                  </>
                )}

                <rect className="station-hit" x={s.x - 20} y={s.y - 20} width={40} height={40} fill="transparent" />

                <g className="station-label">
                  {enLines.map((line, i) => (
                    <text key={i} className="label-en"
                      x={s.x + off.enDx} y={s.y + off.enDy + i * 13}
                      textAnchor={off.anchor}>{line}</text>
                  ))}
                  <text className="label-kn"
                    x={s.x + off.knDx} y={s.y + off.knDy + knYExtra}
                    textAnchor={off.anchor}>{s.kn}</text>
                </g>
              </g>
            );
          })}
        </g>

        {/* background click clears focus/selection */}
        <rect width="100%" height="100%" fill="transparent" style={{ pointerEvents: 'none' }} />
      </svg>

      {/* click-away handled on the svg itself */}
      <ClickAway svgRef={svgRef} onClear={clearAll} />

      {/* ---------- LEGEND ---------- */}
      <div id="nm-legend" className={selStation || focusedLine >= 0 ? 'hidden-panel' : ''}>
        <div className="legend-title">Namma Metro</div>
        <div className="legend-subtitle">ನಮ್ಮ ಮೆಟ್ರೋ · ಬೆಂಗಳೂರು</div>
        {lineData.map(ld => (
          <div className="legend-row" key={ld.cfg.id}>
            <span className="legend-bar" style={{ background: ld.cfg.color }} />
            <span className="legend-name">{ld.cfg.name.en}</span>
            <span className="legend-count">{ld.stations.length}</span>
          </div>
        ))}
        {svcNow && (() => {
          const h = istHour(svcNow);
          const open = h >= SERVICE_START && h < SERVICE_END;
          return (
            <div className="legend-service">
              <span className={`svc-dot ${open ? 'on' : 'off'}`} />
              {open
                ? `In service · ${isPeak(h) ? 'peak' : 'off-peak'} frequency`
                : 'Service ended · resumes 05:00 IST'}
            </div>
          );
        })()}
        <div className="legend-footer">
          {LEGEND_FOOTER}
          <br />Two-way service on the IST clock · time runs {COMPRESS}×
          <br />Faded track &amp; dashed markers = underground
        </div>
      </div>

      {/* ---------- STATION INFO ---------- */}
      <div id="nm-info" className={selStation ? 'visible' : ''}>
        <button className="info-close" title="Close" onClick={() => setSelectedStation(null)}>✕</button>
        <div className="station-en">{selStation?.en}</div>
        <div className="station-kn">{selStation?.kn}</div>
        <div className="line-badges">
          {selStation && [...selStation.lines].map(lid => (
            <span className="badge" key={lid}>
              <span className="badge-sq" style={{ background: LINE_MAP[lid].color }} />
              {LINE_MAP[lid].name.en}
            </span>
          ))}
        </div>
      </div>

      {/* ---------- LINE INFO ---------- */}
      <div id="nm-line-info" className={focusedLine >= 0 ? 'visible' : ''}>
        <button className="info-close" title="Close" onClick={() => setFocusedLine(-1)}>✕</button>
        {focusedCfg && (() => {
          const ld = lineData[focusedLine];
          const xch = ld.stations.filter(sd => (stations.get(sd.id)?.lines.size ?? 0) > 1);
          return (
            <>
              <div className="line-info-header">
                <span className="line-info-bar" style={{ background: focusedCfg.color }} />
                <div>
                  <div className="line-info-en">{focusedCfg.name.en}</div>
                  <div className="line-info-kn">{focusedCfg.name.kn}</div>
                </div>
              </div>
              <div className="line-info-stats">
                {ld.stations.length} stations · {xch.length} interchange{xch.length !== 1 ? 's' : ''} · Terminal line
              </div>
              <div className="station-list">
                {ld.stations.map((sd, i) => {
                  const ms = stations.get(sd.id)!;
                  const isXch = ms.lines.size > 1;
                  const others = isXch
                    ? [...ms.lines].filter(l => l !== focusedCfg.id).map(l => LINE_MAP[l].name.en).join(', ')
                    : '';
                  return (
                    <div className="stn-row" key={sd.id} style={{ animationDelay: `${i * 25}ms` }}>
                      {i > 0 && <div className="stn-connector" style={{ background: focusedCfg.color }} />}
                      <div className="stn-dot" style={{ borderColor: isXch ? '#333' : focusedCfg.color }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="stn-name">{ms.en}</div>
                        <div className="stn-name-kn">{ms.kn}</div>
                      </div>
                      {isXch && <div className="stn-xch">{others}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}
      </div>

      {/* ---------- TOOLBAR ---------- */}
      <div id="nm-toolbar">
        <button title="Toggle day/night" onClick={() => setNight(n => !n)} aria-pressed={night}>
          {night ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" />
              <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
              <line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" />
              <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
        <button title="Zoom in" onClick={() => zoomBy(1.5)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button title="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button title="Reset view" onClick={resetView}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><polyline points="3 3 3 8 8 8" />
          </svg>
        </button>
        <a className="tb-3d" href="/bangalore-metro/3d" title="Open 3D view">3D</a>
      </div>

      {/* ---------- STATION EDITOR ---------- */}
      {devMode && (
        <div id="nm-dev-panel">
          <div className="dp-title">
            Station Editor
            <span>Ctrl+Shift+D to toggle</span>
          </div>
          {!devStationObj ? (
            <div className="dp-empty">Click any station to edit</div>
          ) : (
            <>
              <div className="dp-section">
                <div className="dp-label">Selected Station</div>
                <div className="dp-station-name">{devStationObj.en}</div>
                <div className="dp-station-kn">{devStationObj.kn}</div>
                <div className="dp-coords">
                  <span>x: <span className="dp-coord">{devStationObj.x}</span></span>
                  <span>y: <span className="dp-coord">{devStationObj.y}</span></span>
                </div>
              </div>
              <div className="dp-section">
                <div className="dp-label">Position (arrow keys · Shift = 10×)</div>
                <div className="dp-arrows">
                  <span /><button onClick={() => nudge(0, -1)}>↑</button><span />
                  <button onClick={() => nudge(-1, 0)}>←</button><span className="dp-dot">·</span><button onClick={() => nudge(1, 0)}>→</button>
                  <span /><button onClick={() => nudge(0, 1)}>↓</button><span />
                </div>
                <div className="dp-step">
                  <label>Step:</label>
                  <input type="number" min={1} max={50} value={devStep}
                    onChange={e => setDevStep(Math.max(1, parseInt(e.target.value) || 1))} />
                  <label>px</label>
                </div>
              </div>
              {isInterchange(devStationObj) && (
                <div className="dp-section">
                  <div className="dp-label">Pill Orientation</div>
                  <div className="dp-orient">
                    {(['H', 'V'] as PillOrient[]).map(o => (
                      <button key={o}
                        className={getOrient(devStationObj) === o ? 'sel' : ''}
                        onClick={() => setOverrideField(devStationObj.id, { orient: o })}>
                        {o === 'H' ? 'Horizontal' : 'Vertical'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="dp-section">
                <div className="dp-label">Label Position</div>
                <div className="dp-orient">
                  {(['left', 'top', 'bottom', 'right'] as LabelDir[]).map(d => (
                    <button key={d}
                      className={devStationObj.label === d ? 'sel' : ''}
                      onClick={() => setOverrideField(devStationObj.id, { label: d })}>
                      {{ left: '←', top: '↑', bottom: '↓', right: '→' }[d]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="dp-section">
                <div className="dp-label">Station Name</div>
                <input className="dp-name-input" type="text" value={devStationObj.en}
                  onChange={e => setOverrideField(devStationObj.id, { en: e.target.value })} />
                <input className="dp-name-input dp-name-kn" type="text" value={devStationObj.kn}
                  onChange={e => setOverrideField(devStationObj.id, { kn: e.target.value })} />
              </div>
              <div className="dp-changes">
                {dirtyIds.size > 0 ? `${dirtyIds.size} change${dirtyIds.size > 1 ? 's' : ''}` : 'No changes'}
              </div>
            </>
          )}
          <div className="dp-actions">
            <button className="dp-btn-reset" onClick={resetOverrides}>Reset</button>
            <button className="dp-btn-save" onClick={saveOverrides}>Save</button>
            <button className="dp-btn-prompt" onClick={copyPrompt}>Copy Prompt</button>
          </div>
          {devMsg === 'saved' && <div className="dp-msg dp-msg-save">✓ Saved — persists on reload</div>}
          {devMsg === 'copied' && <div className="dp-msg dp-msg-copy">✓ Prompt copied — paste into Claude</div>}
        </div>
      )}
    </div>
  );
}

/** Clears focus/selection when clicking empty map space. */
function ClickAway({ svgRef, onClear }: { svgRef: React.RefObject<SVGSVGElement | null>; onClear: () => void }) {
  const cleared = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const down = (e: PointerEvent) => { cleared.current = { x: e.clientX, y: e.clientY }; };
    const onClick = (e: MouseEvent) => {
      // Ignore drags — only clear on a genuine click.
      const moved = Math.hypot(e.clientX - cleared.current.x, e.clientY - cleared.current.y);
      if (moved > 4) return;
      const tgt = e.target as Element;
      if (tgt.closest('.station-group') || tgt.closest('.line-path') || tgt.closest('.line-hit')) return;
      onClear();
    };
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('click', onClick);
    return () => {
      svg.removeEventListener('pointerdown', down);
      svg.removeEventListener('click', onClick);
    };
  }, [svgRef, onClear]);
  return null;
}
