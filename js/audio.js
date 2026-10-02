// Every sound is synthesised with the Web Audio API — no sound files.
import { settings } from "./settings.js";

let ctx = null;
let master = null;
let noiseBuf = null;
let unlocked = false;

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({ latencyHint: "interactive" });
    master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(ctx.destination);
    // 2 s of white noise, reused by every noisy sound
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** Call from the first user gesture so later sounds can play. */
export function unlockAudio() {
  const once = () => { unlocked = true; ensure(); removeEventListener("pointerdown", once, true); };
  addEventListener("pointerdown", once, true);
}

export function setVolume(v) { if (master) master.gain.value = v; }

/** Shared context + master bus for the ambience engine (null until the first gesture). */
export const audioContext = () => (unlocked ? ensure() : null);
export const masterNode = () => master;

function ok() { return settings.sound && unlocked && ensure(); }

function env(gainNode, t, attack, peak, decay) {
  const g = gainNode.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noise(t, dur, { type = "bandpass", freq = 2000, q = 1, peak = 0.3, attack = 0.002, offset = Math.random() } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, attack, peak, dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, offset * 1.5, attack + dur + 0.05);
  return { src, f, g };
}

function tone(t, { type = "sine", freq = 440, to, dur = 0.2, peak = 0.2, attack = 0.005 } = {}) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  env(g, t, attack, peak, dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + attack + dur + 0.05);
  return { o, g };
}

/** Turbine spool that follows the throttle lever while it is held. */
const spool = {
  nodes: null,
  start(f = 0) {
    if (!ok()) return;
    if (this.nodes) { clearTimeout(this.nodes.kill); this.nodes.kill = 0; this.set(f); return; }
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.connect(master);
    const roar = ctx.createBufferSource();
    roar.buffer = noiseBuf; roar.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 0.7;
    const rg = ctx.createGain(); rg.gain.value = 1;
    roar.connect(lp).connect(rg).connect(out);
    const whine = ctx.createOscillator();
    whine.type = "sawtooth";
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 9;
    const wg = ctx.createGain(); wg.gain.value = 0.05;
    whine.connect(bp).connect(wg).connect(out);
    roar.start(t); whine.start(t);
    this.nodes = { out, lp, whine, bp, roar, kill: 0 };
    this.set(f, 0.02);
  },
  set(f, tc = 0.12) {
    const n = this.nodes;
    if (!n || n.kill) return;
    const t = ctx.currentTime;
    f = Math.max(0, Math.min(1, f));
    n.lp.frequency.setTargetAtTime(180 + 1500 * f * f, t, tc);
    n.whine.frequency.setTargetAtTime(240 + 1100 * f, t, tc);
    n.bp.frequency.setTargetAtTime(480 + 2200 * f, t, tc);
    n.out.gain.setTargetAtTime(0.05 + 0.13 * f, t, tc);
  },
  stop() {
    const n = this.nodes;
    if (!n || n.kill) return;
    n.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25);
    n.kill = setTimeout(() => {
      n.roar.stop(); n.whine.stop(); n.out.disconnect();
      if (this.nodes === n) this.nodes = null;
    }, 1600);
  },
};

