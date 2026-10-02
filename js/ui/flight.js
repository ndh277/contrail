// In flight: take-off, the globe / window views, seat-class rules, ambience,
// the shade, hold-to-abort, and the hand-off to landing.
import { sfx } from "../audio.js";
import { haptic } from "../haptics.js";
import { reducedMotion } from "../spring.js";
import { interpolateGC, localSolarHours, initialBearing, haversineKm } from "../geo.js";
import { now, WARP } from "../clock.js";
import { airports } from "../airports.js";
import {
  setActive, clearActive, progressOf, flownMs, toRecord, saveFlight, visitedSet, nearestAirport, DIVERT_AFTER_MS,
} from "../flights.js";
import { CHANNELS, levels, setLevel, startAmbience, stopAmbience, ambienceOn } from "../ambience.js";
import { WindowView } from "./window-view.js";
import { toast } from "./common.js";
import { Companion } from "./companion.js";

const HHMM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const NUM = new Intl.NumberFormat("en-US");

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
    this.windowView = new WindowView(document.getElementById("window-view"), { onShadeClosed: () => this.closeShade(true) });
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
    this.companion = new Companion();
    const mini = this.$("#btn-mini");
    mini.hidden = !(this.companion.pipSupported && matchMedia("(pointer: fine)").matches);
    mini.addEventListener("click", () => { sfx.tap(); this.companion.win ? this.companion.closeMini() : this.companion.openMini(); });

    document.addEventListener("visibilitychange", () => this.visibility());
    // immersive: the HUD slides away after a few quiet seconds; any touch brings it back
    this.lastActivity = performance.now();
    const wake = () => { this.lastActivity = performance.now(); if (this.idle) this.setIdle(false); };
    for (const ev of ["pointerdown", "keydown", "wheel"]) addEventListener(ev, wake, { passive: true, capture: true });
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
    v.setRoute(f.origin, f.dest);
    v.setEndpoints(f.origin, f.dest);
    this.labelEls = null;
    v.updatePlane(progressOf(f), resume ? 1 : 0);

    const o = f.origin, d = f.dest;
    this.$("#hud-from").textContent = o.iata;
    this.$("#hud-to").textContent = d.iata;
    this.$("#hud-from-city").textContent = o.city;
    this.$("#hud-to-city").textContent = d.city;
    this.$("#hud-track-from").textContent = o.iata;
    this.$("#hud-track-to").textContent = d.iata;
    this.$("#hud-sub").textContent = `${f.flightNo} · ${f.seat} · ${f.tag.name}`;
    this.$("#hud-mini-dest").textContent = `→ ${d.iata}`;
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
      // on a laptop the flight tucks itself into a small always-on-top window
      if (this.companion.isDesktop) this.companion.openMini();
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
    v.setRouteProgress(p);
    const here = this.position(p);

    if (this.mode === "globe" && v.viewMode === "globe" && t > this.followFrom && t - v.lastUserInput > 8000 && !this.landing) {
      const leftKm = f.distKm * (1 - p);
      const angle = Math.min(0.9, Math.max(0.12, (leftKm / 6371) * 0.7 + 0.06));
      v.glideTo({ lat: here.lat, lng: here.lng, altitude: v.fitAltitude(angle) }, 0.8);
    }
    if (this.mode === "window") {
      const ahead = this.position(Math.min(1, p + 0.001));
      const heading = initialBearing(here.lat, here.lng, ahead.lat, ahead.lng);
      this.windowView.frame(dt, here.lat, here.lng, tNow, heading);
      if (!this.lastCaption || t - this.lastCaption > 5000) { this.lastCaption = t; this.caption(here, tNow); }
    }

    if (p >= 1 && !this.landing) { this.land(); return; }

    if (!this.lastLabels || t - this.lastLabels > 500) { this.lastLabels = t; this.mapLabels(here, p); }

    const quiet = t - this.lastActivity > 6000 && !document.getElementById("mixer").classList.contains("is-open") && !this.landing && !this.app.classList.contains("is-paused");
    if (quiet !== !!this.idle) this.setIdle(quiet);

    if (this.lastHud && t - this.lastHud < 200) return;
    this.lastHud = t;
    const remaining = f.durationMin * 60000 - flownMs(f, tNow);
    const text = clockText(remaining);
    // write to the DOM only when a value really changes (each write re-composites the glass)
    const put = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
    put(this.$("#hud-clock"), text);
    put(this.$("#hud-mini-clock"), text);
    put(document.getElementById("shade-clock"), text);
    const pp = p.toFixed(4);
    if (pp !== this.lastP) {
      this.lastP = pp;
      this.$("#hud-progress").style.transform = `scaleX(${pp})`;
      this.$("#hud-craft").style.left = `${(p * 100).toFixed(2)}%`;
    }

    // displayed altitude: brisk initial climb, gentle final descent
    const easeOut = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 2;
    const profile = Math.min(easeOut(p / 0.12), easeOut((1 - p) / 0.12));
    const alt = f.pausedAt ? this.lastAlt ?? 0 : Math.round((this.cruiseFt * profile) / 100) * 100;
    this.lastAlt = alt;
    const speed = f.pausedAt ? 0 : Math.round(f.speedKmh * Math.min(1, 0.32 + climb * 0.68));
    put(this.$("#hud-alt"), NUM.format(alt));
    put(this.$("#hud-speed"), NUM.format(speed));
    put(this.$("#hud-left"), NUM.format(Math.round(f.distKm * (1 - p))));
    const sun = localSolarHours(here.lng, new Date(tNow));
    put(this.$("#hud-sun"), `${pad(Math.floor(sun))}:${pad(Math.floor((sun % 1) * 60))}`);
    const eta = new Date(Date.now() + remaining / WARP);
    put(this.$("#hud-eta"), HHMM.format(eta));
    const phase = f.pausedAt ? "Holding" : this.phase(p, elapsed);
    const ph = this.$("#hud-phase");
    if (ph.textContent !== phase) ph.textContent = phase;
    if (!this.lastCompanion || t - this.lastCompanion > 1000) {
      this.lastCompanion = t;
      this.companion.update({
        clock: text, progress: p, from: f.origin.iata, to: f.dest.iata, phase, flightNo: f.flightNo,
        tag: f.tag?.name, tagColor: f.tag?.color, kmLeft: Math.max(0, Math.round(f.distKm * (1 - p))),
        eta: HHMM.format(eta), minutesLeft: Math.ceil(remaining / 60000),
      });
    }
  }

  /** Origin, destination and the flight itself, labelled on the map. */
  mapLabels(here, p) {
    const f = this.f, v = this.view;
    if (!this.labelEls) {
      const mk = (cls) => { const el = document.createElement("div"); el.className = `globe-label map-tag ${cls}`; return el; };
      this.labelEls = { from: mk("is-from"), to: mk("is-to"), plane: mk("is-plane") };
    }
    const hm = (ms) => HHMM.format(new Date(ms));
    const remaining = f.durationMin * 60000 - flownMs(f);
    const { from, to, plane } = this.labelEls;
    const set = (el, html) => { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };
    set(from, `<div class="tag-card"><b>${f.origin.iata}</b><span>${f.origin.city} · Dep ${hm(f.startedAt)}</span></div>`);
    set(to, `<div class="tag-card"><b>${f.dest.iata}</b><span>${f.dest.city} · ETA ${hm(Date.now() + remaining / WARP)}</span></div>`);
    const fl = Math.round((this.lastAlt || 0) / 100);
    set(plane, `<div class="tag-card"><b>${f.flightNo}</b><span>${fl ? `FL${String(fl).padStart(3, "0")}` : "Climbing"} · ${Math.round(f.speedKmh)} km/h</span></div>`);
    // the origin tag steps aside while the plane is still on top of it
    const items = [{ key: "to", lat: f.dest.lat, lng: f.dest.lng, el: to }];
    if (p > (this.mode === "globe" ? 0.12 : 0.3)) items.push({ key: "from", lat: f.origin.lat, lng: f.origin.lng, el: from });
    if (this.mode !== "window") {
      const alt = v.routeInfo ? v.routeAltitude(p, v.routeInfo.cruise) : 0;
      items.push({ key: "plane", lat: here.lat, lng: here.lng, alt: alt + 0.002, el: plane });
    }
    v.setLabels(items);
  }

  caption(here, tNow) {
    let best = null, bd = Infinity;
    for (const a of airports) {
      if (!a.large) continue;
      const d = haversineKm(here.lat, here.lng, a.lat, a.lng);
      if (d < bd) { bd = d; best = a; }
    }
    const sun = localSolarHours(here.lng, new Date(tNow));
    const near = best ? `${bd < 60 ? "Over" : "Near"} ${best.city}` : "Over open water";
    document.getElementById("window-caption").textContent = `${near} · Sun ${pad(Math.floor(sun))}:${pad(Math.floor((sun % 1) * 60))}`;
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

  /**
   * globe  — whole earth
   * chase  — 3D: a camera following the plane over satellite imagery
   * window — left window seat; the 3D globe renders the view through the pane,
   *          or (offline / no imagery) the drawn shader sky takes over
   */
  setMode(mode, { quiet = false } = {}) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (!quiet) sfx.tap();
    this.app.dataset.view = mode;
    this.$("#view-toggle").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
    const v = this.view;
    const globeEl = document.getElementById("globe");
    const pane = document.querySelector(".window-pane");
    // the window draws its own sky and drifting clouds (lighter and smoother than the globe)
    const live = false;
    this.windowLive = live;
    if (live) {
      pane.prepend(globeEl);                         // the real 3D view, framed by the window
      globeEl.classList.add("in-window");
    } else if (globeEl.parentElement !== document.querySelector(".globe-wrap")) {
      document.querySelector(".globe-wrap").prepend(globeEl);
      globeEl.classList.remove("in-window");
    }
    this.windowView.setExternal(live);
    this.windowView.show(mode === "window");
    v.setViewMode(mode === "window" ? (live ? "window" : "globe") : mode);
    v.resize();
    if (mode === "globe" && this.f) {
      const here = this.position();
      v.pointOfView({ lat: here.lat, lng: here.lng, altitude: 1.1 }, 900);
      this.followFrom = performance.now() + 1000;
    }
    this.syncRendering();
    this.layoutOffset();
    this.syncFps();
    if (mode === "chase") this.watchImagery(mode);
    if (mode === "window" && typeof globalThis.DeviceOrientationEvent?.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().catch(() => {});
    }
  }

  /** If no satellite tile arrives in a few seconds (offline), fall back gracefully. */
  watchImagery(mode) {
    clearTimeout(this.imageryTimer);
    const v = this.view;
    this.imageryTimer = setTimeout(() => {
      if (this.mode !== mode || v.satellite.successes > 0) return;
      v.satellite.failures = Math.max(v.satellite.failures, 7);
      if (mode === "window") {
        this.mode = null;
        this.setMode("window", { quiet: true });
      }
      toast("Satellite imagery isn't reachable right now — showing the drawn view.", 3600);
    }, 6000);
  }

  setIdle(on) {
    this.idle = on;
    this.app.classList.toggle("hud-idle", on);
    this.layoutOffset();
    this.syncFps();
  }

  /** 60 fps while the HUD is up; a steady 30 once it has stepped aside (the plane only creeps). */
  syncFps() { this.view.setFps(this.idle ? 30 : 60); }

  /** Keep the globe centred in the space the HUD leaves free. */
  layoutOffset() {
    const v = this.view;
    if ((this.mode === "window" && this.windowLive) || this.idle) { v.setCenterOffset(0, 0, null, 700); return; }
    const top = this.root.querySelector(".hud-top")?.getBoundingClientRect();
    const bottom = this.root.querySelector(".hud-bottom")?.getBoundingClientRect();
    if (!top || !bottom || !bottom.height) return;
    const landscape = innerWidth > innerHeight && innerWidth >= 820;
    if (landscape) v.setCenterOffset(-(bottom.width + 20) / 2, 0, null, 700);
    else v.setCenterOffset(0, (innerHeight - bottom.top - top.bottom) / 2 * 0.9, null, 700);
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
    const ICONS = {
      engine: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 10c-.5-2.6.6-4.6 2.8-5.6M14 12c2.6-.5 4.6.6 5.6 2.8M12 14c.5 2.6-.6 4.6-2.8 5.6M10 12c-2.6.5-4.6-.6-5.6-2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
      rain: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14.5a4 4 0 01.6-8 5.5 5.5 0 0110.4 1.8A3.3 3.3 0 0117.5 14.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.5 17.5l-1 2M12.5 17.5l-1 2M16.5 17.5l-1 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
      cabin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9c3-2 5.5 2 8.5 0s5.5-2 8.5 0M3.5 14c3-2 5.5 2 8.5 0s5.5-2 8.5 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
    };
    panel.querySelector(".mixer-track").innerHTML = CHANNELS.map((c) => `
      <div class="mix-ch" data-ch="${c.id}">
        <div class="vslider" data-ch="${c.id}" role="slider" tabindex="0" aria-label="${c.name} level" aria-valuemin="0" aria-valuemax="100" aria-orientation="vertical">
          <div class="vslider-fill"></div>
          <span class="vslider-icon">${ICONS[c.id]}</span>
          <span class="vslider-val"></span>
        </div>
        <b>${c.name}</b>
        <small>${c.hint}</small>
      </div>`).join("");
    panel.querySelector("#mix-power").addEventListener("click", () => {
      if (ambienceOn()) stopAmbience(); else startAmbience();
      sfx.tap();
      this.syncMixer();
    });
    panel.querySelector("#mix-close").addEventListener("click", () => this.toggleMixer(false));
    panel.querySelectorAll(".vslider").forEach((el) => {
      let start = null;
      el.addEventListener("pointerdown", (e) => {
        el.setPointerCapture(e.pointerId);
        start = { y: e.clientY, v: levels()[el.dataset.ch], h: el.clientHeight };
        el.classList.add("is-active");
      });
      el.addEventListener("pointermove", (e) => {
        if (!start) return;
        // relative drag like iOS: no jump to the finger, just follow it
        const v = Math.max(0, Math.min(1, start.v + (start.y - e.clientY) / start.h));
        const q = Math.round(v * 40) / 40;
        if (q !== levels()[el.dataset.ch]) {
          setLevel(el.dataset.ch, q);
          if ((q === 0 || q === 1) && !el.dataset.edge) { haptic("tap"); el.dataset.edge = "1"; }
          if (q > 0 && q < 1) delete el.dataset.edge;
          if (!ambienceOn() && q > 0) startAmbience();
          this.syncMixer();
        }
      });
      const end = () => { start = null; el.classList.remove("is-active"); };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("keydown", (e) => {
        const d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
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
    panel.querySelectorAll(".mix-ch").forEach((ch) => {
      const v = l[ch.dataset.ch];
      ch.style.setProperty("--lvl", v);
      ch.querySelector(".vslider-val").textContent = `${Math.round(v * 100)}`;
      ch.querySelector(".vslider").setAttribute("aria-valuenow", Math.round(v * 100));
    });
    const on = ambienceOn();
    panel.classList.toggle("is-on", on);
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
    const hidden = (this.mode === "window" && !this.windowLive) || this.app.classList.contains("shade-down");
    if (hidden === this.globePaused) return;
    this.globePaused = hidden;
    if (hidden) this.view.globe.pauseAnimation(); else this.view.globe.resumeAnimation();
  }

  /* ================= shade (pure mode) ================= */

  closeShade(fromWindow = false) {
    if (this.mode === "window" && !fromWindow) {
      this.windowView.setShade(1, true);
      sfx.shade(true);
      setTimeout(() => this.closeShade(true), 650);
      return;
    }
    if (!fromWindow) sfx.shade(true);
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
    if (this.shade.classList.contains("is-down")) {
      sfx.shade(false);
      if (this.mode === "window") setTimeout(() => this.windowView.setShade(0, true), 300);
    }
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
    const begin = () => {
      if (this.ended || t0) return;
      t0 = performance.now(); ticks = 0; aborted = false;
      ring.style.transition = "none";
      btn.classList.add("is-holding");
      hint().textContent = "3…";
      sfx.holdTick(0);
      raf = requestAnimationFrame(step);
    };
    this.abortStart = begin;
    this.abortCancel = cancel;
    btn.addEventListener("pointerdown", (e) => { btn.setPointerCapture(e.pointerId); begin(); });
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
    this.companion.reset();
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
    this.view.clearEndpoints();
    this.view.setLabels([]);
    this.view.showRadar(true);
  }
}
