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
  /** path distance of the origin terminus */
  startDist: number;
  /** path distance of the far terminus */
  endDist: number;
}

export function buildProfile(stationDists: number[], dwell: number = DWELL): Profile {
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
      events.push({ type: 'dwell', t0: t, t1: t + dwell, d0: dists[i + 1], d1: dists[i + 1] });
      t += dwell;
    }
  }
  return { events, total: t, startDist: dists[0] ?? 0, endDist: dists[dists.length - 1] ?? 0 };
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

/* ---------- the Bengaluru sky ---------- */

/** True when the map should default to night (sunset ~18:45, sunrise ~6:15 IST). */
export function autoNight(h: number): boolean {
  return h < 6.25 || h >= 18.75;
}

/** 0..1 warm tint strength during the dawn (5:45–6:45) and dusk (18:00–19:00)
    windows — rises to full mid-window and fades back out. */
export function twilightStrength(h: number): number {
  const windows: [number, number][] = [[5.75, 6.75], [18.0, 19.0]];
  for (const [a, b] of windows) {
    if (h >= a && h <= b) return Math.sin(((h - a) / (b - a)) * Math.PI);
  }
  return 0;
}

/** Current real-seconds headway for a line, or null when service is closed. */
export function currentHeadway(cfg: LineConfig, now = new Date()): number | null {
  const h = istHour(now);
  if (h < SERVICE_START || h >= SERVICE_END) return null;
  return isPeak(h) ? cfg.headwayPeak : cfg.headwayOff;
}

/* ---------- terminus turnaround ----------
   A service is more than its run: the train is visible boarding at
   the origin before departure, and after arriving it waits at its own
   arrival platform, then slides across the crossover timed to land
   exactly as the return departure (on the other direction's schedule)
   fades in at the same spot — one continuous turnaround, and a berth
   never holds two solid trains. Visual seconds. */

export const BOARD_VIS = 1.2;     // sitting at the origin before departure
export const FADE_VIS = 0.4;      // fade in/out at the seam
export const TURN_SLIDE = 1.0;    // crossover slide to the opposite track
export const TURN_PAUSE = 0.4;    // minimum pause at the arrival platform

/** Minimum extra time a train exists past its arrival. */
export const TURN_TOTAL = TURN_PAUSE + TURN_SLIDE + FADE_VIS;

export interface TrainState {
  /** distance along the profile (0 = origin terminus) */
  d: number;
  /** 0 = on its own track, 1 = fully crossed to the opposite track */
  crossover: number;
  opacity: number;
}

/** True while the service is stopped at an intermediate station. */
export function isDwelling(profile: Profile, t: number): boolean {
  if (t <= 0 || t >= profile.total || profile.events.length === 0) return false;
  const evs = profile.events;
  let lo = 0, hi = evs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (evs[mid].t1 < t) lo = mid + 1; else hi = mid;
  }
  return evs[lo].type === 'dwell';
}

/** Full visual lifecycle of one service at `t` seconds after departure.
    `slideDelay` is how long the arrived train waits at its own platform
    before crossing over; on landing it immediately crossfades out
    (mirroring the return train's boarding fade-in exactly). */
export function trainStateAt(profile: Profile, t: number, slideDelay = TURN_PAUSE): TrainState | null {
  if (t < -BOARD_VIS || profile.events.length === 0) return null;
  if (t < 0) {
    const op = Math.min(1, (t + BOARD_VIS) / FADE_VIS);
    return { d: profile.startDist, crossover: 0, opacity: op };
  }
  if (t <= profile.total) {
    const d = distAt(profile, t);
    return d == null ? null : { d, crossover: 0, opacity: 1 };
  }
  const over = t - profile.total;
  const slideEnd = slideDelay + TURN_SLIDE;
  if (over > slideEnd + FADE_VIS) return null;
  const opacity = over <= slideEnd ? 1 : 1 - (over - slideEnd) / FADE_VIS;
  if (over <= slideDelay) return { d: profile.endDist, crossover: 0, opacity: 1 };
  if (over <= slideEnd) {
    const u = (over - slideDelay) / TURN_SLIDE;
    return { d: profile.endDist, crossover: u * u * (3 - 2 * u), opacity };
  }
  return { d: profile.endDist, crossover: 1, opacity };
}

/** How long an arrived train waits at its own platform before crossing
    over — timed so the crossover LANDS exactly when the next return
    departure starts boarding, and the two crossfade with opacities
    summing to one. Falls back to a prompt slide-and-fade if waiting
    would collide with the next arrival behind it. */
export function turnaroundSlideDelay(
  profile: Profile, headwayVis: number, phaseSelf: number, phaseOpp: number, n: number,
): number {
  // Wall time when this service reaches the far terminus.
  const arrive = n * headwayVis + phaseSelf + profile.total;
  // Opposite direction's boarding-start lattice: m*H + phaseOpp - BOARD_VIS.
  const anchor = phaseOpp - BOARD_VIS;
  // Earliest crossover landing after the platform pause. The aligned end
  // sits exactly on a lattice point by construction — the epsilon keeps
  // floating error from tipping ceil() up a whole headway.
  const minLand = arrive + TURN_PAUSE + TURN_SLIDE;
  const land = Math.ceil((minLand - anchor) / headwayVis - 1e-6) * headwayVis + anchor;
  let slideDelay = land - TURN_SLIDE - arrive;
  // The arrival platform must clear before the NEXT train arrives behind
  // us. If waiting for the aligned boarding slot would take too long,
  // slip across once the PREVIOUS departure has pulled clear of the berth.
  if (slideDelay > headwayVis - 0.8) {
    slideDelay = slideDelay - headwayVis + BOARD_VIS + FADE_VIS + 0.4;
  }
  return slideDelay;
}

/** Phase (seconds into the headway cycle, visual time) for the opposite
    direction so its boardings line up with arriving trains landing off
    the crossover — the eye reads a continuous turnaround. */
export function returnPhase(profile: Profile, headwayVis: number): number {
  const t = profile.total + TURN_PAUSE + TURN_SLIDE + BOARD_VIS;
  return ((t % headwayVis) + headwayVis) % headwayVis;
}

/** Trains needed per direction to cover boarding + trip + turnaround at peak
    (the platform wait can extend up to one extra headway). */
export function poolSize(profile: Profile, cfg: LineConfig): number {
  const H = cfg.headwayPeak / COMPRESS;
  return Math.ceil((profile.total + BOARD_VIS + TURN_TOTAL + H) / H) + 1;
}
