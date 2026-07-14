/* ============================================================
   Schedule-realistic service simulation.

   Trains are not decorative here: each line runs a two-way
   service on BMRCL-like headways, keyed to the real IST clock,
   with station dwells and acceleration/braking curves. Time is
   compressed (1 real second ≈ COMPRESS simulated seconds) so
   the service stays visually alive.

   The motion profile turns a line's ordered station path
   distances into a piecewise distance-vs-time function:
   accelerate out of each station, cruise, brake into the next,
   dwell, repeat. Direction B mirrors the same profile from the
   other terminus (the station gaps reverse symmetrically).
   ============================================================ */

import type { LineConfig } from './data';

/** 1 real second ≈ 40 simulated seconds (an ~80 min Purple run plays in ~2 min). */
export const COMPRESS = 40;

/* Visual-time kinematics (px/s in map units, already compressed).
   Derived from real values: ~1 px ≈ 22 m, vmax ≈ 80 km/h,
   accel ≈ 1 m/s², dwell ≈ 25 s. */
const VMAX = 40;
const ACCEL = 72;
const DWELL = 0.625;

export interface ProfileEvent {
  type: 'run' | 'dwell';
  t0: number; t1: number;
  d0: number; d1: number;
}

export interface Profile {
  events: ProfileEvent[];
  /** one-way trip duration, visual seconds */
  total: number;
}

export function buildProfile(stationDists: number[]): Profile {
  // Guard monotonicity — projection glitches must not create negative gaps.
  const dists: number[] = [];
  for (const d of stationDists) dists.push(dists.length ? Math.max(d, dists[dists.length - 1]) : d);

  const events: ProfileEvent[] = [];
  let t = 0;
  const dAcc = (VMAX * VMAX) / (2 * ACCEL);
  for (let i = 0; i < dists.length - 1; i++) {
    const g = dists[i + 1] - dists[i];
    const dur = g >= 2 * dAcc
      ? g / VMAX + VMAX / ACCEL            // trapezoid: accel, cruise, brake
      : 2 * Math.sqrt(g / ACCEL);          // short hop: accel then brake
    events.push({ type: 'run', t0: t, t1: t + dur, d0: dists[i], d1: dists[i + 1] });
    t += dur;
    if (i < dists.length - 2) {
      events.push({ type: 'dwell', t0: t, t1: t + DWELL, d0: dists[i + 1], d1: dists[i + 1] });
      t += DWELL;
    }
  }
  return { events, total: t };
}

/** Distance along the path at `t` visual seconds after departure; null once the trip is over. */
export function distAt(profile: Profile, t: number): number | null {
  if (t < 0 || t > profile.total || profile.events.length === 0) return null;
  // Binary search the event containing t.
  const evs = profile.events;
  let lo = 0, hi = evs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (evs[mid].t1 < t) lo = mid + 1; else hi = mid;
  }
  const e = evs[lo];
  if (e.type === 'dwell') return e.d0;
  const g = e.d1 - e.d0;
  const T = e.t1 - e.t0;
  const tt = t - e.t0;
  if (g <= 0 || T <= 0) return e.d0;
  const dAcc = (VMAX * VMAX) / (2 * ACCEL);
  if (g >= 2 * dAcc) {
    const tA = VMAX / ACCEL;
    if (tt <= tA) return e.d0 + 0.5 * ACCEL * tt * tt;
    if (tt >= T - tA) { const r = T - tt; return e.d1 - 0.5 * ACCEL * r * r; }
    return e.d0 + dAcc + VMAX * (tt - tA);
  }
  const half = T / 2;
  if (tt <= half) return e.d0 + 0.5 * ACCEL * tt * tt;
  const r = T - tt;
  return e.d1 - 0.5 * ACCEL * r * r;
}

/* ---------- IST service clock ---------- */

export const SERVICE_START = 5;   // 05:00 IST
export const SERVICE_END = 23;    // 23:00 IST

/** Fractional hour of day in IST (UTC+5:30). */
export function istHour(now = new Date()): number {
  return (now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600 + 5.5) % 24;
}

export function isPeak(h: number): boolean {
  return (h >= 8 && h < 11) || (h >= 17 && h < 21);
}

/** Current real-seconds headway for a line, or null when service is closed. */
export function currentHeadway(cfg: LineConfig, now = new Date()): number | null {
  const h = istHour(now);
  if (h < SERVICE_START || h >= SERVICE_END) return null;
  return isPeak(h) ? cfg.headwayPeak : cfg.headwayOff;
}

/** Trains needed per direction to cover a full trip at peak frequency. */
export function poolSize(profile: Profile, cfg: LineConfig): number {
  return Math.ceil(profile.total / (cfg.headwayPeak / COMPRESS)) + 1;
}
