// Take-off on the globe + the in-flight HUD.
// Take-off: the camera drops to the runway, then pulls up and frames the route
// while the plane climbs out with its contrail. After that the camera follows
// the plane (until Henry steers the globe himself).
// The rest of in-flight (window view, ambience, shade, abort, landing) is M2.
import { sfx } from "../audio.js";
import { reducedMotion } from "../spring.js";
import { interpolateGC, localSolarHours } from "../geo.js";

const CLIMB_SECONDS = 9;
const TAKEOFF_MOVE_MS = 6500;

export class Flight {
  constructor({ view, root, onEnd }) {
    this.view = view;
    this.root = root;
    this.onEnd = onEnd;
    this.$ = (s) => root.querySelector(s);
    this.$("#flight-end").addEventListener("click", () => this.endEarly());
    view.onFrame((t) => this.frame(t));
  }

  start(flight) {
    this.flight = flight;
    this.arrived = false;
    flight.startedAt = Date.now();
    flight.etaAt = flight.startedAt + flight.durationMin * 60000;
    this.cruiseFt = Math.round(Math.min(39000, 14000 + flight.distKm * 28) / 1000) * 1000;
    this.followFrom = performance.now() + (reducedMotion() ? 0 : TAKEOFF_MOVE_MS);
    const v = this.view;
    v.showRadar(false);
    v.setLabels([]);
    v.setRoute(flight.origin, flight.dest, { dashed: false });
    v.updatePlane(0, 0);

    const o = flight.origin, d = flight.dest;
    this.$("#hud-from").textContent = o.iata;
    this.$("#hud-to").textContent = d.iata;
    this.$("#hud-from-city").textContent = o.city;
    this.$("#hud-to-city").textContent = d.city;
    this.$("#hud-track-from").textContent = o.iata;
    this.$("#hud-track-to").textContent = d.iata;
    this.$("#hud-sub").textContent = `${flight.flightNo} · ${flight.seat} · ${flight.tag.name}`;
    this.$("#hud-tag").style.setProperty("--tag", flight.tag.color);

    // camera: drop close to the runway, then pull up into the globe and frame the route
    const mid = interpolateGC(o.lat, o.lng, d.lat, d.lng, 0.5);
    const wide = { lat: mid.lat, lng: mid.lng, altitude: v.fitAltitude((flight.distKm / 6371) * 0.6 + 0.08) };
    if (reducedMotion()) {
      v.pointOfView(wide, 0);
    } else {
      v.pointOfView({ lat: o.lat - 0.8, lng: o.lng, altitude: 0.22 }, 900);
      setTimeout(() => { if (this.flight === flight) v.pointOfView(wide, 4200); }, 1700);
    }
    sfx.takeoff(CLIMB_SECONDS);
  }

  phase(progress, elapsed) {
    if (progress >= 1) return "Arrived";
    if (elapsed < CLIMB_SECONDS) return "Taking off";
    const remainingMin = this.flight.durationMin * (1 - progress);
    if (progress < 0.12 && elapsed < 20 * 60) return "Climbing";
    if (progress > 0.88 || remainingMin < 3) return "Descending";
    return "Cruising";
  }

  frame(t) {
    const f = this.flight;
    if (!f || document.getElementById("app").dataset.screen !== "flight") return;
    const now = Date.now();
    const elapsed = (now - f.startedAt) / 1000;
    const progress = Math.min(1, elapsed / (f.durationMin * 60));
    const climb = reducedMotion() ? 1 : Math.min(1, elapsed / CLIMB_SECONDS);
    const ease = 1 - Math.pow(1 - climb, 3);
    this.view.updatePlane(progress, ease);
    const here = interpolateGC(f.origin.lat, f.origin.lng, f.dest.lat, f.dest.lng, progress);

    // after the take-off move, keep the plane in frame unless Henry is steering
    const v = this.view;
    if (t > this.followFrom && t - v.lastUserInput > 8000) {
      const leftKm = f.distKm * (1 - progress);
      const angle = Math.min(0.9, Math.max(0.12, (leftKm / 6371) * 0.7 + 0.06));
      v.glideTo({ lat: here.lat, lng: here.lng, altitude: v.fitAltitude(angle) }, 0.8);
    }

    if (this.lastHud && t - this.lastHud < 200) return;
    this.lastHud = t;
    const s = Math.max(0, Math.ceil((f.etaAt - now) / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    this.$("#hud-clock").textContent = hh
      ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
      : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    this.$("#hud-progress").style.transform = `scaleX(${progress})`;
    this.$("#hud-craft").style.left = `${progress * 100}%`;

    // simulated flight data
    // displayed altitude: brisk initial climb, gentle final descent
    const easeOut = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 2;
    const profile = Math.min(easeOut(progress / 0.12), easeOut((1 - progress) / 0.12));
    const alt = Math.round((this.cruiseFt * profile) / 100) * 100;
    const speed = Math.round(f.speedKmh * Math.min(1, 0.32 + climb * 0.68) * (progress >= 1 ? 0 : 1));
    this.$("#hud-alt").textContent = `${alt.toLocaleString("en-US")} ft`;
    this.$("#hud-speed").textContent = `${speed.toLocaleString("en-US")} km/h`;
    this.$("#hud-left").textContent = `${Math.round(f.distKm * (1 - progress)).toLocaleString("en-US")} km`;
    const sun = localSolarHours(here.lng);
    this.$("#hud-sun").textContent = `${String(Math.floor(sun)).padStart(2, "0")}:${String(Math.floor((sun % 1) * 60)).padStart(2, "0")}`;
    const phase = this.phase(progress, elapsed);
    const ph = this.$("#hud-phase");
    if (ph.textContent !== phase) ph.textContent = phase;

    if (progress >= 1 && !this.arrived) {
      this.arrived = true;
      sfx.chime();
      this.$("#hud-sub").textContent = `Arrived at ${f.dest.city} · landing and stamps arrive in M2`;
    }
  }

  endEarly() {
    this.flight = null;
    this.arrived = false;
    this.view.removePlane();
    this.view.clearRoute();
    this.view.showRadar(true);
    this.onEnd();
  }
}
