// Departure: time dial -> radar ring on the globe -> airports in range -> pick a destination.
import { airports, distancesFrom } from "../airports.js";
import { CRUISE_KMH, settings } from "../settings.js";
import { formatClock, formatDuration, haversineKm, interpolateGC } from "../geo.js";
import { haptic } from "../haptics.js";
import { sfx } from "../audio.js";
import { TimeDial } from "./dial.js";
import { toast, esc } from "./common.js";

const MIN = 5, MAX = 180;

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

    this.dial = new TimeDial(this.$("#dial"), {
      min: MIN, max: MAX, value: settings.lastDuration || 25,
      onChange: (v) => this.dialChanged(v),
      onDetent: () => { haptic("dialDetent"); sfx.tick(); },
      onSettle: () => this.refreshSuggestions(true),
      onGrab: () => { this.followSince = performance.now(); if (this.selected >= 0) this.select(-1); },
    });

    this.$("#suggestions").addEventListener("click", (e) => {
      const li = e.target.closest("[data-i]");
      if (li) this.pick(+li.dataset.i, { from: "list" });
    });
    this.$("#checkin-btn").addEventListener("click", () => this.checkIn());

    view.globe.onGlobeClick(({ lat, lng }) => this.globeTap(lat, lng));
    view.onFrame((t, dt) => this.frame(t, dt));
  }

  get speed() { return CRUISE_KMH * settings.routeScale; }
  minutesFor(i) { return (this.dist[i] / this.speed) * 60; }

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

  dialChanged(v) {
    this.minutes = v;
    this.targetRange = (v / 60) * this.speed;
    if (this.selected >= 0) this.targetRange = Math.max(this.targetRange, this.dist[this.selected] + 1);
    const m = Math.round(v);
    this.$("#dur-clock").textContent = formatClock(m);
    this.$("#dur-words").textContent = m < 60 ? "minutes" : m === 60 ? "hour" : "hours";
    const now = performance.now();
    if (!this.lastSuggest || now - this.lastSuggest > 140) this.refreshSuggestions(false);
  }

  /* ---------- per-frame: ring easing, pops, blips, camera ---------- */

  frame(t, dt) {
    if (!this.home || this.root.closest(".app").dataset.screen !== "departure") return;
    // critically damped spring toward target range
    const k = 60, c = 2 * Math.sqrt(k);
    const a = -k * (this.range - this.targetRange) - c * this.rangeVel;
    this.rangeVel += a * dt;
    this.range += this.rangeVel * dt;
    if (Math.abs(this.range - this.targetRange) < 0.5 && Math.abs(this.rangeVel) < 1) { this.range = this.targetRange; this.rangeVel = 0; }
    this.view.setRadar(Math.max(0, this.range), this.speed / 2);   // faint ring every 30 min

    // airports newly reached by the ring
    let n = this.litCount;
    const order = this.order, dist = this.dist;
    while (n < order.length && dist[order[n]] <= this.range) n++;
    while (n > 0 && dist[order[n - 1]] > this.range) n--;
    if (n > this.litCount) {
      const newest = order[n - 1];
      if (newest !== this.home.i && t - this.lastBlip > 70) {
        this.lastBlip = t;
        sfx.blip(1.25 - Math.min(0.45, this.range / 6000));
        haptic("radarHit", { minGapMs: 120 });
      }
    }
    this.litCount = n;
    const count = Math.max(0, n - 1);
    this.$("#range-line").textContent =
      `${Math.round(this.targetRange).toLocaleString("en-US")} km range · ${count.toLocaleString("en-US")} airport${count === 1 ? "" : "s"}`;

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
    const v = Math.round(this.minutes);
    const limit = (v / 60) * this.speed;
    const rows = [];
    for (const i of this.order) {
      if (this.dist[i] > limit) break;
      if (i === this.home.i) continue;
      const m = this.minutesFor(i);
      if (m < MIN - 0.5) continue;
      rows.push([Math.abs(m - v) - (airports[i].large ? 0.3 : 0), i, m]);
    }
    rows.sort((x, y) => x[0] - y[0]);
    const top = rows.slice(0, 24);
    this.suggestions = top.map((r) => r[1]);
    const ul = this.$("#suggestions");
    if (!top.length) {
      ul.innerHTML = `<li class="empty">No airports within ${formatDuration(v)} of ${esc(this.home.iata)}. Turn the dial up${settings.routeScale < 4 ? " or raise the route scale in Settings" : ""}.</li>`;
    } else {
      ul.innerHTML = top.map(([, i, m]) => {
        const a = airports[i];
        return `<li><button class="sugg${i === this.selected ? " is-selected" : ""}" data-i="${i}">
          <span class="sugg-code">${a.iata}</span>
          <span class="sugg-place"><span class="sugg-city">${esc(a.city)}</span><span class="sugg-country">${esc(a.countryName)}</span></span>
          <span class="sugg-time">${formatClock(m)}<small>${Math.round(this.dist[i]).toLocaleString("en-US")} km</small></span>
        </button></li>`;
      }).join("");
    }
    if (final) this.updateLabels();
  }

  /* ---------- selection ---------- */

  pick(i, { from } = {}) {
    const m = this.minutesFor(i);
    if (m > MAX + 0.5) {
      const hint = settings.routeScale < 4 ? ` Try a ${settings.routeScale * 2}× route scale in Settings.` : "";
      toast(`${airports[i].iata} is ${formatDuration(m)} away at ${settings.routeScale}×.${hint}`);
      return;
    }
    if (m < MIN - 0.5) { toast(`${airports[i].iata} is too close for a flight from ${this.home.iata}.`); return; }
    sfx.tap();
    haptic("tap");
    this.followSince = performance.now();
    this.select(i);
    this.dial.setValue(Math.round(Math.max(MIN, m)), { animate: true });
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
      return;
    }
    const a = airports[i];
    this.root.querySelector(`.sugg[data-i="${i}"]`)?.classList.add("is-selected");
    const m = Math.round(Math.max(MIN, this.minutesFor(i)));
    this.$("#dest-code").textContent = a.iata;
    this.$("#dest-city").textContent = a.city;
    this.$("#dest-meta").textContent = `${a.countryName} · ${Math.round(this.dist[i]).toLocaleString("en-US")} km · ${formatDuration(m)}`;
    card.hidden = false;
    this.view.setRoute(this.home, a);
    this.dialChanged(this.dial.value);
    this.updateLabels();
  }

  globeTap(lat, lng) {
    if (this.root.closest(".app").dataset.screen !== "departure") return;
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
    const dest = airports[this.selected];
    const durationMin = Math.round(Math.max(MIN, this.minutesFor(this.selected)));
    this.onCheckIn({
      origin: this.home, dest, distKm: this.dist[this.selected], durationMin,
      scale: settings.routeScale, speedKmh: this.speed,
    });
  }

  /* ---------- globe labels ---------- */

  label(key, html, cls) {
    let el = this.labelEls.get(key);
    if (!el) { el = document.createElement("div"); this.labelEls.set(key, el); }
    el.className = `globe-label ${cls}`;
    el.innerHTML = html;
    return el;
  }

  updateLabels() {
    if (!this.home) return;
    const items = [{ key: "home", lat: this.home.lat, lng: this.home.lng, el: this.label("home", `<span class="pin"></span><b>${this.home.iata}</b>`, "is-home") }];
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

