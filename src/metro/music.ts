/* ============================================================
   The timetable, read as music.

   Nothing here makes a sound — this module turns the service
   simulation into a list of notes, and audio.ts plays them.
   The split mirrors service.ts: pure functions of wall time,
   so the same second sounds the same for every visitor and a
   reload never reshuffles the piece.

   Three ideas carry the whole thing:

   1. A note is placed where the train IS along its route. The
      position along the path picks the degree of the scale, so
      a train pulling out of Whitefield and one pulling into
      Challaghatta are at opposite ends of the instrument.

   2. The scale is a raga chosen by the clock. Hindustani
      practice ties ragas to times of day; the map already
      knows the IST hour (istHour) because it tints the sky
      with it, so the same clock that turns the map to night
      turns the music to Bageshri.

   3. Arrivals are quantised to a grid. At COMPRESS=40 the
      network produces tens of arrivals per second — far too
      many to hear. The grid, plus a per-slot voice budget, is
      what makes this music instead of hail on a roof.
   ============================================================ */

import type { LineConfig, LineData, StationDef } from './data';
import { COMPRESS, BOARD_VIS, currentHeadway, isPeak, istHour, returnPhase, type Profile } from './service';

/* ---------- which lines sing ----------
   Purple alone first: one voice is the only way to actually
   hear whether the position→pitch mapping reads. Add 'green'
   and 'yellow' here to bring in the bass and the lead. */
export const MUSIC_LINES: readonly string[] = ['purple'];

/* ---------- ragas ----------
   Semitone offsets from Sa. These are the traditional scale
   degrees, not melodies — the shape of the instrument, which
   the trains then play. Windows are fractional IST hours and
   follow the customary time-of-day associations. */

export interface Raga {
  name: string;
  /** semitones above Sa, ascending, within one octave */
  degrees: number[];
}

interface RagaWindow {
  from: number;
  to: number;
  raga: Raga;
}

/** Sa = D3. Sits low enough for a bass voice and high enough that
    the lead does not leave the top of the keyboard. */
export const SA = 50;

const RAGA_DAY: RagaWindow[] = [
  { from: 5.0,  to: 7.5,  raga: { name: 'Bhairav',            degrees: [0, 1, 4, 5, 7, 8, 11] } },
  { from: 7.5,  to: 11.0, raga: { name: 'Ahir Bhairav',       degrees: [0, 1, 4, 5, 7, 9, 10] } },
  { from: 11.0, to: 15.0, raga: { name: 'Brindavani Sarang',  degrees: [0, 2, 5, 7, 10] } },
  { from: 15.0, to: 17.5, raga: { name: 'Bhimpalasi',         degrees: [0, 3, 5, 7, 10] } },
  { from: 17.5, to: 20.0, raga: { name: 'Yaman',              degrees: [0, 2, 4, 6, 7, 9, 11] } },
  { from: 20.0, to: 23.0, raga: { name: 'Bageshri',           degrees: [0, 2, 3, 5, 7, 9, 10] } },
];

/** Played by the overnight drone, when no train is running. */
const RAGA_NIGHT: Raga = { name: 'Malkauns', degrees: [0, 3, 5, 8, 10] };

export function ragaAt(hour: number): Raga {
  for (const w of RAGA_DAY) if (hour >= w.from && hour < w.to) return w.raga;
  return RAGA_NIGHT;
}

/** Scale degree `step` (may be negative, or past the octave) as a MIDI note. */
export function degreeToMidi(raga: Raga, step: number): number {
  const n = raga.degrees.length;
  const oct = Math.floor(step / n);
  const idx = ((step % n) + n) % n;
  return SA + oct * 12 + raga.degrees[idx];
}

/* ---------- voices ----------
   One role per line. The ranges are deliberately disjoint so
   three lines never fight over the same octave: you can tell
   which line is running by where it sits in the mix. */

export type VoiceRole = 'bass' | 'keys' | 'lead';

export interface Voice {
  role: VoiceRole;
  /** lowest and highest scale STEP (not semitone) this voice may play */
  loStep: number;
  hiStep: number;
}

export const VOICES: Record<string, Voice> = {
  // Green: the walking bass. Short line, wide steps, stays underneath.
  green:  { role: 'bass', loStep: -7, hiStep: 4 },
  // Purple: the body of the piece. Longest line, most stations, so it
  // gets the widest melodic span — nearly three octaves of the raga.
  purple: { role: 'keys', loStep: 3,  hiStep: 21 },
  // Yellow: the lead. Sparsest headway (480s off-peak), so its notes
  // land rarely and should ring out on top when they do.
  yellow: { role: 'lead', loStep: 17, hiStep: 31 },
};

