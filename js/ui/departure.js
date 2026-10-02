// Departure: time dial -> radar ring on the globe -> airports in range -> pick a destination.
import { airports, distancesFrom } from "../airports.js";
import { CRUISE_KMH, settings, updateSettings } from "../settings.js";
import { formatDuration, haversineKm, interpolateGC, initialBearing, compassWord, destinationPoint } from "../geo.js";
import { haptic } from "../haptics.js";
import { sfx } from "../audio.js";
import { TimeDial, detent, clockLabel } from "./dial.js";
import { toast, esc } from "./common.js";

export const MIN_MIN = 5, MAX_MIN = 720;

const hm = (m) => {
  m = Math.round(m);
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h}:${String(r).padStart(2, "0")}` : `${r}`;
};
const clock = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Radar ring spacing (minutes) that keeps 2-6 rings on screen. */
const ringStep = (m) => (m <= 90 ? 15 : m <= 240 ? 30 : m <= 480 ? 60 : 120);

const arrow = (deg) =>
  `<svg class="bearing" viewBox="0 0 16 16" style="transform:rotate(${Math.round(deg)}deg)" aria-hidden="true"><path d="M8 1.5l4 11-4-2.4-4 2.4z" fill="currentColor"/></svg>`;

export class Departure {
  constructor({ view, root, onCheckIn }) {
    this.view = view;
    this.root = root;
    this.onCheckIn = onCheckIn;
    this.$ = (sel) => root.querySelector(sel);
    this.selected = -1;
    this.range = 0;           // displayed ring radius (km), eases toward target
    this.rangeVel = 0;
    this.litCount = 0;
    this.lastBlip = 0;
    this.followSince = performance.now();
    this.labelEls = new Map();
    this.hubsOnly = !!settings.hubsOnly;

    this.dial = new TimeDial(this.$("#dial"), {
      min: MIN_MIN, max: MAX_MIN, value: settings.lastDuration || 25, style: settings.dialStyle,
      onChange: (v) => { this.dialChanged(v); if (this.dial?.arc) sfx.spool.set(this.dial.frac); },
      onDetent: (d) => { const major = d % 15 === 0; haptic(major ? "dialMajor" : "dialDetent"); sfx.tick(major); },
      onSettle: () => { sfx.spool.stop(); this.refreshSuggestions(true); },
      onGrab: () => { if (this.dial?.arc) sfx.spool.start(this.dial.frac); this.followSince = performance.now(); if (this.selected >= 0) this.select(-1); },
    });

    this.$("#suggestions").addEventListener("click", (e) => {
      const li = e.target.closest("[data-i]");
      if (li) this.pick(+li.dataset.i, { from: "list" });
    });
    this.$("#checkin-btn").addEventListener("click", () => this.checkIn());
    this.$("#hubs-only").addEventListener("click", () => {
      this.hubsOnly = !this.hubsOnly;
      updateSettings({ hubsOnly: this.hubsOnly });
      sfx.tap();
      this.refreshSuggestions(true);
    });

    view.globe.onGlobeClick(({ lat, lng }) => this.globeTap(lat, lng));
    view.onFrame((t, dt) => this.frame(t, dt));
    setInterval(() => this.updateReadout(), 20000);
  }

  get speed() { return CRUISE_KMH * settings.routeScale; }
  minutesFor(i) { return (this.dist[i] / this.speed) * 60; }
  get active() { return this.root.closest(".app").dataset.screen === "departure"; }

  setHome(home) {
    this.home = home;
    const { dist, order } = distancesFrom(home);
    this.dist = dist;
    this.order = order;
    this.view.setHome(home);
    this.view.setAirports(airports, dist, home.i);
    this.select(-1);
    this.range = 0;
    this.litCount = 0;
    this.followSince = performance.now();
    this.dialChanged(this.dial.value);
    this.refreshSuggestions(true);
  }

  /** Called when the route scale changes. */
  rescale() {
    this.select(-1);
    this.dialChanged(this.dial.value);
    this.refreshSuggestions(true);
  }

  /** Minutes the session will last (the selected destination's time, or the dial detent). */
  get sessionMinutes() {
    return this.selected >= 0 ? Math.round(Math.max(MIN_MIN, this.minutesFor(this.selected))) : detent(this.minutes);
  }

  dialChanged(v) {
    this.minutes = v;
    this.targetRange = (v / 60) * this.speed;
    if (this.selected >= 0) this.targetRange = Math.max(this.targetRange, this.dist[this.selected] + 1);
    this.updateReadout();
    const now = performance.now();
    if (!this.lastSuggest || now - this.lastSuggest > 140) this.refreshSuggestions(false);
  }

  updateReadout() {
    if (this.minutes == null) return;
    const m = this.sessionMinutes;
    this.$("#dur-clock").textContent = hm(m);
    this.$("#dur-words").textContent = m < 60 ? "min" : "h";
    this.$("#land-time").textContent = clock(new Date(Date.now() + m * 60000));
  }

  /* ---------- per-frame: ring easing, pops, blips, camera ---------- */

  frame(t, dt) {
    if (!this.home || !this.active) return;
    // critically damped spring toward target range
    const k = 60, c = 2 * Math.sqrt(k);
    const a = -k * (this.range - this.targetRange) - c * this.rangeVel;
    this.rangeVel += a * dt;
    this.range += this.rangeVel * dt;
    if (Math.abs(this.range - this.targetRange) < 0.5 && Math.abs(this.rangeVel) < 1) { this.range = this.targetRange; this.rangeVel = 0; }
    const step = ringStep(this.minutes);
    this.view.setRadar(Math.max(0, this.range), (step / 60) * this.speed);

    // airports newly reached by the ring
    let n = this.litCount;
    const order = this.order, dist = this.dist;
    while (n < order.length && dist[order[n]] <= this.range) n++;
    while (n > 0 && dist[order[n - 1]] > this.range) n--;
    if (n > this.litCount) {
      const fresh = Math.min(n - this.litCount, 3);
      for (let j = 0; j < fresh; j++) {
        const i = order[n - 1 - j];
        if (i !== this.home.i && airports[i].large) this.view.ping(airports[i].lat, airports[i].lng);
      }
      // hubs get a sonar blip and a double pulse; small fields a tiny tick
      let hub = false;
      for (let k = this.litCount; k < n; k++) if (order[k] !== this.home.i && airports[order[k]].large) hub = true;
      const newest = order[n - 1];
      if (newest !== this.home.i) {
        if (hub && t - this.lastBlip > 90) {
          this.lastBlip = t;
          sfx.blip(1.25 - Math.min(0.5, this.range / 8000));
          haptic("radarHit", { minGapMs: 120 });
        } else if (!hub && t - (this.lastTick || 0) > 45) {
          this.lastTick = t;
          sfx.radarTick();
          haptic("radarTick", { minGapMs: 60 });
        }
      }
    }
    this.litCount = n;
    const count = Math.max(0, n - 1);
    this.$("#range-km").textContent = Math.round(this.targetRange).toLocaleString("en-US");
    this.$("#range-count").textContent = count.toLocaleString("en-US");

    // camera keeps the ring in frame unless the user is steering the globe
    if (this.view.lastUserInput < this.followSince) {
      const d = airports[this.selected];
      const center = this.selected >= 0 ? interpolateGC(this.home.lat, this.home.lng, d.lat, d.lng, 0.5) : this.home;
      const angle = Math.max(this.range, 60) / 6371 * (this.selected >= 0 ? 0.62 : 1) + 0.02;
      this.view.glideTo({ lat: center.lat, lng: center.lng, altitude: this.view.fitAltitude(angle) }, 4);
    }
  }

  /* ---------- suggestions ---------- */

  refreshSuggestions(final) {
    this.lastSuggest = performance.now();
    if (!this.dist) return;
    const v = detent(this.minutes);
    const limit = (v / 60) * this.speed;
    const rows = [];
    for (const i of this.order) {
      if (this.dist[i] > limit) break;
      if (i === this.home.i) continue;
      if (this.hubsOnly && !airports[i].large) continue;
      const m = this.minutesFor(i);
      if (m < MIN_MIN - 0.5) continue;
      rows.push([Math.abs(m - v) - (airports[i].large ? 0.3 : 0), i, m]);
    }
    rows.sort((x, y) => x[0] - y[0]);
    const top = rows.slice(0, 24);
    this.suggestions = top.map((r) => r[1]);
    this.$("#hubs-only").setAttribute("aria-pressed", this.hubsOnly);
    const ul = this.$("#suggestions");
    if (!top.length) {
      ul.innerHTML = `<li class="empty">
        <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-dasharray="3 4"/><circle cx="24" cy="24" r="3" fill="currentColor"/></svg>
        <span>Nothing in range yet${this.hubsOnly ? " among the hubs" : ""}. Turn the dial up${settings.routeScale < 4 ? ", or raise the route scale in Settings" : ""}.</span></li>`;
    } else {
      ul.innerHTML = top.map(([, i, m]) => {
        const a = airports[i];
        const delta = Math.round(m) - v;
        const brg = initialBearing(this.home.lat, this.home.lng, a.lat, a.lng);
        const match = delta === 0 ? `<span class="match exact">on time</span>` : `<span class="match">${delta > 0 ? "+" : "−"}${Math.abs(delta)}m</span>`;
        return `<li><button class="sugg${i === this.selected ? " is-selected" : ""}" data-i="${i}">
          <span class="sugg-code">${a.iata}</span>
          <span class="sugg-place">
            <span class="sugg-city">${esc(a.city)}${a.large ? `<i class="hub">HUB</i>` : ""}</span>
            <span class="sugg-country">${arrow(brg)}<span>${compassWord(brg)} · ${esc(a.countryName)}</span></span>
          </span>
          <span class="sugg-time"><span>${hm(m)}${m >= 60 ? "" : "<em>m</em>"}</span>${match}</span>
        </button></li>`;
      }).join("");
    }
    if (final) this.updateLabels();
  }

  /* ---------- selection ---------- */

  pick(i, { from } = {}) {
    const m = this.minutesFor(i);
    if (m > MAX_MIN + 0.5) {
      const hint = settings.routeScale < 4 ? ` Try a ${settings.routeScale * 2}× route scale in Settings.` : "";
      toast(`${airports[i].iata} is ${formatDuration(m)} away at ${settings.routeScale}×.${hint}`);
      return;
    }
    if (m < MIN_MIN - 0.5) { toast(`${airports[i].iata} is too close for a flight from ${this.home.iata}.`); return; }
    sfx.tap();
    haptic("tap");
    this.followSince = performance.now();
    this.select(i);
    this.dial.setValue(Math.max(MIN_MIN, m), { animate: true, exact: true });
    if (from === "globe") this.refreshSuggestions(true);
  }

  select(i) {
    this.selected = i;
    const card = this.$("#dest-card");
    this.root.querySelectorAll(".sugg.is-selected").forEach((b) => b.classList.remove("is-selected"));
    if (i < 0) {
      card.hidden = true;
      this.view.clearRoute();
      this.updateLabels();
      this.updateReadout();
      return;
    }
    const a = airports[i];
    this.root.querySelector(`.sugg[data-i="${i}"]`)?.classList.add("is-selected");
    const m = Math.round(Math.max(MIN_MIN, this.minutesFor(i)));
    const brg = initialBearing(this.home.lat, this.home.lng, a.lat, a.lng);
    this.$("#dest-code").textContent = a.iata;
    this.$("#dest-city").textContent = a.city;
    this.$("#dest-meta").innerHTML = `${arrow(brg)}<span>${compassWord(brg)} · ${Math.round(this.dist[i]).toLocaleString("en-US")} km · ${esc(a.countryName)}</span>`;
    this.$("#dest-time").textContent = formatDuration(m);
    card.hidden = false;
    card.classList.remove("is-new"); void card.offsetWidth; card.classList.add("is-new");
    this.view.setRoute(this.home, a, { preview: true });
    this.dialChanged(this.dial.value);
    this.updateLabels();
  }

  globeTap(lat, lng) {
    if (!this.active) return;
    const thresholdKm = Math.max(12, 28 * this.view.kmPerPixel());
    let best = -1, bestD = Infinity;
    for (const a of airports) {
      if (a.i === this.home.i) continue;
      const d = haversineKm(lat, lng, a.lat, a.lng) - (a.large ? thresholdKm * 0.25 : 0);
      if (d < bestD) { bestD = d; best = a.i; }
    }
    if (best >= 0 && bestD <= thresholdKm) this.pick(best, { from: "globe" });
  }

  checkIn() {
    if (this.selected < 0) return;
    sfx.tap();
    this.onCheckIn({
      origin: this.home, dest: airports[this.selected], distKm: this.dist[this.selected],
      durationMin: this.sessionMinutes, scale: settings.routeScale, speedKmh: this.speed,
    });
  }

  /* ---------- globe labels ---------- */

  label(key, html, cls) {
    let el = this.labelEls.get(key);
    if (!el) { el = document.createElement("div"); this.labelEls.set(key, el); }
    el.className = `globe-label ${cls}`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    return el;
  }

  updateLabels() {
    if (!this.home) return;
    const items = [{ key: "home", lat: this.home.lat, lng: this.home.lng, el: this.label("home", `<span class="pin"></span><b>${this.home.iata}</b>`, "is-home") }];
    // time marks along the radar rings, south-east of home
    const total = detent(this.minutes);
    const step = ringStep(total);
    for (let m = step, k = 0; m < total - step * 0.35 && k < 6; m += step, k++) {
      const p = destinationPoint(this.home.lat, this.home.lng, 132, (m / 60) * this.speed);
      items.push({ key: `r${k}`, lat: p.lat, lng: p.lng, el: this.label(`r${k}`, `<b>${clockLabel(m)}</b>`, "is-ring") });
    }
    if (this.selected >= 0) {
      const a = airports[this.selected];
      items.push({ key: "dest", lat: a.lat, lng: a.lng, el: this.label("dest", `<span class="pin"></span><b>${a.iata}</b>`, "is-dest") });
    } else {
      for (const i of (this.suggestions || []).slice(0, 3)) {
        const a = airports[i];
        items.push({ key: `s${i}`, lat: a.lat, lng: a.lng, el: this.label(`s${i}`, `<b>${a.iata}</b>`, "is-hint") });
      }
    }
    this.view.setLabels(items);
  }
}
