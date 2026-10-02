// Boarding pass: prints out of a slot, then Henry tears the stub off to depart.
// No start button — the tear is the start.
import { settings } from "../settings.js";
import { haptic } from "../haptics.js";
import { sfx } from "../audio.js";
import { Spring, reducedMotion } from "../spring.js";
import { esc, hash, rng } from "./common.js";
import { CLASSES } from "./checkin.js";
import { formatDuration } from "../geo.js";

const TEAR_AT = 118;          // px of pull before the paper gives way

const time = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = (d) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }).toUpperCase();

const EMBLEM = `<svg class="pass-emblem" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19 C 8 13, 12 9, 18.5 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".55"/><path d="M22 4.5 L15.5 4.8 L17.4 7.2 L16.4 10.2Z" fill="currentColor"/></svg>`;

/** Security-print style wave lines — unique per pass. */
function guilloche(seed) {
  const r = rng(seed);
  const paths = [];
  for (let k = 0; k < 7; k++) {
    const amp = 6 + r() * 10, freq = 0.02 + r() * 0.025, ph = r() * 6.28, y0 = 30 + k * 26;
    let d = "";
    for (let x = 0; x <= 360; x += 6) {
      const y = y0 + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 2.7 + ph * 1.3) * amp * 0.35;
      d += `${x ? "L" : "M"}${x} ${y.toFixed(1)}`;
    }
    paths.push(`<path d="${d}"/>`);
  }
  return `<svg class="guilloche" viewBox="0 0 360 220" preserveAspectRatio="none" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="0.7">${paths.join("")}</g></svg>`;
}

export function flightNumber(origin, dest) {
  return `CT ${100 + (hash(origin + dest) % 900)}`;
}

function barcode(seed, bars = 46) {
  const r = rng(hash(seed));
  let x = 0, out = "";
  for (let i = 0; i < bars; i++) {
    const w = r() < 0.3 ? 3 : r() < 0.6 ? 2 : 1;
    out += `<rect x="${x}" y="0" width="${w}" height="100%"/>`;
    x += w + (r() < 0.5 ? 1 : 2);
  }
  return `<svg class="barcode" viewBox="0 0 ${x} 30" preserveAspectRatio="none" aria-hidden="true"><g fill="currentColor">${out}</g></svg>`;
}

export class BoardingPass {
  constructor({ root, onTorn, onBack }) {
    this.root = root;
    this.onTorn = onTorn;
    this.$ = (s) => root.querySelector(s);
    this.$("#pass-back").addEventListener("click", onBack);
    this.etaTimer = 0;
  }

  open(flight) {
    this.flight = flight;
    this.flight.flightNo = flightNumber(flight.origin.iata, flight.dest.iata);
    this.torn = false;
    this.render();
    this.print();
    clearInterval(this.etaTimer);
    this.etaTimer = setInterval(() => this.updateTimes(), 15000);
  }

  close() { clearInterval(this.etaTimer); }

