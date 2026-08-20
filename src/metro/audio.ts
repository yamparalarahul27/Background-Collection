/* ============================================================
   The instrument.

   music.ts decides what to play; this plays it. Hand-rolled
   WebAudio, no dependencies — three voices, a drone, one shared
   plate reverb, and a lookahead scheduler.

   The scheduler is the part that matters. Notes are NOT fired
   from requestAnimationFrame: rAF is display-locked, jittery by
   several milliseconds, and stops entirely in a background tab,
   all of which are audible as sloppy rhythm. Instead we wake on
   a timer, ask music.ts what happens over the next quarter
   second, and hand those notes to WebAudio with exact start
   times. WebAudio then plays them from its own high-resolution
   clock, so the rhythm is sample-accurate even while the main
   thread is busy laying out labels.

   This works only because the service simulation is a pure
   function of wall time — we can ask what the network will be
   doing 250ms from now. A live feed could not answer that.
   ============================================================ */

import type { LineConfig } from './data';
import {
  LOOKAHEAD, TICK_MS, createMemory, droneAt, notesInWindow,
  type LineMusicSetup, type MusicMemory, type Note,
} from './music';

/** Hard ceiling on simultaneously sounding notes. */
const MAX_VOICES = 14;

type Cfg = LineConfig;

/* ---------- a plate, from noise ----------
   Cheap convolution reverb: an impulse response is just a burst
   of noise that decays, and that is exactly what a room sounds
   like from the inside. Two seconds of it puts the trains in a
   station concourse instead of an anechoic void. */
