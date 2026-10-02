// In-flight ambience, all synthesised: engine hum, rain on the fuselage, quiet cabin air.
// Three channels with their own level; levels persist in settings.
import { audioContext, masterNode } from "./audio.js";
import { settings, updateSettings } from "./settings.js";

export const CHANNELS = [
  { id: "engine", name: "Engine hum", hint: "Deep, steady drone" },
  { id: "rain", name: "Rain", hint: "On the fuselage" },
  { id: "cabin", name: "Quiet cabin", hint: "Air and soft hush" },
];

let nodes = null;
let running = false;

function noiseBuffer(ctx, seconds, color) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === "brown") { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else if (color === "pink") {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else d[i] = w;
    }
    // crossfade the loop seam
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) { const k = i / fade; d[i] = d[i] * k + d[len - fade + i] * (1 - k); }
  }
  return buf;
}

function loop(ctx, buf) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true;
  s.start(0, Math.random() * (buf.duration - 0.2));
  return s;
}

function build() {
  const ctx = audioContext();
  if (!ctx) return null;
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(masterNode());
  const ch = {};

  // engine: brown noise rumble + two slowly beating low tones
  {
    const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 340; lp.Q.value = 0.4;
    loop(ctx, noiseBuffer(ctx, 6, "brown")).connect(lp).connect(g);
    const hum = ctx.createGain(); hum.gain.value = 0.05; hum.connect(g);
    for (const f of [68, 68.7, 136.4]) {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(hum); o.start();
    }
    const whine = ctx.createBiquadFilter(); whine.type = "bandpass"; whine.frequency.value = 2900; whine.Q.value = 18;
    const wg = ctx.createGain(); wg.gain.value = 0.05;
    loop(ctx, noiseBuffer(ctx, 3, "white")).connect(whine).connect(wg).connect(g);
    ch.engine = g;
  }
  // rain: band-limited hiss + random droplets ticking on the skin
  {
    const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6500;
    const hg = ctx.createGain(); hg.gain.value = 0.35;
    loop(ctx, noiseBuffer(ctx, 4, "pink")).connect(hp).connect(lp).connect(hg).connect(g);
    const dropBus = ctx.createGain(); dropBus.gain.value = 0.5; dropBus.connect(g);
    const white = noiseBuffer(ctx, 1, "white");
    ch.rainTimer = setInterval(() => {
      if (!running || g.gain.value < 0.01) return;
      const t = ctx.currentTime;
      for (let i = 0; i < 6; i++) {
        const s = ctx.createBufferSource(); s.buffer = white;
        const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800 + Math.random() * 4000; f.Q.value = 8;
        const e = ctx.createGain();
        const at = t + Math.random() * 0.12;
        e.gain.setValueAtTime(0.0001, at);
        e.gain.exponentialRampToValueAtTime(0.25 * Math.random() + 0.05, at + 0.002);
        e.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
        s.connect(f).connect(e).connect(dropBus);
        s.start(at, Math.random() * 0.8, 0.05);
      }
    }, 120);
    ch.rain = g;
  }
  // cabin: soft pink air-conditioning hush with a slow swell
  {
    const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 700; bp.Q.value = 0.5;
    const swell = ctx.createGain(); swell.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.15;
    lfo.connect(lfoAmt).connect(swell.gain); lfo.start();
    loop(ctx, noiseBuffer(ctx, 5, "pink")).connect(bp).connect(swell).connect(g);
    ch.cabin = g;
  }
  return { ctx, out, ch };
}

export function levels() {
  return { engine: 0.7, rain: 0, cabin: 0.35, ...(settings.mix || {}) };
}

export function setLevel(id, v) {
  const mix = { ...levels(), [id]: v };
  updateSettings({ mix });
  if (nodes) nodes.ch[id].gain.setTargetAtTime(v * v, nodes.ctx.currentTime, 0.08);
}

export function startAmbience() {
  if (!nodes) nodes = build();
  if (!nodes) return false;
  const l = levels();
  const t = nodes.ctx.currentTime;
  for (const c of CHANNELS) nodes.ch[c.id].gain.setTargetAtTime(l[c.id] ** 2, t, 0.05);
  nodes.out.gain.cancelScheduledValues(t);
  nodes.out.gain.setTargetAtTime(0.9, t, 1.2);       // slow fade in
  running = true;
  return true;
}

export function stopAmbience(fade = 1.5) {
  if (!nodes) return;
  const t = nodes.ctx.currentTime;
  nodes.out.gain.cancelScheduledValues(t);
  nodes.out.gain.setTargetAtTime(0, t, fade / 3);
  running = false;
}

export const ambienceOn = () => running;
