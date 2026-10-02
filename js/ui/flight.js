// Take-off on the globe + a minimal in-flight view.
// M1 scope: climb-out, camera pull-up, the plane moving in real time with its contrail.
// The full in-flight experience (window view, ambience, shade, abort, landing) is M2.
import { sfx } from "../audio.js";
import { reducedMotion } from "../spring.js";
import { esc } from "./common.js";
import { interpolateGC } from "../geo.js";

const CLIMB_SECONDS = 9;

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
    flight.startedAt = Date.now();
    flight.etaAt = flight.startedAt + flight.durationMin * 60000;
    const v = this.view;
    v.showRadar(false);
    v.setLabels([]);
    v.setRoute(flight.origin, flight.dest, { dashed: false });
    v.updatePlane(0, 0);

    this.$("#hud-route").innerHTML = `${esc(flight.origin.iata)} <span>→</span> ${esc(flight.dest.iata)}`;
    this.$("#hud-sub").textContent = `${flight.flightNo} · Seat ${flight.seat} · ${flight.tag.name}`;
    this.$("#hud-tag").style.setProperty("--tag", flight.tag.color);

    // camera: drop close to the runway, then pull up into the globe and frame the route
    const o = flight.origin;
    const d = flight.dest;
    const mid = interpolateGC(o.lat, o.lng, d.lat, d.lng, 0.5);
    const routeAngle = flight.distKm / 6371;
    const wide = { lat: mid.lat, lng: mid.lng, altitude: v.fitAltitude(routeAngle * 0.6 + 0.08) };
    if (reducedMotion()) {
      v.pointOfView(wide, 0);
    } else {
      v.pointOfView({ lat: o.lat - 0.8, lng: o.lng, altitude: 0.22 }, 900);
      setTimeout(() => { if (this.flight === flight) v.pointOfView(wide, 4200); }, 1700);
    }
    sfx.takeoff(CLIMB_SECONDS);
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

    if (!this.lastHud || t - this.lastHud > 250) {
      this.lastHud = t;
      const s = Math.max(0, Math.ceil((f.etaAt - now) / 1000));
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      this.$("#hud-clock").textContent = hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      this.$("#hud-left").textContent = `${Math.round(f.distKm * (1 - progress)).toLocaleString("en-US")} km to go · ETA ${new Date(f.etaAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
      this.$("#hud-progress").style.transform = `scaleX(${progress})`;
      if (progress >= 1 && !this.arrived) {
        this.arrived = true;
        sfx.chime();
        this.$("#hud-left").textContent = `Arrived at ${f.dest.city}. Landing + stamps arrive in M2.`;
      }
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
