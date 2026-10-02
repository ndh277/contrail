// In flight: take-off, the globe / window views, seat-class rules, ambience,
// the shade, hold-to-abort, and the hand-off to landing.
import { sfx } from "../audio.js";
import { haptic } from "../haptics.js";
import { reducedMotion } from "../spring.js";
import { interpolateGC, localSolarHours } from "../geo.js";
import { now, WARP } from "../clock.js";
import { airports } from "../airports.js";
import {
  setActive, clearActive, progressOf, flownMs, toRecord, saveFlight, visitedSet, nearestAirport, DIVERT_AFTER_MS,
} from "../flights.js";
import { CHANNELS, levels, setLevel, startAmbience, stopAmbience, ambienceOn } from "../ambience.js";
import { WindowView } from "./window-view.js";
import { toast } from "./common.js";

const CLIMB_SECONDS = 9;
const TAKEOFF_MOVE_MS = 6500;
const ABORT_HOLD_MS = 3000;

const pad = (n) => String(n).padStart(2, "0");
const clockText = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};

export class Flight {
  constructor({ view, root, onLanded }) {
    this.view = view;
    this.root = root;
    this.onLanded = onLanded;
    this.$ = (s) => root.querySelector(s);
    this.app = document.getElementById("app");
    this.windowView = new WindowView(document.getElementById("window-view"));
    this.shade = document.getElementById("shade");
    this.mode = "globe";

    this.$("#view-toggle").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (b) this.setMode(b.dataset.mode);
    });
    this.$("#btn-pause").addEventListener("click", () => this.togglePause());
    this.$("#btn-mixer").addEventListener("click", () => this.toggleMixer());
    this.$("#btn-shade").addEventListener("click", () => this.closeShade());
    this.shade.addEventListener("click", () => this.shadeTap());
    document.getElementById("shade-raise").addEventListener("click", (e) => { e.stopPropagation(); this.openShade(); });
    document.getElementById("paused-resume").addEventListener("click", () => this.togglePause());
    this.setupAbort();
    this.setupMixer();

    document.addEventListener("visibilitychange", () => this.visibility());
    addEventListener("pagehide", () => this.persist(true));
    view.onFrame((t, dt) => this.frame(t, dt));
  }

  get active() { return !!this.f; }

  /* ================= start / resume ================= */

  async start(f, { resume = false } = {}) {
    this.f = f;
    this.ended = false;
    this.landing = false;
    if (!resume) {
      f.startedAt = now();
      f.pausedMs = 0;
      f.pausedAt = null;
      f.id = `${f.startedAt.toString(36)}-${f.flightNo.replace(/\s/g, "")}`;
    }
    f.lastSeenAt = now();
    f.hiddenAt = null;
    await setActive(f);

    this.cruiseFt = Math.round(Math.min(39000, 14000 + f.distKm * 28) / 1000) * 1000;
    this.followFrom = performance.now() + (resume || reducedMotion() ? 0 : TAKEOFF_MOVE_MS);
    this.app.dataset.cls = f.cls;
    this.$("#btn-pause").hidden = f.cls !== "economy";

    const v = this.view;
    v.showRadar(false);
    v.setLabels([]);
    v.setRoute(f.origin, f.dest, { dashed: false });
    v.updatePlane(progressOf(f), resume ? 1 : 0);

    const o = f.origin, d = f.dest;
    this.$("#hud-from").textContent = o.iata;
    this.$("#hud-to").textContent = d.iata;
    this.$("#hud-from-city").textContent = o.city;
    this.$("#hud-to-city").textContent = d.city;
    this.$("#hud-track-from").textContent = o.iata;
    this.$("#hud-track-to").textContent = d.iata;
    this.$("#hud-sub").textContent = `${f.flightNo} · ${f.seat} · ${f.tag.name}`;
    this.$("#hud-tag").style.setProperty("--tag", f.tag.color);
    this.$("#hud-class").textContent = { first: "First", business: "Business", economy: "Economy" }[f.cls];
    this.renderPaused();

    if (resume) {
      const here = this.position();
      v.pointOfView({ lat: here.lat, lng: here.lng, altitude: 1.2 }, 0);
    } else {
      const mid = interpolateGC(o.lat, o.lng, d.lat, d.lng, 0.5);
      const wide = { lat: mid.lat, lng: mid.lng, altitude: v.fitAltitude((f.distKm / 6371) * 0.6 + 0.08) };
      if (reducedMotion()) v.pointOfView(wide, 0);
      else {
        v.pointOfView({ lat: o.lat - 0.8, lng: o.lng, altitude: 0.22 }, 900);
        setTimeout(() => { if (this.f === f) v.pointOfView(wide, 4200); }, 1700);
      }
      sfx.takeoff(CLIMB_SECONDS);
    }

    if (f.cls === "first") {
      this.requestWakeLock();
      if (!resume) document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
      startAmbience();
    }
    this.syncMixer();
    clearInterval(this.beat);
    this.beat = setInterval(() => this.persist(), 4000);
  }

  /** Called at boot when a flight was in progress. */
  async resume(f) {
    const t = now();
    const gap = t - (f.lastSeenAt || t);
    if (f.cls !== "economy" && !f.pausedAt && gap > DIVERT_AFTER_MS && progressOf(f, f.lastSeenAt) < 1) {
      // the app was closed mid-flight: divert at the moment the 10 s ran out
      this.f = f;
      await this.finish("diverted", f.lastSeenAt + DIVERT_AFTER_MS);
      return;
    }
    await this.start(f, { resume: true });
  }

  position(p = progressOf(this.f)) {
    const f = this.f;
    return interpolateGC(f.origin.lat, f.origin.lng, f.dest.lat, f.dest.lng, p);
  }

  persist(force = false) {
    if (!this.f || this.ended) return;
    if (document.visibilityState === "visible" || force) this.f.lastSeenAt = now();
    setActive(this.f);
  }

  /* ================= per frame ================= */

  frame(t, dt) {
    const f = this.f;
    if (!f || this.ended || this.app.dataset.screen !== "flight") return;
    const tNow = now();
    const p = progressOf(f, tNow);
    const elapsed = (tNow - f.startedAt) / 1000;
    const climb = reducedMotion() ? 1 : Math.min(1, elapsed / CLIMB_SECONDS);
    const ease = 1 - Math.pow(1 - climb, 3);
    const v = this.view;
    v.updatePlane(p, ease);
    const here = this.position(p);

    if (this.mode === "globe" && t > this.followFrom && t - v.lastUserInput > 8000 && !this.landing) {
      const leftKm = f.distKm * (1 - p);
      const angle = Math.min(0.9, Math.max(0.12, (leftKm / 6371) * 0.7 + 0.06));
      v.glideTo({ lat: here.lat, lng: here.lng, altitude: v.fitAltitude(angle) }, 0.8);
    }
    if (this.mode === "window") this.windowView.frame(dt, here.lat, here.lng, tNow);

    if (p >= 1 && !this.landing) { this.land(); return; }

    if (this.lastHud && t - this.lastHud < 200) return;
    this.lastHud = t;
    const remaining = f.durationMin * 60000 - flownMs(f, tNow);
    const text = clockText(remaining);
    this.$("#hud-clock").textContent = text;
    document.getElementById("shade-clock").textContent = text;
    this.$("#hud-progress").style.transform = `scaleX(${p})`;
    this.$("#hud-craft").style.left = `${p * 100}%`;

    // displayed altitude: brisk initial climb, gentle final descent
    const easeOut = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 2;
    const profile = Math.min(easeOut(p / 0.12), easeOut((1 - p) / 0.12));
    const alt = f.pausedAt ? this.lastAlt ?? 0 : Math.round((this.cruiseFt * profile) / 100) * 100;
    this.lastAlt = alt;
    const speed = f.pausedAt ? 0 : Math.round(f.speedKmh * Math.min(1, 0.32 + climb * 0.68));
    this.$("#hud-alt").textContent = `${alt.toLocaleString("en-US")} ft`;
    this.$("#hud-speed").textContent = `${speed.toLocaleString("en-US")} km/h`;
    this.$("#hud-left").textContent = `${Math.round(f.distKm * (1 - p)).toLocaleString("en-US")} km`;
    const sun = localSolarHours(here.lng, new Date(tNow));
    this.$("#hud-sun").textContent = `${pad(Math.floor(sun))}:${pad(Math.floor((sun % 1) * 60))}`;
    const eta = new Date(Date.now() + remaining / WARP);
    this.$("#hud-eta").textContent = eta.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const phase = f.pausedAt ? "Holding" : this.phase(p, elapsed);
    const ph = this.$("#hud-phase");
    if (ph.textContent !== phase) ph.textContent = phase;
  }

  phase(p, elapsed) {
    if (p >= 1) return "Arrived";
    if (elapsed < CLIMB_SECONDS) return "Taking off";
    const remainingMin = this.f.durationMin * (1 - p);
    if (p < 0.12 && elapsed < 20 * 60) return "Climbing";
    if (p > 0.88 || remainingMin < 3) return "Descending";
    return "Cruising";
  }

  /* ================= views ================= */

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    sfx.tap();
    this.app.dataset.view = mode;
    this.$("#view-toggle").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
    this.windowView.show(mode === "window");
    this.syncRendering();
    if (mode === "window" && typeof globalThis.DeviceOrientationEvent?.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().catch(() => {});
    }
  }

  /* ================= seat-class rules ================= */

  togglePause() {
    const f = this.f;
    if (!f || f.cls !== "economy" || this.ended) return;
    const t = now();
    if (f.pausedAt) { f.pausedMs += t - f.pausedAt; f.pausedAt = null; if (this.ambienceWasOn) startAmbience(); }
    else { f.pausedAt = t; this.ambienceWasOn = ambienceOn(); stopAmbience(0.6); }
    sfx.tap(); haptic("tap");
    this.renderPaused();
    this.persist();
  }

  renderPaused() {
    const paused = !!this.f?.pausedAt;
    this.app.classList.toggle("is-paused", paused);
    this.$("#btn-pause").setAttribute("aria-pressed", paused);
    this.$("#btn-pause .lbl").textContent = paused ? "Resume" : "Pause";
  }

  visibility() {
    const f = this.f;
    if (!f || this.ended) return;
    if (document.visibilityState === "hidden") {
      f.hiddenAt = now();
      f.lastSeenAt = f.hiddenAt;
      setActive(f);
      return;
    }
    const away = f.hiddenAt ? now() - f.hiddenAt : 0;
    f.hiddenAt = null;
    if (f.cls !== "economy" && !f.pausedAt && away > DIVERT_AFTER_MS && progressOf(f) < 1) {
      this.finish("diverted", now() - away + DIVERT_AFTER_MS);
      return;
    }
    if (f.cls !== "economy" && away > 2000) toast("Welcome back. More than 10 s away diverts the flight.", 4200);
    if (f.cls === "first") this.requestWakeLock();
    this.persist();
  }

  async requestWakeLock() {
    try {
      if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
      this.wakeLock?.release?.();
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch { /* not granted — fine */ }
  }

  /* ================= ambience mixer ================= */

  setupMixer() {
    const panel = document.getElementById("mixer");
    panel.querySelector(".mixer-track").innerHTML = CHANNELS.map((c) => `
      <div class="mix-card" data-ch="${c.id}">
        <div class="mix-head"><b>${c.name}</b><small>${c.hint}</small></div>
        <div class="fader" data-ch="${c.id}" role="slider" tabindex="0" aria-label="${c.name} level" aria-valuemin="0" aria-valuemax="100">
          <div class="fader-fill"></div><div class="fader-knob"></div>
        </div>
        <span class="mix-val"></span>
      </div>`).join("");
    panel.querySelector("#mix-power").addEventListener("click", () => {
      if (ambienceOn()) stopAmbience(); else startAmbience();
      sfx.tap();
      this.syncMixer();
    });
    panel.querySelector("#mix-close").addEventListener("click", () => this.toggleMixer(false));
    panel.querySelectorAll(".fader").forEach((el) => {
      const set = (e) => {
        const r = el.getBoundingClientRect();
        const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        setLevel(el.dataset.ch, Math.round(v * 20) / 20);
        if (!ambienceOn()) startAmbience();
        this.syncMixer();
      };
      el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); el.dataset.drag = "1"; set(e); });
      el.addEventListener("pointermove", (e) => { if (el.dataset.drag) set(e); });
      el.addEventListener("pointerup", () => { delete el.dataset.drag; haptic("tap"); });
      el.addEventListener("pointercancel", () => { delete el.dataset.drag; });
      el.addEventListener("keydown", (e) => {
        const d = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05 }[e.key];
        if (!d) return;
        e.preventDefault();
        setLevel(el.dataset.ch, Math.max(0, Math.min(1, levels()[el.dataset.ch] + d)));
        this.syncMixer();
      });
    });
  }

  syncMixer() {
    const l = levels();
    const panel = document.getElementById("mixer");
    panel.querySelectorAll(".mix-card").forEach((card) => {
      const v = l[card.dataset.ch];
      card.style.setProperty("--lvl", v);
      card.querySelector(".mix-val").textContent = `${Math.round(v * 100)}`;
      card.querySelector(".fader").setAttribute("aria-valuenow", Math.round(v * 100));
    });
    const on = ambienceOn();
    panel.classList.toggle("is-on", on);
    panel.querySelector("#mix-power").textContent = on ? "Ambience on" : "Ambience off";
    panel.querySelector("#mix-power").setAttribute("aria-pressed", on);
    this.$("#btn-mixer").setAttribute("aria-pressed", on);
  }

  toggleMixer(force) {
    const panel = document.getElementById("mixer");
    const open = force ?? !panel.classList.contains("is-open");
    panel.classList.toggle("is-open", open);
    if (open) sfx.tap();
    this.syncMixer();
  }

  /** The globe stops rendering while it can't be seen (window view, shade) — saves battery. */
  syncRendering() {
    const hidden = this.mode === "window" || this.app.classList.contains("shade-down");
    if (hidden === this.globePaused) return;
    this.globePaused = hidden;
    if (hidden) this.view.globe.pauseAnimation(); else this.view.globe.resumeAnimation();
  }

  /* ================= shade (pure mode) ================= */

  closeShade() {
    sfx.shade(true);
    this.toggleMixer(false);
    this.shade.classList.add("is-down");
    this.app.classList.add("shade-down");
    setTimeout(() => this.syncRendering(), 1200);
  }

  shadeTap() {
    this.shade.classList.add("show-raise");
    clearTimeout(this.raiseTimer);
    this.raiseTimer = setTimeout(() => this.shade.classList.remove("show-raise"), 3000);
  }

  openShade() {
    if (this.shade.classList.contains("is-down")) sfx.shade(false);
    this.shade.classList.remove("is-down", "show-raise");
    this.app.classList.remove("shade-down");
    this.syncRendering();
  }

  /* ================= hold to abort ================= */

  setupAbort() {
    const btn = this.$("#btn-abort");
    const ring = btn.querySelector(".abort-ring .fill");
    const C = 2 * Math.PI * 20;
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C;
    let t0 = 0, raf = 0, ticks = 0, aborted = false;
    const hint = () => this.$("#abort-hint");
    const cancel = () => {
      if (!t0) return;
      t0 = 0; cancelAnimationFrame(raf);
      btn.classList.remove("is-holding");
      ring.style.transition = "stroke-dashoffset 400ms cubic-bezier(.22,1,.36,1)";
      ring.style.strokeDashoffset = C;
      hint().textContent = "Abort";
      if (!aborted) toast("Hold for 3 seconds to abort the flight.", 2200);
    };
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ABORT_HOLD_MS);
      ring.style.strokeDashoffset = C * (1 - k);
      const tick = Math.floor(k * 3);
      if (tick > ticks && k < 1) { ticks = tick; sfx.holdTick(tick); haptic("tap"); hint().textContent = `${3 - tick}…`; }
      if (k >= 1) {
        t0 = 0;
        aborted = true;
        btn.classList.remove("is-holding");
        haptic("abortComplete");
        ring.style.strokeDashoffset = C;
        hint().textContent = "Abort";
        this.finish("aborted");
        return;
      }
      raf = requestAnimationFrame(step);
    };
    btn.addEventListener("pointerdown", (e) => {
      if (this.ended) return;
      btn.setPointerCapture(e.pointerId);
      t0 = performance.now(); ticks = 0; aborted = false;
      ring.style.transition = "none";
      btn.classList.add("is-holding");
      hint().textContent = "3…";
      sfx.holdTick(0);
      raf = requestAnimationFrame(step);
    });
    btn.addEventListener("pointerup", cancel);
    btn.addEventListener("pointercancel", cancel);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /* ================= endings ================= */

  land() {
    this.landing = true;
    const d = this.f.dest;
    this.setMode("globe");
    this.view.glideTo({ lat: d.lat, lng: d.lng, altitude: 0.35 }, 1.2);
    setTimeout(() => this.finish("landed"), reducedMotion() ? 0 : 1600);
  }

  async finish(status, at = now()) {
    if (this.ended) return;
    this.ended = true;
    const f = this.f;
    clearInterval(this.beat);
    stopAmbience(1.2);
    this.wakeLock?.release?.().catch?.(() => {});
    this.wakeLock = null;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (status === "landed") f.firstVisit = !(await visitedSet()).has(f.dest.iata);
    if (status === "diverted") {
      const pos = this.position(progressOf(f, at));
      const alt = nearestAirport(airports, pos.lat, pos.lng, [f.dest.iata]);
      f.divertedTo = alt ? { iata: alt.iata, city: alt.city } : null;
    }
    const rec = toRecord(f, status, at);
    await saveFlight(rec);
    await clearActive();
    this.openShade();
    this.toggleMixer(false);
    this.setMode("globe");
    this.app.classList.remove("is-paused");
    this.onLanded(rec, f);
  }

  /** Clear the globe after the landing card closes. */
  reset() {
    this.f = null;
    this.ended = false;
    this.landing = false;
    this.lastAlt = 0;
    delete this.app.dataset.cls;
    this.view.removePlane();
    this.view.clearRoute();
    this.view.showRadar(true);
  }
}