export const sfx = {
  spool,
  /** dial detent: a tiny dry tick */
  /** dial detent: a ratchet pawl dropping into a gear tooth (heavier on the quarter hours) */
  tick(major = false) {
    if (!ok()) return;
    const t = ctx.currentTime;
    noise(t, 0.008, { type: "highpass", freq: 3800, q: 0.7, peak: major ? 0.12 : 0.07 });
    noise(t + 0.009, 0.014, { type: "bandpass", freq: major ? 1600 : 2600, q: 6, peak: major ? 0.16 : 0.08 });
    tone(t + 0.009, { type: "triangle", freq: major ? 940 : 1480, to: major ? 860 : 1380, dur: 0.035, peak: major ? 0.04 : 0.02 });
  },

  /** a smaller tick for the radar passing a small airport */
  radarTick() {
    if (!ok()) return;
    tone(ctx.currentTime, { freq: 2100, to: 1900, dur: 0.03, peak: 0.025 });
  },

  /** the embosser punching a letter into tape */
  emboss() {
    if (!ok()) return;
    const t = ctx.currentTime;
    noise(t, 0.02, { type: "bandpass", freq: 1900, q: 3, peak: 0.22 });
    tone(t, { type: "square", freq: 190, to: 120, dur: 0.05, peak: 0.05 });
    noise(t + 0.06, 0.02, { type: "highpass", freq: 3000, q: 1, peak: 0.08 });
  },

  /** seat LED coming on */
  led() {
    if (!ok()) return;
    tone(ctx.currentTime + 0.12, { freq: 1760, dur: 0.12, peak: 0.03 });
  },

  /** radar reaches an airport: a soft sonar ping, pitch varies with distance */
  blip(pitch = 1) {
    if (!ok()) return;
    const t = ctx.currentTime;
    const f = 1250 * pitch;
    tone(t, { freq: f, to: f * 0.82, dur: 0.16, peak: 0.07 });
    tone(t, { type: "triangle", freq: f * 2, to: f * 1.6, dur: 0.06, peak: 0.02 });
  },

  /** seatbelt buckle: metal tongue sliding in, then the latch */
  seatbelt() {
    if (!ok()) return;
    const t = ctx.currentTime;
    noise(t, 0.05, { type: "bandpass", freq: 3200, q: 2, peak: 0.08 });
    noise(t + 0.075, 0.03, { type: "bandpass", freq: 5200, q: 6, peak: 0.35 });
    tone(t + 0.075, { type: "square", freq: 2400, to: 1800, dur: 0.025, peak: 0.05 });
    noise(t + 0.1, 0.06, { type: "lowpass", freq: 900, q: 1, peak: 0.12 });
  },

  /** luggage tag snapping onto the rail */
  snap() {
    if (!ok()) return;
    const t = ctx.currentTime;
    noise(t, 0.02, { type: "bandpass", freq: 2600, q: 3, peak: 0.2 });
    tone(t, { type: "triangle", freq: 660, to: 520, dur: 0.05, peak: 0.05 });
  },

  /** paper fibres stretching (played as the tear progresses) */
  strain() {
    if (!ok()) return;
    const t = ctx.currentTime;
    noise(t, 0.03, { type: "bandpass", freq: 1800 + Math.random() * 1400, q: 4, peak: 0.05 });
  },

  /** the stub separates: a fast rip with crackle */
  tear() {
    if (!ok()) return;
    const t = ctx.currentTime;
    const r = noise(t, 0.28, { type: "bandpass", freq: 2400, q: 0.8, peak: 0.45, attack: 0.004 });
    r.f.frequency.setValueAtTime(3400, t);
    r.f.frequency.exponentialRampToValueAtTime(1200, t + 0.28);
    for (let i = 0; i < 9; i++) {
      noise(t + i * 0.024 + Math.random() * 0.01, 0.012, { type: "highpass", freq: 3000, q: 1, peak: 0.25 });
    }
    noise(t + 0.02, 0.18, { type: "lowpass", freq: 500, q: 0.7, peak: 0.15 });
  },

  /** pass printer: a stepped motor feed */
  printer(duration = 1.2, steps = 14) {
    if (!ok()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < steps; i++) {
      const s = t + (i * duration) / steps;
      noise(s, 0.05, { type: "bandpass", freq: 900, q: 2.5, peak: 0.07 });
      tone(s, { type: "square", freq: 180, to: 150, dur: 0.04, peak: 0.012 });
    }
    noise(t + duration, 0.05, { type: "bandpass", freq: 1500, q: 3, peak: 0.08 });
  },

  /** soft UI tap */
  tap() {
    if (!ok()) return;
    tone(ctx.currentTime, { type: "sine", freq: 880, to: 700, dur: 0.05, peak: 0.04 });
  },

  /** passport stamp hitting paper on a desk */
  /** a wooden stamp hitting paper on a desk: knock, body, a little rattle */
  thud() {
    if (!ok()) return;
    const t = ctx.currentTime;
    tone(t, { freq: 120, to: 42, dur: 0.22, peak: 0.55, attack: 0.002 });
    noise(t, 0.09, { type: "lowpass", freq: 700, q: 0.8, peak: 0.6, attack: 0.001 });
    // the hollow wood body
    noise(t + 0.002, 0.12, { type: "bandpass", freq: 420, q: 7, peak: 0.35, attack: 0.001 });
    tone(t + 0.002, { type: "sine", freq: 245, to: 228, dur: 0.16, peak: 0.12, attack: 0.001 });
    noise(t + 0.004, 0.03, { type: "bandpass", freq: 2400, q: 1.5, peak: 0.18, attack: 0.001 });
    noise(t + 0.07, 0.03, { type: "bandpass", freq: 900, q: 4, peak: 0.08 });          // handle rattle
  },

  /** tick while holding the abort button */
  holdTick(k = 0) {
    if (!ok()) return;
    tone(ctx.currentTime, { type: "triangle", freq: 520 + k * 260, to: 500 + k * 250, dur: 0.05, peak: 0.05 });
  },

  /** window shade sliding */
  shade(down = true) {
    if (!ok()) return;
    const t = ctx.currentTime;
    const r = noise(t, 0.42, { type: "bandpass", freq: down ? 1400 : 900, q: 0.9, peak: 0.12, attack: 0.03 });
    r.f.frequency.exponentialRampToValueAtTime(down ? 700 : 1600, t + 0.4);
    noise(t + 0.42, 0.03, { type: "bandpass", freq: 1800, q: 3, peak: 0.12 });
  },

  /** two-tone cabin chime */
  chime() {
    if (!ok()) return;
    const t = ctx.currentTime;
    for (const [dt, f] of [[0, 784], [0.45, 587]]) {
      tone(t + dt, { freq: f, dur: 1.6, peak: 0.12, attack: 0.01 });
      tone(t + dt, { freq: f * 2.01, dur: 0.9, peak: 0.025, attack: 0.01 });
    }
  },

  /** take-off: engines spool up, a long roar that fades as we climb away */
  takeoff(seconds = 7) {
    if (!ok()) return;
    const t = ctx.currentTime;
    const roar = ctx.createBufferSource();
    roar.buffer = noiseBuf; roar.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + seconds * 0.35);
    lp.frequency.exponentialRampToValueAtTime(380, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + seconds * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    roar.connect(lp).connect(g).connect(master);
    roar.start(t); roar.stop(t + seconds + 0.1);

    const whine = ctx.createOscillator();
    whine.type = "sawtooth";
    whine.frequency.setValueAtTime(220, t);
    whine.frequency.exponentialRampToValueAtTime(1300, t + seconds * 0.4);
    const wf = ctx.createBiquadFilter();
    wf.type = "bandpass"; wf.frequency.value = 1500; wf.Q.value = 6;
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.exponentialRampToValueAtTime(0.02, t + seconds * 0.35);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    whine.connect(wf).connect(wg).connect(master);
    whine.start(t); whine.stop(t + seconds + 0.1);
  },
};