/** Absolute step bounds per role, folded out of VOICES so the two
    cannot drift apart. */
const ROLE_RANGE: Record<VoiceRole, { lo: number; hi: number }> = (() => {
  const r = {
    bass: { lo: Infinity, hi: -Infinity },
    keys: { lo: Infinity, hi: -Infinity },
    lead: { lo: Infinity, hi: -Infinity },
  };
  for (const v of Object.values(VOICES)) {
    r[v.role].lo = Math.min(r[v.role].lo, v.loStep);
    r[v.role].hi = Math.max(r[v.role].hi, v.hiStep);
  }
  return r;
})();

/* ---------- the note ---------- */

export interface Note {
  /** wall-clock seconds (same epoch as Date.now()/1000) */
  at: number;
  midi: number;
  role: VoiceRole;
  /** 0..1 */
  velocity: number;
  /** seconds */
  duration: number;
  /** -1 left .. +1 right — direction of travel */
  pan: number;
  /** 0 = open sky, 1 = deep tunnel. Drives the low-pass. */
  muffle: number;
  /** extra scale steps sounded with the note (interchanges) */
  chord: number[];
  /** for debugging / the future bars view */
  lineId: string;
  stationId: string;
}

/* ---------- arrival lattice ----------
   Every arrival this service makes, as an offset from its own
   departure. Derived from the motion profile, so it inherits
   the real dwell and accel/brake timing rather than guessing. */

export interface Arrival {
  /** visual seconds after departure */
  t: number;
  /** index into the line's ordered station list */
  stationIdx: number;
  /** path distance at that station */
  d: number;
}

export function arrivalOffsets(profile: Profile): Arrival[] {
  const out: Arrival[] = [];
  let stationIdx = 0;
  for (const e of profile.events) {
    if (e.type === 'dwell') {
      stationIdx++;
      out.push({ t: e.t0, stationIdx, d: e.d0 });
    }
  }
  // The far terminus has no dwell event — the profile simply ends there.
  out.push({ t: profile.total, stationIdx: stationIdx + 1, d: profile.endDist });
  return out;
}

/* ---------- tempo and grid ----------
   Peak hours push the tempo up, which is the honest reading:
   more trains, more notes, more urgency. */

export function bpmAt(hour: number): number {
  return isPeak(hour) ? 96 : 72;
}

/** Grid step in seconds — eighth notes. */
export function gridStep(hour: number): number {
  return 30 / bpmAt(hour);
}

/* ---------- pacing ----------
   One note per role per grid slot, plus a floor on the gap between
   a role's notes. The floor is what gives each voice its character:
   the lead is the same instrument as the keys, just forbidden from
   playing often, which turns it into a soloist. */

const MIN_GAP: Record<VoiceRole, number> = {
  bass: 0.55,
  keys: 0.30,
  lead: 1.40,
};

/** Register each voice gravitates back toward, as a scale step. */
const HOME_STEP: Record<VoiceRole, number> = { bass: -2, keys: 12, lead: 24 };

/** Widest leap a voice will take before the note is octave-folded. */
const MAX_LEAP = 9;

/* ---------- memory ----------
   Quantising one 250ms window at a time cannot produce a melody:
   each window would pick pitches independently and the result
   zigzags across two octaves. The scheduler therefore carries the
   last pitch and last onset per voice from window to window, and
   the selector prefers the candidate nearest the previous note.
   That single change is what turns a scatter of arrivals into a
   line you can follow. */

export interface MusicMemory {
  lastMidi: Record<VoiceRole, number>;
  lastAt: Record<VoiceRole, number>;
}

export function createMemory(): MusicMemory {
  return {
    lastMidi: { bass: 0, keys: 0, lead: 0 },
    lastAt: { bass: -1e9, keys: -1e9, lead: -1e9 },
  };
}

/** Move `midi` by whole octaves until it is within MAX_LEAP of `last`,
    without leaving [lo, hi]. An octave shift leaves the scale degree
    untouched, so the note still says exactly where its train is — only
    which register says it changes. That is what keeps a 37-station line
    from lurching an octave and a half between consecutive arrivals. */
function foldToward(midi: number, last: number, lo: number, hi: number): number {
  if (!last) return midi;
  let m = midi;
  while (m - last > MAX_LEAP && m - 12 >= lo) m -= 12;
  while (last - m > MAX_LEAP && m + 12 <= hi) m += 12;
  return m;
}