function buildImpulse(ctx: AudioContext, seconds = 2.4, decay = 2.6): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // A little early-reflection sparseness at the head reads as a big room.
      const gate = i < rate * 0.01 ? 1 : Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * gate;
    }
  }
  return buf;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class MetroInstrument {
  private ctx: AudioContext;
  private master: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private reverb: ConvolverNode;
  private droneGain: GainNode;
  private droneOscs: { osc: OscillatorNode; gain: GainNode }[] = [];
  private droneNotes: number[] = [];
  private live = 0;

  /* scheduler */
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;        // wall-clock seconds already scheduled
  private anchorWall = 0;
  private anchorCtx = 0;
  private setups: LineMusicSetup[] = [];
  private cfgs: Cfg[] = [];
  /** Carries melodic continuity across scheduling windows. */
  private mem: MusicMemory = createMemory();

  /** Latest raga name, for the UI to display. */
  ragaName = '';

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    // Keep the sum of many notes from clipping without audibly pumping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.006;
    comp.release.value = 0.28;

    this.master = ctx.createGain();
    this.master.gain.value = 0;          // faded in by start()

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = buildImpulse(ctx);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.78;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.34;

    this.dry.connect(this.master);
    this.wet.connect(this.reverb).connect(this.master);
    this.master.connect(comp).connect(ctx.destination);

    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneGain.connect(this.dry);
    this.droneGain.connect(this.wet);
  }

  /** Bind the service data the scheduler will read. */
  configure(setups: LineMusicSetup[], cfgs: Cfg[]) {
    this.setups = setups;
    this.cfgs = cfgs;
  }

  /* ---------- transport ---------- */

  start() {
    if (this.timer) return;
    const now = Date.now() / 1000;
    this.anchorWall = now;
    this.anchorCtx = this.ctx.currentTime;
    // Start a hair ahead so the first slot is not already in the past.
    this.cursor = now + 0.05;
    this.mem = createMemory();
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(this.master.gain.value, this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0.9, this.ctx.currentTime + 0.6);
    this.startDrone();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0, t + 0.45);
    this.stopDrone(t + 0.5);
  }

  dispose() {
    this.stop();
    setTimeout(() => { void this.ctx.close(); }, 700);
  }

  /** AudioContext time for a wall-clock instant. */
  private toCtxTime(wall: number): number {
    return this.anchorCtx + (wall - this.anchorWall);
  }

  private tick() {
    const nowWall = Date.now() / 1000;
    const nowCtx = this.ctx.currentTime;

    // The two clocks drift (and the AudioContext one stalls if the tab is
    // throttled). Re-anchor when they disagree enough to be heard.
    const predicted = this.toCtxTime(nowWall);
    if (Math.abs(predicted - nowCtx) > 0.12) {
      this.anchorWall = nowWall;
      this.anchorCtx = nowCtx;
      if (this.cursor < nowWall) this.cursor = nowWall;
    }

    const horizon = nowWall + LOOKAHEAD;
    if (this.cursor >= horizon) return;

    const wallDate = new Date(nowWall * 1000);
    const notes = notesInWindow(this.setups, this.cfgs, this.cursor, horizon, wallDate, this.mem);
    for (const n of notes) this.play(n);

    this.cursor = horizon;
    this.updateDrone(wallDate, notes.length > 0);
  }

  /* ---------- voices ---------- */

  private play(n: Note) {
    if (this.live >= MAX_VOICES) return;
    const when = this.toCtxTime(n.at);
    // A note whose slot already passed (tab was asleep) is dropped, not rushed.
    if (when < this.ctx.currentTime - 0.02) return;
    this.strike(n, n.midi, when, 1);
    for (const extra of n.chord) {
      this.strike(n, n.midi + extra, when, 0.55);
    }
  }

  private strike(n: Note, midi: number, when: number, scale: number) {
    const ctx = this.ctx;
    const hz = midiToHz(midi);
    const dur = n.duration;
    const vel = n.velocity * scale;

    const amp = ctx.createGain();
    amp.gain.value = 0;

    // The tunnel sections are genuinely muffled, so underground stations
    // come through a closed filter.
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    const open = n.role === 'bass' ? 900 : n.role === 'lead' ? 5200 : 3200;
    filt.frequency.value = open * (1 - 0.82 * n.muffle);
    filt.Q.value = n.role === 'lead' ? 1.1 : 0.7;

    const pan = ctx.createStereoPanner();
    pan.pan.value = n.pan;

    amp.connect(filt).connect(pan);
    pan.connect(this.dry);
    pan.connect(this.wet);

    const oscs: OscillatorNode[] = [];
    const mk = (type: OscillatorType, detune: number, gain: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(amp);
      oscs.push(o);
      return o;
    };

    let attack: number, release: number, peak: number;
    switch (n.role) {
      case 'bass':
        // Round and short — a plucked upright, not a synth pad.
        mk('sine', 0, 0.9);
        mk('triangle', 0, 0.35);
        attack = 0.008; release = dur * 0.9; peak = 0.5 * vel;
        break;
      case 'lead':
        // Reedy, with a slow vibrato so held notes stay alive.
        mk('sawtooth', 0, 0.22);
        mk('triangle', 6, 0.3);
        attack = 0.06; release = dur; peak = 0.26 * vel;
        {
          const lfo = ctx.createOscillator();
          const depth = ctx.createGain();
          lfo.frequency.value = 5.2;
          depth.gain.value = 5.5;
          lfo.connect(depth);
          for (const o of oscs) depth.connect(o.detune);
          lfo.start(when);
          lfo.stop(when + dur + 0.4);
        }
        break;
      default:
        // Keys: two slightly detuned triangles read as struck metal
        // once the envelope decays fast. Vibes, roughly.
        mk('triangle', -4, 0.5);
        mk('triangle', 5, 0.5);
        mk('sine', 1200, 0.12);          // an octave-ish shimmer on the attack
        attack = 0.004; release = dur; peak = 0.34 * vel;
    }

    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, when + attack);
    // Exponential tail: decays like something struck.
    amp.gain.exponentialRampToValueAtTime(0.0001, when + attack + release);

    const end = when + attack + release + 0.05;
    this.live++;
    for (const o of oscs) { o.start(when); o.stop(end); }
    oscs[0].onended = () => {
      this.live--;
      pan.disconnect();
      filt.disconnect();
      amp.disconnect();
    };
  }

  /* ---------- drone ---------- */

  private startDrone() {
    if (this.droneOscs.length) return;
    const ctx = this.ctx;
    // Two per pitch, detuned against each other — the beating between them
    // is what keeps a held tone from sounding like a test signal.
    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.type = i % 2 ? 'triangle' : 'sine';
      osc.frequency.value = 110;
      osc.detune.value = i % 2 ? 7 : -7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.droneGain);
      osc.start();
      this.droneOscs.push({ osc, gain });
    }
  }

  private stopDrone(at: number) {
    for (const d of this.droneOscs) {
      d.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      d.gain.gain.setValueAtTime(d.gain.gain.value, this.ctx.currentTime);
      d.gain.gain.linearRampToValueAtTime(0, at);
      d.osc.stop(at + 0.1);
    }
    this.droneOscs = [];
  }

  private updateDrone(wallDate: Date, running: boolean) {
    const st = droneAt(wallDate, running);
    this.ragaName = st.ragaName;
    const t = this.ctx.currentTime;
    // Slow glide, so a raga change at the top of the hour is a modulation
    // rather than a jump cut.
    const same = st.notes.length === this.droneNotes.length &&
      st.notes.every((m, i) => m === this.droneNotes[i]);
    if (!same) {
      this.droneNotes = st.notes;
      this.droneOscs.forEach((d, i) => {
        const midi = st.notes[i >> 1] ?? st.notes[0];
        d.osc.frequency.cancelScheduledValues(t);
        d.osc.frequency.setValueAtTime(d.osc.frequency.value, t);
        d.osc.frequency.linearRampToValueAtTime(midiToHz(midi), t + 3.5);
      });
    }
    this.droneGain.gain.cancelScheduledValues(t);
    this.droneGain.gain.setValueAtTime(this.droneGain.gain.value, t);
    this.droneGain.gain.linearRampToValueAtTime(st.level, t + 1.5);
    this.droneOscs.forEach(d => {
      if (d.gain.gain.value < 0.24) {
        d.gain.gain.cancelScheduledValues(t);
        d.gain.gain.setValueAtTime(d.gain.gain.value, t);
        d.gain.gain.linearRampToValueAtTime(0.25, t + 2);
      }
    });
  }
}