  render() {
    const f = this.flight;
    const cls = CLASSES[f.cls].name;
    const h = hash(f.flightNo + f.seat);
    f.gate = `${"ABCDE"[h % 5]}${1 + ((h >>> 3) % 28)}`;
    f.group = f.cls === "first" ? "1" : f.cls === "business" ? "2" : String(3 + ((h >>> 7) % 3));
    this.$("#pass-paper").innerHTML = `
      <div class="pass" style="--tag:${esc(f.tag.color)}">
        <div class="pass-main">
          ${guilloche(h)}
          <div class="pass-head">
            <span class="pass-brand">${EMBLEM}<span class="pass-airline">CONTRAIL</span></span>
            <span class="pass-kind">Boarding pass</span>
          </div>
          <div class="pass-route">
            <div class="pass-port"><span class="pass-code">${f.origin.iata}</span><span class="pass-city">${esc(f.origin.city)}</span></div>
            <div class="pass-arc" aria-hidden="true">
              <svg viewBox="0 0 100 34"><path d="M4 30 Q50 -6 96 30" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.5 3"/><circle cx="4" cy="30" r="2.2" fill="currentColor"/><circle cx="96" cy="30" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/><g transform="translate(50 12) rotate(0)"><path d="M7 0 L-4 -4.5 L-2 0 L-4 4.5Z" fill="currentColor"/></g></svg>
              <span>${formatDuration(f.durationMin)}</span>
              <small>${Math.round(f.distKm).toLocaleString("en-US")} km</small>
            </div>
            <div class="pass-port is-dest"><span class="pass-code">${f.dest.iata}</span><span class="pass-city">${esc(f.dest.city)}</span></div>
          </div>
          <dl class="pass-grid">
            <div class="span2"><dt>Passenger</dt><dd>HENRY NGUYEN</dd></div>
            <div><dt>Flight</dt><dd>${f.flightNo}</dd></div>
            <div><dt>Date</dt><dd data-f="date">${day(new Date())}</dd></div>
            <div><dt>Gate</dt><dd class="big">${f.gate}</dd></div>
            <div><dt>Group</dt><dd class="big">${f.group}</dd></div>
            <div><dt>Departs</dt><dd data-f="dep">${time(new Date())}</dd></div>
            <div><dt>Arrives</dt><dd data-f="eta"></dd></div>
            <div><dt>Seat</dt><dd class="big">${f.seat}</dd></div>
            <div><dt>Class</dt><dd>${cls.toUpperCase()}</dd></div>
            <div><dt>Purpose</dt><dd><span class="pass-tag">${esc(f.tag.name)}</span></dd></div>
            <div><dt>Scale</dt><dd>${f.scale}×</dd></div>
          </dl>
        </div>
        <div class="perforation" aria-hidden="true"><span class="rip"></span></div>
        <div class="pass-stub" id="pass-stub" role="button" tabindex="0" aria-label="Tear off the stub to depart">
          <div class="stub-row">
            <div class="stub-text">
              <span class="stub-codes">${f.origin.iata}<i>→</i>${f.dest.iata}</span>
              <span class="stub-meta">${f.flightNo} · GATE ${f.gate} · SEAT ${f.seat}</span>
            </div>
            ${barcode(f.flightNo + f.seat)}
          </div>
          <span class="stub-pull" aria-hidden="true">Pull to depart</span>
        </div>
      </div>`;
    this.updateTimes();
    this.bindTear();
  }

  updateTimes() {
    if (this.torn || !this.flight) return;
    const now = new Date();
    const eta = new Date(now.getTime() + this.flight.durationMin * 60000);
    const set = (k, v) => { const el = this.root.querySelector(`[data-f="${k}"]`); if (el) el.textContent = v; };
    set("dep", time(now));
    set("eta", time(eta));
    set("date", day(now));
  }

  /* ---------- print-out ---------- */

  print() {
    const paper = this.$("#pass-paper");
    const hint = this.$("#tear-hint");
    hint.classList.remove("is-on");
    paper.classList.remove("is-printed");
    if (reducedMotion()) { paper.classList.add("is-printed"); hint.classList.add("is-on"); return; }
    const steps = 12, dur = 1250;
    sfx.printer(dur / 1000, steps);
    paper.style.setProperty("--feed", "0");
    let i = 0;
    const feed = () => {
      i++;
      // stepped feed with a little settle per step — like a thermal printer
      paper.style.setProperty("--feed", String(i / steps));
      if (i < steps) setTimeout(feed, dur / steps);
      else {
        paper.classList.add("is-printed");
        // the freshly printed paper sways a little before it settles
        const sway = new Spring({ stiffness: 90, damping: 5, onUpdate: (v) => paper.style.setProperty("--sway", `${v}deg`) });
        sway.impulse(14);
        setTimeout(() => hint.classList.add("is-on"), 350);
      }
    };
    setTimeout(feed, 120);
  }

  /* ---------- tear-to-start ---------- */