/** Deterministic [0,1) from two integers — a stand-in for randomness
    that keeps the piece identical for every listener at a given
    instant. Math.random() here would desynchronise the network. */
function hash01(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ---------- candidate generation ---------- */

export interface LineMusicSetup {
  lineId: string;
  stations: StationDef[];
  profile: Profile;
  arrivals: Arrival[];
  voice: Voice;
  coaches: number;
  /** station ids served by more than one line */
  interchanges: Set<string>;
}

export function buildSetup(
  ld: LineData,
  profile: Profile,
  interchanges: Set<string>,
): LineMusicSetup {
  return {
    lineId: ld.cfg.id,
    stations: ld.stations,
    profile,
    arrivals: arrivalOffsets(profile),
    voice: VOICES[ld.cfg.id] ?? VOICES.purple,
    coaches: ld.cfg.coaches,
    interchanges,
  };
}

/** Interchange stations, from the fact that a station id appears on
    more than one line's ordered list. */
export function findInterchanges(all: LineData[]): Set<string> {
  const seen = new Map<string, number>();
  for (const ld of all) {
    for (const s of ld.stations) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
  }
  const out = new Set<string>();
  seen.forEach((n, id) => { if (n > 1) out.add(id); });
  return out;
}

/** One raw arrival, before quantising and thinning. */
interface Candidate extends Note {
  /** higher wins when the slot is oversubscribed */
  priority: number;
}

/**
 * Every arrival across the given lines whose wall time falls in
 * [t0, t1), turned into a candidate note.
 *
 * This is pure lattice arithmetic — no simulation stepping. Each
 * station's arrivals repeat every headway, so for a window a few
 * hundred milliseconds wide there is at most one departure number
 * per station to consider.
 */
export function candidatesInWindow(
  setups: LineMusicSetup[],
  cfgs: LineConfig[],
  t0: number,
  t1: number,
  wallDate: Date,
): Candidate[] {
  const hour = istHour(wallDate);
  const raga = ragaAt(hour);
  const out: Candidate[] = [];

  setups.forEach((su, i) => {
    const headwayReal = currentHeadway(cfgs[i], wallDate);
    if (headwayReal == null) return;          // service closed — silence
    const H = headwayReal / COMPRESS;
    const phases: [number, number] = [0, returnPhase(su.profile, H)];
    const span = su.profile.endDist - su.profile.startDist || 1;
    const steps = su.voice.hiStep - su.voice.loStep;

    for (let dir = 0; dir < 2; dir++) {
      const phase = phases[dir];
      for (const a of su.arrivals) {
        // Wall times of this arrival are n*H + phase + a.t. Find the n's
        // landing inside the window.
        const nLo = Math.ceil((t0 - phase - a.t) / H);
        const nHi = Math.floor((t1 - phase - a.t) / H);
        for (let n = nLo; n <= nHi; n++) {
          const at = n * H + phase + a.t;
          if (at < t0 || at >= t1) continue;

          // Direction B walks the same profile from the far terminus, so
          // both the station it reaches and its melodic direction invert.
          const idx = dir
            ? su.stations.length - 1 - a.stationIdx
            : a.stationIdx;
          const sd = su.stations[idx];
          if (!sd) continue;

          // Position along the route picks the degree. Ascending outbound,
          // descending on the return — the line breathes in and out.
          const u = Math.min(1, Math.max(0, (a.d - su.profile.startDist) / span));
          const uu = dir ? 1 - u : u;
          const step = su.voice.loStep + Math.round(uu * steps);

          const isInterchange = su.interchanges.has(sd.id);
          const isTerminus = idx === 0 || idx === su.stations.length - 1;

          // An interchange is two lines meeting, so it sounds as an
          // interval rather than a single note.
          const chord: number[] = isInterchange ? [4] : [];

          out.push({
            at,
            midi: degreeToMidi(raga, step),
            role: su.voice.role,
            // Six-coach trainsets hit harder than three.
            velocity: (su.coaches >= 6 ? 0.85 : 0.6) * (isTerminus ? 1 : 0.9),
            duration: su.voice.role === 'bass' ? 0.9 : su.voice.role === 'lead' ? 1.6 : 0.7,
            // Direction becomes stereo position: the two tracks separate.
            pan: dir ? 0.5 : -0.5,
            // The tunnel section really is muffled.
            muffle: sd.underground ? 0.85 : 0,
            chord,
            lineId: su.lineId,
            stationId: sd.id,
            priority: (isInterchange ? 2 : 0) + (isTerminus ? 1 : 0) + (sd.local ? 0 : 0.5),
          });
        }
      }
    }
  });

  return out;
}

/* ---------- quantise and thin ----------
   The firehose becomes a phrase here. Candidates snap to the
   nearest grid slot; each slot keeps only its most interesting
   few, and never two notes at the same pitch. */

export function quantise(
  cands: Candidate[],
  hour: number,
  mem: MusicMemory,
  gridOrigin = 0,
): Note[] {
  if (cands.length === 0) return [];
  const step = gridStep(hour);
  const raga = ragaAt(hour);

  // Group by grid slot, then walk the slots in time order — voice
  // leading only means anything if decisions are made in sequence.
  const bySlot = new Map<number, Candidate[]>();
  for (const c of cands) {
    const slot = Math.round((c.at - gridOrigin) / step);
    const arr = bySlot.get(slot);
    if (arr) arr.push(c); else bySlot.set(slot, [c]);
  }

  const out: Note[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const group = bySlot.get(slot)!;
    const at = gridOrigin + slot * step;
    const takenRole = new Set<VoiceRole>();

    // Cheapest move wins. Weights are in semitones so they can be
    // compared honestly: a step of a tone costs 2, and the most
    // interesting arrival on offer (an interchange terminus) can buy
    // itself about a minor third of extra leap — enough to be reached
    // sometimes, not enough to shatter the line.
    const cost = (c: Candidate) => {
      const last = mem.lastMidi[c.role];
      const interval = last ? Math.abs(c.midi - last) : 0;
      const home = degreeToMidi(raga, HOME_STEP[c.role]);
      return interval
        - 0.9 * c.priority              // reward the notable stations
        + 0.06 * Math.abs(c.midi - home); // and drift back to register
    };
    group.sort((a, b) => cost(a) - cost(b));

    for (const c of group) {
      if (takenRole.has(c.role)) continue;               // one note per voice per slot
      if (at - mem.lastAt[c.role] < MIN_GAP[c.role]) continue;
      // A repeated pitch reads as a stutter rather than a melody.
      if (c.midi === mem.lastMidi[c.role] && hash01(slot, c.midi) < 0.7) continue;
      const lo = degreeToMidi(raga, ROLE_RANGE[c.role].lo);
      const hi = degreeToMidi(raga, ROLE_RANGE[c.role].hi);
      const midi = foldToward(c.midi, mem.lastMidi[c.role], lo, hi);
      takenRole.add(c.role);
      mem.lastMidi[c.role] = midi;
      mem.lastAt[c.role] = at;
      out.push({ ...c, at, midi });
    }
  }

  return out.sort((a, b) => a.at - b.at);
}

/** The scheduler's whole job, as one pure call. */
export function notesInWindow(
  setups: LineMusicSetup[],
  cfgs: LineConfig[],
  t0: number,
  t1: number,
  wallDate: Date,
  mem: MusicMemory,
): Note[] {
  const cands = candidatesInWindow(setups, cfgs, t0, t1, wallDate);
  return quantise(cands, istHour(wallDate), mem);
}

/* ---------- the drone ----------
   Under the notes, a held Sa and Pa. Its weight follows how much
   service is actually running, so the piece thins out with the
   timetable and, after 23:00, becomes the only thing left. */

export interface DroneState {
  /** MIDI notes to hold */
  notes: number[];
  /** 0..1 */
  level: number;
  ragaName: string;
}

export function droneAt(wallDate: Date, running: boolean): DroneState {
  const hour = istHour(wallDate);
  const raga = ragaAt(hour);
  const sa = SA - 12;
  // Pa where the raga has one, else its nearest upper degree.
  const pa = raga.degrees.includes(7) ? 7 : raga.degrees[raga.degrees.length - 2];
  return {
    notes: [sa, sa + pa],
    // Overnight the drone is alone, so it comes up to carry the piece.
    level: running ? (isPeak(hour) ? 0.16 : 0.22) : 0.3,
    ragaName: raga.name,
  };
}

/** Lead time the scheduler keeps between deciding a note and hearing it. */
export const LOOKAHEAD = 0.25;
/** How often the scheduler wakes. Must be well under LOOKAHEAD. */
export const TICK_MS = 40;

/** Boarding lead used by the visual loop, re-exported so the audio
    scheduler and the map agree on the same departure lattice. */
export { BOARD_VIS };
