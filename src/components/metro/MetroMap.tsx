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
  ArrowCounterClockwise, ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  Cube, MapPin, Minus, Moon, Plus, SpeakerSimpleHigh, SpeakerSimpleSlash, Sun, X,
} from '@phosphor-icons/react';
import {
  LINE_MAP, lineData, buildStationMap, ORIENT_DEFAULTS,
  MAP_CX, MAP_CY, LEGEND_FOOTER,
  type LabelDir, type PillOrient, type Station, type Point,
} from '@/metro/data';
import { buildGeometry, offsetPolyline, polylinePathD, roundCorners, type Geometry } from '@/metro/geometry';
import { TUNNELS, LANDMARKS } from '@/metro/data';
import {
  COMPRESS, buildProfile, poolSize, currentHeadway, trainStateAt, returnPhase,
  turnaroundSlideDelay, BOARD_VIS, istHour, isPeak, autoNight, twilightStrength, isDwelling,
  SERVICE_START, SERVICE_END, type Profile,
} from '@/metro/service';

const APPROACH_DIST = 80;
const DASH_SPEED = 12;
/** Left-hand running: each direction's track (and its trains) sits this many
    px to the left of the direction of travel. */
const TRACK_OFFSET = 4;
const TRACK_WIDTH = 2.5;
/** Half-gauge of the running rails, drawn within each track's deck. */
const RAIL_GAUGE = 0.85;
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
  /** Theme follows the Bengaluru sky until the user toggles manually. */
  const [themeMode, setThemeMode] = useState<'auto' | 'day' | 'night'>('auto');
  const [focusedLine, setFocusedLine] = useState(-1);
  const [selectedStation, setSelectedStation] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [landmarksOn, setLandmarksOn] = useState(false);
  const [selectedLandmark, setSelectedLandmark] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);

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

  /** Two running rails per direction, offset a half-gauge either side of each
      track centreline. Rendered within the coloured deck — a subtle detail
      that reads as real track once zoomed in. */
  const railPaths = useMemo<string[][]>(() => {
    return densePts.map(pts =>
      [TRACK_OFFSET, -TRACK_OFFSET].flatMap(o => [
        polylinePathD(offsetPolyline(pts, o + RAIL_GAUGE)),
        polylinePathD(offsetPolyline(pts, o - RAIL_GAUGE)),
      ]),
    );
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

  /** Track heading (deg) at each station — the platform aligns to it. */
  const stationAngles = useMemo(() => {
    const m = new Map<string, number>();
    lineData.forEach((ld, li) => {
      ld.stations.forEach(sd => {
        if (m.has(sd.id)) return;
        const d = stationDists[li].get(sd.id);
        if (d !== undefined) m.set(sd.id, geometries[li].posAt(d).angle);
      });
    });
    return m;
  }, [geometries, stationDists]);

  const getOrient = useCallback((s: Station): PillOrient => {
    return overrides[s.id]?.orient ?? ORIENT_DEFAULTS[s.id] ??
      ((s.label === 'left' || s.label === 'right') ? 'V' : 'H');
  }, [overrides]);

  /** Terminus stations (first/last of each line) get solid line-colored caps. */
  const terminusColors = useMemo(() => {
    const m = new Map<string, string>();
    lineData.forEach(ld => {
      [ld.stations[0], ld.stations[ld.stations.length - 1]].forEach(sd => {
        m.set(sd.id, ld.cfg.color);
      });
    });
    return m;
  }, []);

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

  /* ---------- station chime (off by default) ---------- */

  const audioRef = useRef<AudioContext | null>(null);
  const soundOnRef = useRef(false);
  const lastChimeRef = useRef(0);
  const dwellMapRef = useRef(new Map<string, boolean>());
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);

  const toggleSound = useCallback(() => {
    setSoundOn(v => {
      const next = !v;
      if (next && !audioRef.current) {
        try {
          audioRef.current = new AudioContext();
        } catch { return false; }
      }
      if (next) audioRef.current?.resume();
      return next;
    });
  }, []);

  /** Soft two-tone arrival chime, throttled by the caller. */
  const playChime = useCallback(() => {
    const ctx = audioRef.current;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    [[659.25, 0], [523.25, 0.22]].forEach(([freq, dt]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + dt);
      gain.gain.linearRampToValueAtTime(0.045, t0 + dt + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 0.32);
    });
  }, []);

  /** Chime only for arrivals the viewer can see, while zoomed in enough
      to be "at" a station — and never more than one every couple seconds. */
  const maybeChime = useCallback((mapX: number, mapY: number) => {
    if (!soundOnRef.current) return;
    const nowMs = performance.now();
    if (nowMs - lastChimeRef.current < 2200) return;
    const { x, y, k } = tfRef.current;
    if (k < 0.9) return;
    const sx = mapX * k + x, sy = mapY * k + y;
    if (sx < 0 || sy < 0 || sx > window.innerWidth || sy > window.innerHeight) return;
    lastChimeRef.current = nowMs;
    playChime();
  }, [playChime]);

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
        const H = headwayReal != null ? headwayReal / COMPRESS : 1;
        // Return departures are phased so they pick up right where an
        // arriving train finishes its crossover — a visible turnaround.
        const phases: [number, number] = [0, headwayReal != null ? returnPhase(profile, H) : 0];
        for (let dir = 0; dir < 2; dir++) {
          const slots = trainPools.current[li]?.[dir] ?? [];
          if (headwayReal == null) {
            // Service closed — the network sleeps.
            for (const el of slots) if (el) el.style.display = 'none';
            continue;
          }
          const phase = phases[dir];
          // Include the next departure too: it is visible boarding early.
          const latest = Math.floor((now + BOARD_VIS - phase) / H);
          for (let k = 0; k < pool; k++) {
            const n = latest - k; // departure number; slot follows one train for its whole trip
            const slot = ((n % pool) + pool) % pool;
            const el = slots[slot];
            if (!el) continue;
            const elapsed = now - (n * H + phase);
            // Park after arrival until the next return boarding slot, so a
            // berth never shows two trains at once — they crossfade instead.
            const slideDelay = turnaroundSlideDelay(profile, H, phase, phases[1 - dir], n);
            const st = trainStateAt(profile, elapsed, slideDelay);
            if (!st) { el.style.display = 'none'; continue; }
            // Direction B runs the mirrored profile from the far terminus.
            const dist = dir ? geo.total - st.d : st.d;
            el.style.display = '';
            el.style.opacity = st.opacity.toFixed(3);
            // Arrival edge → maybe chime (checked against zoom + viewport).
            const dwellKey = `${li}:${dir}:${n}`;
            const dwellNow = isDwelling(profile, elapsed);
            let justStopped = false;
            if (dwellNow !== (dwellMapRef.current.get(dwellKey) ?? false)) {
              if (dwellMapRef.current.size > 600) dwellMapRef.current.clear();
              dwellMapRef.current.set(dwellKey, dwellNow);
              justStopped = dwellNow;
            }
            // Crossover slides the train from its own track to the
            // opposite one during the terminus turnaround.
            const off = TRACK_OFFSET * (1 - 2 * st.crossover);
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
              const ox = Math.sin(rad) * off;
              const oy = -Math.cos(rad) * off;
              (coaches[ci] as SVGGElement).setAttribute('transform',
                `translate(${(pt.x + ox).toFixed(2)},${(pt.y + oy).toFixed(2)}) rotate(${heading.toFixed(2)})`);
              if (ci === 0 && justStopped) maybeChime(pt.x + ox, pt.y + oy);
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
  }, [maybeChime]);

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
    setSelectedLandmark(null);
  }, []);

  /* ---------- render helpers ---------- */

  const isInterchange = (s: Station) => s.lines.size > 1;

  const clockH = svcNow ? istHour(svcNow) : null;
  const night = themeMode === 'auto' ? clockH != null && autoNight(clockH) : themeMode === 'night';
  const twilight = themeMode === 'auto' && clockH != null ? twilightStrength(clockH) : 0;

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
              {/* sleepers (cross-ties) — perpendicular ticks within each deck */}
              {trackPaths[li].map((d, ti) => (
                <path key={`slp-${ti}`} className="track-sleeper" d={d} fill="none"
                  stroke="#000" strokeWidth={TRACK_WIDTH - 0.1} strokeLinecap="butt"
                  strokeDasharray="0.6 2.4" />
              ))}
              {/* running rails — two steel lines per direction */}
              {railPaths[li].map((d, ri) => (
                <path key={`rail-${ri}`} className="track-rail" d={d} fill="none"
                  stroke="#fff" strokeWidth={0.4} strokeLinecap="round" />
              ))}
              {/* buffer-stop bars across the corridor at both ends */}
              {[0.01, geometries[li].total - 0.01].map((d, ei) => {
                const p = geometries[li].posAt(d);
                const rad = p.angle * Math.PI / 180;
                const nx = Math.sin(rad), ny = -Math.cos(rad);
                return (
                  <line key={`cap-${ei}`} className="end-cap"
                    x1={p.x + nx * 8} y1={p.y + ny * 8}
                    x2={p.x - nx * 8} y2={p.y - ny * 8}
                    stroke={ld.cfg.color} strokeWidth={3} strokeLinecap="round" />
                );
              })}
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
                    {Array.from({ length: ld.cfg.coaches }, (_, ci) => {
                      const lead = ci === 0;
                      return (
                      <g key={ci} className="coach">
                        {/* soft bloom — invisible by day, warm halo by night */}
                        <rect className="train-glow" x={-5.2} y={-3} width={10.4} height={6} rx={2.8} fill={ld.cfg.color} />
                        {lead && (
                          <polygon className="train-headlamp" points="4.6,-2.1 40,-8 40,8 4.6,2.1" fill="url(#nm-headlamp)" />
                        )}
                        {/* stainless-steel body — lead car gets a tapered nose at +X */}
                        {lead ? (
                          <path className="coach-body"
                            d="M -4.4 -2.2 L 2.8 -2.2 Q 4.7 -2.2 4.7 0 Q 4.7 2.2 2.8 2.2 L -4.4 2.2 Q -5 2.2 -5 1.6 L -5 -1.6 Q -5 -2.2 -4.4 -2.2 Z" />
                        ) : (
                          <rect className="coach-body" x={-4.4} y={-2.2} width={8.8} height={4.4} rx={1.3} />
                        )}
                        {/* line-coloured belt-line stripes down each side */}
                        <rect className="coach-stripe" x={-3.7} y={-2.15} width={7.4} height={0.5} rx={0.2} fill={ld.cfg.color} />
                        <rect className="coach-stripe" x={-3.7} y={1.65} width={7.4} height={0.5} rx={0.2} fill={ld.cfg.color} />
                        {/* roof-top walkway + AC units */}
                        <rect className="coach-roof" x={-3.7} y={-0.75} width={7.4} height={1.5} rx={0.5} />
                        <rect className="coach-ac" x={-2.5} y={-0.55} width={1.5} height={1.1} rx={0.25} />
                        <rect className="coach-ac" x={1} y={-0.55} width={1.5} height={1.1} rx={0.25} />
                        {/* clerestory side windows (glow warm at night) */}
                        <rect className="train-window" x={-3.4} y={-1.85} width={6.6} height={0.62} rx={0.3} />
                        <rect className="train-window" x={-3.4} y={1.23} width={6.6} height={0.62} rx={0.3} />
                        {/* line-coloured cab (magenta front, from the photo) */}
                        {lead && (
                          <path className="coach-cab" fill={ld.cfg.color}
                            d="M 2.5 -2.2 L 2.8 -2.2 Q 4.7 -2.2 4.7 0 Q 4.7 2.2 2.8 2.2 L 2.5 2.2 Z" />
                        )}
                        {lead && <rect className="coach-windshield" x={2.7} y={-1.2} width={1.0} height={2.4} rx={0.5} />}
                      </g>
                      );
                    })}
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
            const terminusColor = !ic ? terminusColors.get(s.id) : undefined;
            const off = labelOffsets(s.label);
            const enLines = s.enLines ?? [s.en];
            const knYExtra = (enLines.length - 1) * 13;
            const devSel = devMode && devSelected === s.id;
            const angle = stationAngles.get(s.id) ?? 0;

            return (
              <g
                key={s.id}
                className={[
                  'station-group',
                  ic ? 'is-xch' : '',
                  isLocal ? 'is-local' : '',
                  terminusColor ? 'is-terminus' : '',
                  s.underground ? 'is-ug' : '',
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
                      {/* interchange building footprint behind the pill */}
                      <rect className="stn-bridge" x={px - 5} y={py - 5} width={pw + 10} height={ph + 10} rx={rx + 5} />
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
                  <g className="stn-plat" transform={`rotate(${angle.toFixed(2)} ${s.x} ${s.y})`}>
                    {/* two side platforms flanking the tracks, edged in line colour */}
                    {[-1, 1].map(sgn => (
                      <rect key={sgn} className="stn-platform"
                        x={s.x - 9.5} y={s.y + sgn * 7.6 - 1.2} width={19} height={2.4} rx={1}
                        stroke={terminusColor ?? colors[0]}
                        strokeDasharray={s.underground ? '2 1.4' : undefined} />
                    ))}
                    {/* concourse / foot-over-bridge spanning the tracks */}
                    <rect className="stn-bridge" x={s.x - 1.9} y={s.y - 9} width={3.8} height={18} rx={1.2} />
                    <rect className="station-warm" x={s.x - 1.5} y={s.y - 8.6} width={3} height={17.2} rx={1} fill="#FFEEBB" />
                    {/* identity marker on the concourse */}
                    {terminusColor ? (
                      <rect className="station-marker" x={s.x - 2.7} y={s.y - 2.7} width={5.4} height={5.4} rx={1}
                        stroke="#FFFFFF" strokeWidth={1.2} style={{ fill: terminusColor }} />
                    ) : (
                      <circle className="station-marker" cx={s.x} cy={s.y} r={2.7}
                        stroke={colors[0]} strokeWidth={1.4} />
                    )}
                  </g>
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
          {/* landmarks — hidden until toggled from the toolbar */}
          <g className={`lm-layer${landmarksOn ? '' : ' lm-hidden'}`}>
            {LANDMARKS.map(lm => {
              const stn = stations.get(lm.station);
              if (!stn) return null;
              const isLeft = lm.label === 'left';
              return (
                <g key={lm.id}>
                  <line className="lm-connector"
                    x1={stn.x} y1={stn.y} x2={lm.x} y2={lm.y}
                    strokeDasharray="4 4" />
                  <g className={`lm-group${selectedLandmark === lm.id ? ' is-selected' : ''}`}
                    onClick={e => { e.stopPropagation(); clearAll(); setSelectedLandmark(lm.id); }}>
                    <rect className="lm-mask" x={lm.x - 11} y={lm.y - 11} width={22} height={22} rx={4} />
                    <rect className="lm-marker" x={lm.x - 8.5} y={lm.y - 8.5} width={17} height={17} rx={3} />
                    <text className="lm-icon" x={lm.x} y={lm.y + 1} textAnchor="middle" dominantBaseline="central" fontSize={10}>
                      {lm.icon}
                    </text>
                    <rect x={lm.x - 18} y={lm.y - 18} width={36} height={36} fill="transparent" />
                    <g className="lm-label">
                      <text className="lm-name" x={lm.x + (isLeft ? -15 : 15)} y={lm.y - 1}
                        textAnchor={isLeft ? 'end' : 'start'}>{lm.name}</text>
                      <text className="lm-meta" x={lm.x + (isLeft ? -15 : 15)} y={lm.y + 10}
                        textAnchor={isLeft ? 'end' : 'start'}>{`~${lm.walkMin} min from ${stn.en}`}</text>
                    </g>
                  </g>
                </g>
              );
            })}
          </g>
        </g>

        {/* background click clears focus/selection */}
        <rect width="100%" height="100%" fill="transparent" style={{ pointerEvents: 'none' }} />
      </svg>

      {/* warm dawn/dusk tint — only while the theme is on auto */}
      <div className="twilight-overlay" style={{ opacity: twilight * 0.22 }} />

      {/* click-away handled on the svg itself */}
      <ClickAway svgRef={svgRef} onClear={clearAll} />

      {/* ---------- LANDMARK INFO ---------- */}
      <div id="nm-landmark-info" className={selectedLandmark ? 'visible' : ''}>
        <button className="info-close" title="Close" onClick={() => setSelectedLandmark(null)}>
          <X size={12} weight="bold" />
        </button>
        {(() => {
          const lm = LANDMARKS.find(l => l.id === selectedLandmark);
          if (!lm) return null;
          const stn = stations.get(lm.station);
          const lineColor = stn ? LINE_MAP[[...stn.lines][0]].color : '#888';
          return (
            <>
              <div className="lm-info-header">
                <span className="lm-info-icon">{lm.icon}</span>
                <div>
                  <div className="lm-info-name">{lm.name}</div>
                  <div className="lm-info-kn">{lm.kn}</div>
                </div>
              </div>
              <div className="lm-info-station">
                <span className="badge-sq" style={{ background: lineColor }} />
                <span className="lm-info-stn-name">{stn?.en}</span>
                <span className="lm-info-walk">~{lm.walkMin} min walk</span>
              </div>
              <div className="lm-info-desc">{lm.desc}</div>
            </>
          );
        })()}
      </div>

      {/* ---------- LEGEND ---------- */}
      <div id="nm-legend" className={selStation || focusedLine >= 0 || selectedLandmark ? 'hidden-panel' : ''}>
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
        <button className="info-close" title="Close" onClick={() => setSelectedStation(null)}>
          <X size={12} weight="bold" />
        </button>
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
        <button className="info-close" title="Close" onClick={() => setFocusedLine(-1)}>
          <X size={12} weight="bold" />
        </button>
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
        <button
          title={themeMode === 'auto' ? 'Theme follows the Bengaluru sky — click to override' : 'Toggle day/night'}
          onClick={() => setThemeMode(night ? 'day' : 'night')}
          aria-pressed={night}
        >
          {night ? <Sun size={15} weight="bold" /> : <Moon size={15} weight="bold" />}
        </button>
        <button title="Zoom in" onClick={() => zoomBy(1.5)}>
          <Plus size={15} weight="bold" />
        </button>
        <button title="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
          <Minus size={15} weight="bold" />
        </button>
        <button title="Reset view" onClick={resetView}>
          <ArrowCounterClockwise size={15} weight="bold" />
        </button>
        <button
          className={landmarksOn ? 'tb-active' : ''}
          title="Toggle city landmarks"
          aria-pressed={landmarksOn}
          onClick={() => { setLandmarksOn(v => !v); if (landmarksOn) setSelectedLandmark(null); }}
        >
          <MapPin size={15} weight="bold" />
        </button>
        <button
          className={soundOn ? 'tb-active' : ''}
          title={soundOn ? 'Mute station chimes' : 'Station chimes — plays when a train stops at a station in view (zoom in)'}
          aria-pressed={soundOn}
          onClick={toggleSound}
        >
          {soundOn ? <SpeakerSimpleHigh size={15} weight="bold" /> : <SpeakerSimpleSlash size={15} weight="bold" />}
        </button>
        <a className="tb-3d" href="/3d" title="Open 3D view">
          <Cube size={14} weight="bold" />
          3D
        </a>
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
                  <span /><button onClick={() => nudge(0, -1)} aria-label="Nudge up"><ArrowUp size={13} /></button><span />
                  <button onClick={() => nudge(-1, 0)} aria-label="Nudge left"><ArrowLeft size={13} /></button>
                  <span className="dp-dot">·</span>
                  <button onClick={() => nudge(1, 0)} aria-label="Nudge right"><ArrowRight size={13} /></button>
                  <span /><button onClick={() => nudge(0, 1)} aria-label="Nudge down"><ArrowDown size={13} /></button><span />
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
                      aria-label={`Label ${d}`}
                      onClick={() => setOverrideField(devStationObj.id, { label: d })}>
                      {{
                        left: <ArrowLeft size={13} />,
                        top: <ArrowUp size={13} />,
                        bottom: <ArrowDown size={13} />,
                        right: <ArrowRight size={13} />,
                      }[d]}
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
      if (tgt.closest('.station-group') || tgt.closest('.line-path') || tgt.closest('.line-hit') || tgt.closest('.lm-group')) return;
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