  bindTear() {
    const stub = this.$("#pass-stub");
    const rip = this.root.querySelector(".perforation .rip");
    const pass = this.root.querySelector(".pass");
    let start = null, pull = 0, separated = false, samples = [], strainStep = 0;

    const spring = new Spring({
      stiffness: 260, damping: 15,
      onUpdate: (v) => apply(v, false),
    });

    const apply = (p, free, dx = 0) => {
      // before the tear: heavy resistance, the stub hinges from its right edge
      const shown = free ? p : rubber(p);
      const rot = free ? dx * 0.04 + p * 0.03 : -Math.min(shown, 60) * 0.11;
      stub.style.transform = `translate(${free ? dx : 0}px, ${shown}px) rotate(${rot}deg)`;
      const progress = free ? 1 : Math.min(1, Math.max(0, p / TEAR_AT));
      rip.style.transform = `scaleX(${progress})`;
      pass.style.setProperty("--strain", progress.toFixed(3));
    };
    const rubber = (p) => {
      if (p <= 0) return p * 0.2;
      return 34 * (1 - Math.exp(-p / 70)) + p * 0.05;
    };

    const down = (e) => {
      if (this.torn || !this.root.querySelector("#pass-paper").classList.contains("is-printed")) return;
      stub.setPointerCapture(e.pointerId);
      spring.set(pull);
      start = { x: e.clientX, y: e.clientY };
      samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      strainStep = 0;
      stub.classList.add("is-held");
      this.$("#tear-hint").classList.remove("is-on");
    };
    const move = (e) => {
      if (!start) return;
      const dy = e.clientY - start.y, dx = e.clientX - start.x;
      samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (samples.length > 6) samples.shift();
      if (!separated) {
        // pulling down or sideways both count, down is the natural direction
        pull = Math.max(dy, Math.abs(dx) * 0.6, -20);
        apply(pull, false);
        const step = Math.floor((pull / TEAR_AT) * 6);
        if (step > strainStep && pull > 0) { strainStep = step; sfx.strain(); haptic("tearTension"); }
        if (pull >= TEAR_AT) {
          separated = true;
          this.torn = true;
          sfx.tear();
          haptic("stubTear");
          pass.classList.add("is-torn");
          stub.classList.add("is-free");
          start = { x: e.clientX, y: e.clientY - rubber(TEAR_AT) };
        }
      } else {
        apply(e.clientY - start.y, true, e.clientX - start.x);
      }
    };
    const up = () => {
      if (!start) return;
      stub.classList.remove("is-held");
      start = null;
      if (!separated) {
        spring.set(pull);
        pull = 0;
        spring.to(0);
        setTimeout(() => { if (!this.torn) this.$("#tear-hint").classList.add("is-on"); }, 600);
        return;
      }
      const a = samples[0], b = samples[samples.length - 1];
      const dt = Math.max(0.016, (b.t - a.t) / 1000);
      let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
      if (vy < 900) vy = 900 + Math.max(0, vy) * 0.5;
      this.flyAway(stub, vx, vy);
    };

    stub.addEventListener("pointerdown", down);
    stub.addEventListener("pointermove", move);
    stub.addEventListener("pointerup", up);
    stub.addEventListener("pointercancel", up);
    stub.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !this.torn && this.$("#pass-paper").classList.contains("is-printed")) {
        e.preventDefault();
        this.torn = true;
        sfx.tear(); haptic("stubTear");
        pass.classList.add("is-torn");
        stub.classList.add("is-free");
        this.flyAway(stub, 0, 1400);
      }
    });
  }

  flyAway(stub, vx, vy) {
    const m = new DOMMatrixReadOnly(getComputedStyle(stub).transform);
    let x = m.m41, y = m.m42, rot = Math.atan2(m.m12, m.m11) * 180 / Math.PI;
    const spin = (vx / 30) + (Math.random() - 0.5) * 120;
    let last = performance.now();
    const t0 = last;
    const step = (t) => {
      const dt = Math.min(0.04, (t - last) / 1000); last = t;
      vy += 2200 * dt;
      x += vx * dt; y += vy * dt; rot += spin * dt;
      stub.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
      stub.style.opacity = String(Math.max(0, 1 - (t - t0) / 700));
      if (t - t0 < 700) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    this.close();
    setTimeout(() => this.onTorn(this.flight), reducedMotion() ? 50 : 380);
  }
}
