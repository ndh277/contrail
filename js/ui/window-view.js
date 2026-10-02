// Window view: what you'd see through the cabin window right now.
// Sky colour follows the sun's elevation at the plane's current position;
// three procedural cloud layers drift past and tilt with the gyroscope.
import { subsolarPoint } from "../geo.js";
import { reducedMotion } from "../spring.js";

const RAD = Math.PI / 180;

// [elevation°, zenith, middle, horizon, cloud light (0..1), cloud warmth (0..1), stars]
const SKY = [
  [-90, "#010309", "#03060f", "#070d1d", 0.16, 0, 1],
  [-18, "#02040b", "#050b1a", "#0c1631", 0.2, 0, 1],
  [-9, "#050a1c", "#121e46", "#2f2a58", 0.3, 0.2, 0.7],
  [-3, "#14224f", "#4b3f74", "#d9784a", 0.55, 0.9, 0.15],
  [2, "#2a4d8f", "#8b86b0", "#ffb373", 0.8, 0.85, 0],
  [8, "#3a6fbf", "#86afdc", "#ffe0b4", 0.95, 0.4, 0],
  [25, "#2e6bd0", "#6aa6e9", "#cfe5f8", 1, 0.05, 0],
  [90, "#1e5cc9", "#5a9ae6", "#bcdbf6", 1, 0, 0],
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixHex = (a, b, k) => {
  const A = hex(a), B = hex(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(",")})`;
};

export function sunElevation(lat, lng, date = new Date()) {
  const s = subsolarPoint(date);
  const cosZ = Math.sin(lat * RAD) * Math.sin(s.lat * RAD) + Math.cos(lat * RAD) * Math.cos(s.lat * RAD) * Math.cos((lng - s.lng) * RAD);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / RAD;
}

export function skyAt(elev) {
  let i = 0;
  while (i < SKY.length - 2 && elev > SKY[i + 1][0]) i++;
  const a = SKY[i], b = SKY[i + 1];
  const k = Math.max(0, Math.min(1, (elev - a[0]) / (b[0] - a[0])));
  return {
    top: mixHex(a[1], b[1], k), mid: mixHex(a[2], b[2], k), horizon: mixHex(a[3], b[3], k),
    light: a[4] + (b[4] - a[4]) * k, warm: a[5] + (b[5] - a[5]) * k, stars: a[6] + (b[6] - a[6]) * k,
  };
}

/** One tileable strip of soft cumulus, drawn once per layer. */
function cloudStrip(seed, w, h, density, puff) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < density; i++) {
    const cx = rnd() * w, cy = h * (0.35 + rnd() * 0.5), n = 4 + Math.floor(rnd() * 7);
    for (let j = 0; j < n; j++) {
      const r = puff * (0.5 + rnd());
      const x = cx + (rnd() - 0.5) * puff * 3, y = cy + (rnd() - 0.6) * puff;
      for (const dx of [-w, 0, w]) {        // wrap so the strip tiles seamlessly
        const grd = g.createRadialGradient(x + dx, y, 0, x + dx, y, r);
        grd.addColorStop(0, "rgba(255,255,255,0.8)");
        grd.addColorStop(0.5, "rgba(255,255,255,0.38)");
        grd.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grd;
        g.beginPath(); g.arc(x + dx, y, r, 0, Math.PI * 2); g.fill();
      }
    }
  }
  return c.toDataURL("image/png");
}

export class WindowView {
  constructor(root) {
    this.root = root;
    this.layers = [...root.querySelectorAll(".cloud-layer")];
    const specs = [[11, 900, 220, 14, 40], [23, 1100, 260, 11, 58], [37, 1400, 300, 8, 84]];
    this.layers.forEach((el, i) => {
      const [seed, w, h, d, p] = specs[i];
      el.style.backgroundImage = `url(${cloudStrip(seed, w, h, d, p)})`;
      el.style.backgroundSize = `${w}px ${h}px`;
      el.dataset.w = w;
    });
    this.speeds = [14, 26, 46];     // px/s — nearer layers move faster
    this.offset = 0;
    this.tilt = { x: 0, y: 0 };
    this.target = { x: 0, y: 0 };
    this.active = false;
    this.onOrient = (e) => {
      if (e.gamma == null) return;
      // portrait: gamma = left/right tilt, beta = front/back
      this.target.x = Math.max(-30, Math.min(30, e.gamma));
      this.target.y = Math.max(-25, Math.min(25, (e.beta ?? 60) - 60));
    };
  }

  show(on) {
    this.active = on;
    if (on) addEventListener("deviceorientation", this.onOrient);
    else removeEventListener("deviceorientation", this.onOrient);
  }

  /** Called every frame while visible. */
  frame(dt, lat, lng, date) {
    if (!this.active) return;
    if (!this.lastSky || date - this.lastSky > 5000) {
      this.lastSky = date;
      const elev = sunElevation(lat, lng, new Date(date));
      const sky = skyAt(elev);
      const st = this.root.style;
      st.setProperty("--sky-top", sky.top);
      st.setProperty("--sky-mid", sky.mid);
      st.setProperty("--sky-horizon", sky.horizon);
      st.setProperty("--cloud-light", sky.light.toFixed(3));
      st.setProperty("--cloud-warm", sky.warm.toFixed(3));
      st.setProperty("--stars", sky.stars.toFixed(3));
      st.setProperty("--sun-glow", String(Math.max(0, 1 - Math.abs(elev - 2) / 14).toFixed(3)));
      this.elev = elev;
    }
    const still = reducedMotion();
    this.offset += dt * (still ? 0 : 1);
    const k = 1 - Math.exp(-4 * dt);
    this.tilt.x += (this.target.x - this.tilt.x) * k;
    this.tilt.y += (this.target.y - this.tilt.y) * k;
    this.layers.forEach((el, i) => {
      const w = +el.dataset.w;
      const x = -((this.offset * this.speeds[i]) % w) + this.tilt.x * (i + 1) * 1.6;
      const y = this.tilt.y * (i + 1) * 0.8;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    });
    this.root.style.setProperty("--bank", `${(-this.tilt.x * 0.25).toFixed(2)}deg`);
  }
}
