// Time dial, in two styles (Settings → Dial):
// - "arc": a throttle quadrant. A lever sweeps a half-circle scale from IDLE to 12 h;
//   drag anywhere along the arc, slowly for single minutes, fast to cover hours.
// - "tape": a horizontal "altitude tape" that slides under a fixed needle.
// 5 min .. 12 h. Detent every minute up to 3 h, every 5 minutes beyond, so the
// travel stays short enough to fling while the first three hours stay precise.
// Internally everything moves in tape pixels; minutes are derived from that.
import { reducedMotion } from "../spring.js";

// theme colours, read once per theme (getComputedStyle every frame forces a style recalc)
const cssCache = new Map();
const css = (name) => {
  if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  return cssCache.get(name);
};

export const KNEE = 180;          // minutes where the tape compresses
const PX_FINE = 13;               // px per minute below the knee
const PX_COARSE = 13 / 5;         // px per minute above it (13 px per 5-min detent)

const toPx = (m) => (m <= KNEE ? m * PX_FINE : KNEE * PX_FINE + (m - KNEE) * PX_COARSE);
const toMin = (px) => (px <= KNEE * PX_FINE ? px / PX_FINE : KNEE + (px - KNEE * PX_FINE) / PX_COARSE);
/** Nearest detent for a minute value. */
export const detent = (m) => (m <= KNEE + 2.5 ? Math.round(Math.min(m, KNEE)) : KNEE + 5 * Math.round((m - KNEE) / 5));

export function clockLabel(m) {
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export class TimeDial {
  constructor(el, { min = 5, max = 720, value = 25, style = "arc", onChange, onDetent, onSettle, onGrab, onRelease } = {}) {
    Object.assign(this, { el, min, max, onChange, onDetent, onSettle, onGrab, onRelease });
    this.pos = toPx(value);
    this.minPos = toPx(min);
    this.maxPos = toPx(max);
    this.canvas = document.createElement("canvas");
    el.append(this.canvas);
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", "Focus duration");
    el.setAttribute("aria-valuemin", min);
    el.setAttribute("aria-valuemax", max);
    this.velocity = 0;          // px per second
    this.mode = "idle";         // idle | drag | coast | snap | glide
    this.lastDetent = detent(value);
    this.samples = [];
    this.raf = 0;

    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.up(e));
    el.addEventListener("keydown", (e) => this.key(e));
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.nudge(Math.sign(e.deltaY || e.deltaX));
    }, { passive: false });

    new ResizeObserver(() => this.resize()).observe(el);
    this.setStyle(style);
    new MutationObserver(() => { cssCache.clear(); this.draw(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  get arc() { return this.style === "arc"; }

  setStyle(style) {
    this.style = style === "tape" ? "tape" : "arc";
    this.el.classList.toggle("is-arc", this.arc);
    this.resize();
  }

  /** 0..1 travel of the throttle lever. */
  get frac() { return (this.pos - this.minPos) / (this.maxPos - this.minPos); }

  /** Arc geometry in element px: pivot (cx, cy) and scale radius R. */
  geometry(w = this.el.clientWidth, h = this.el.clientHeight) {
    const R = Math.max(60, Math.min(w / 2 - 34, h - 38));
    return { cx: w / 2, cy: h - 16, R };
  }

  get value() { return Math.max(this.min, Math.min(this.max, toMin(this.pos))); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.dpr = dpr;
    this.draw();
  }

  /* ---------- input ---------- */

  down(e) {
    this.el.setPointerCapture(e.pointerId);
    this.mode = "drag";
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.dragT = performance.now();
    this.samples = [{ t: performance.now(), p: this.pos }];
    this.velocity = 0;
    this.el.classList.add("is-grabbed");
    this.onGrab?.();
    this.loop();
  }

  move(e) {
    if (this.mode !== "drag") return;
    const dx = e.clientX - this.dragX, dy = e.clientY - this.dragY;
    const now = performance.now();
    const dt = Math.max(0.004, (now - this.dragT) / 1000);
    this.dragX = e.clientX; this.dragY = e.clientY; this.dragT = now;
    let delta = -dx;
    if (this.arc) {
      // movement along the arc (clockwise = more thrust), wherever the finger is
      const r = this.el.getBoundingClientRect();
      const { cx, cy, R } = this.geometry(r.width, r.height);
      const px = e.clientX - r.left - cx, py = e.clientY - r.top - cy;
      const dist = Math.hypot(px, py);
      const along = (px * dy - py * dx) / Math.max(dist, R * 0.5);
      // pointer acceleration: slow = one tape px per finger px (single minutes), fast = hours
      const speed = Math.abs(along) / dt;
      const k = Math.min(1, Math.max(0, (speed - 160) / 1300));
      delta = along * (1 + 8 * k * k * (3 - 2 * k));
    }
    let next = this.pos + delta;
    // rubber-band past the ends
    if (next < this.minPos || next > this.maxPos) {
      const over = next < this.minPos ? this.minPos - this.pos : this.pos - this.maxPos;
      next = this.pos + delta * 0.35 * Math.max(0, 1 - Math.max(0, over) / 90);
    }
    this.pos = next;
    this.samples.push({ t: now, p: this.pos });
    while (this.samples.length > 2 && now - this.samples[0].t > 90) this.samples.shift();
    this.changed(true);
  }

  up() {
    if (this.mode !== "drag") return;
    this.el.classList.remove("is-grabbed");
    this.onRelease?.();
    const s = this.samples;
    const a = s[0], b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    this.velocity = dt > 0.008 ? (b.p - a.p) / dt : 0;
    if (performance.now() - b.t > 80) this.velocity = 0;
    this.mode = Math.abs(this.velocity) > 60 && !reducedMotion() ? "coast" : "snap";
    this.snapTarget = null;
    this.loop();
  }

  nudge(dir) {
    const v = detent(this.value);
    const step = v < KNEE || (v === KNEE && dir < 0) ? 1 : 5;
    this.setValue(v + dir * step, { animate: true, user: true });
  }

  key(e) {
    const v = detent(this.value);
    if (e.key === "ArrowRight" || e.key === "ArrowUp") this.nudge(1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") this.nudge(-1);
    else if (e.key === "PageUp") this.setValue(v + 15, { animate: true, user: true });
    else if (e.key === "PageDown") this.setValue(v - 15, { animate: true, user: true });
    else if (e.key === "Home") this.setValue(this.min, { animate: true, user: true });
    else if (e.key === "End") this.setValue(this.max, { animate: true, user: true });
    else return;
    e.preventDefault();
  }

  /** Programmatic value change (reverse pick). Values are not forced onto a detent. */
  setValue(v, { animate = true, user = false, exact = false } = {}) {
    v = Math.max(this.min, Math.min(this.max, exact ? Math.round(v) : detent(v)));
    if (user) this.onGrab?.();
    if (!animate || reducedMotion()) {
      this.pos = toPx(v); this.mode = "idle"; this.lastDetent = detent(v);
      this.changed(false); this.onSettle?.(v); this.draw();
      return;
    }
    this.mode = "glide";
    this.glideFrom = this.pos;
    this.glideTo = toPx(v);
    this.glideStart = performance.now();
    this.glideDur = Math.min(950, 280 + Math.abs(this.glideTo - this.pos) * 0.45);
    this.loop();
  }

  /* ---------- animation ---------- */

  loop() {
    if (this.raf) return;
    let last = performance.now();
    const frame = (t) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      this.raf = 0;
      if (this.step(t, dt)) this.raf = requestAnimationFrame(frame);
      this.draw();
    };
    this.raf = requestAnimationFrame(frame);
  }

  step(t, dt) {
    switch (this.mode) {
      case "drag":
        return true;
      case "coast": {
        this.pos += this.velocity * dt;
        this.velocity *= Math.exp(-2.6 * dt);
        if (this.pos < this.minPos || this.pos > this.maxPos) this.velocity *= Math.exp(-20 * dt);
        this.changed(true);
        if (Math.abs(this.velocity) < 70) { this.mode = "snap"; this.snapTarget = null; }
        return true;
      }
      case "snap": {
        if (this.snapTarget == null) {
          const projected = toMin(this.pos + this.velocity * 0.1);
          this.snapTarget = toPx(Math.max(this.min, Math.min(this.max, detent(projected))));
        }
        // critically damped approach to the detent
        const k = 240, c = 2 * Math.sqrt(k);
        const f = -k * (this.pos - this.snapTarget) - c * this.velocity;
        this.velocity += f * dt;
        this.pos += this.velocity * dt;
        this.changed(true);
        if (Math.abs(this.pos - this.snapTarget) < 0.05 && Math.abs(this.velocity) < 1) {
          this.pos = this.snapTarget; this.velocity = 0; this.mode = "idle";
          this.changed(false);
          this.onSettle?.(this.value);
          return false;
        }
        return true;
      }
      case "glide": {
        const p = Math.min(1, (t - this.glideStart) / this.glideDur);
        const e = 1 - Math.pow(1 - p, 3);
        this.pos = this.glideFrom + (this.glideTo - this.glideFrom) * e;
        this.changed(false);
        if (p >= 1) {
          this.pos = this.glideTo; this.mode = "idle"; this.lastDetent = detent(this.value);
          this.onSettle?.(this.value);
          return false;
        }
        return true;
      }
      default:
        return false;
    }
  }

  changed(detents) {
    const v = this.value;
    const d = detent(v);
    if (d !== this.lastDetent) {
      this.lastDetent = d;
      if (detents) this.onDetent?.(d);
    }
    this.el.setAttribute("aria-valuenow", d);
    this.el.setAttribute("aria-valuetext", d < 60 ? `${d} minutes` : `${Math.floor(d / 60)} hours ${d % 60} minutes`);
    this.onChange?.(v);
  }

  /* ---------- drawing ---------- */

  draw() {
    if (this.arc) return this.drawArc();
    const ctx = this.canvas.getContext("2d");
    const { dpr } = this;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const low = css("--text-low"), mid = css("--text-mid"), hi = css("--text-hi"), accent = css("--accent");
    const mono = css("--font-mono");
    const base = h - 16;

    // recessed track
    const track = ctx.createLinearGradient(0, base - 46, 0, base + 10);
    track.addColorStop(0, "rgba(0,0,0,0)");
    track.addColorStop(0.55, css("--dial-track") || "rgba(0,0,0,0.18)");
    track.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = track;
    ctx.fillRect(0, base - 46, w, 56);

    const fromMin = Math.max(this.min, Math.floor(toMin(Math.max(0, this.pos - cx - 20))));
    const toM = Math.min(this.max, Math.ceil(toMin(this.pos + cx + 20)));
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineCap = "round";
    for (let m = fromMin; m <= toM; m++) {
      const fine = m <= KNEE;
      if (!fine && m % 5) continue;
      const x = cx + (toPx(m) - this.pos);
      const major = fine ? m % 15 === 0 : m % 60 === 0;
      const medium = fine ? m % 5 === 0 : m % 15 === 0;
      const d = Math.abs(x - cx) / (w * 0.5);
      const near = Math.max(0, 1 - d);
      const lens = 1 + 0.55 * Math.pow(near, 6);      // ticks swell under the needle
      const len = (major ? 26 : medium ? 17 : 9) * lens;
      ctx.globalAlpha = 0.25 + 0.75 * near;
      ctx.strokeStyle = major ? hi : medium ? mid : low;
      ctx.lineWidth = major ? 2 : medium ? 1.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.lineTo(x, base - len);
      ctx.stroke();
      if (major && Math.abs(x - cx) > 18) {
        ctx.globalAlpha *= Math.min(1, (Math.abs(x - cx) - 18) / 22);
        ctx.fillStyle = hi;
        ctx.font = `500 12px ${mono}`;
        ctx.fillText(clockLabel(m), x, base - 36);
      }
    }

    // the knee: from here on each detent is 5 minutes
    const kx = cx + (toPx(KNEE) - this.pos);
    if (kx > -40 && kx < w + 40) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = low;
      ctx.font = `400 9px ${mono}`;
      ctx.textAlign = "left";
      ctx.fillText("5-MIN STEPS →", kx + 6, base + 13);
      ctx.textAlign = "center";
    }

    // baseline
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = low;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(w, base + 0.5); ctx.stroke();

    // needle with a soft glow
    ctx.globalAlpha = 1;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, base + 3); ctx.lineTo(cx, base - 52); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cx - 7, base + 10); ctx.lineTo(cx + 7, base + 10); ctx.lineTo(cx, base + 2); ctx.closePath();
    ctx.fill();
    ctx.beginPath(); ctx.arc(cx, base - 52, 3.2, 0, Math.PI * 2); ctx.fill();
  }

  /** Throttle quadrant: fixed half-circle scale, a lever pivoting from the bottom centre. */
  drawArc() {
    const ctx = this.canvas.getContext("2d");
    const { dpr } = this;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { cx, cy, R } = this.geometry(w, h);
    const low = css("--text-low"), mid = css("--text-mid"), hi = css("--text-hi"), accent = css("--accent");
    const mono = css("--font-mono");
    const span = this.maxPos - this.minPos;
    const fOf = (m) => (toPx(m) - this.minPos) / span;
    const ang = (f) => Math.PI + Math.max(-0.03, Math.min(1.03, f)) * Math.PI;
    const f = this.frac;
    const a = ang(f);
    const grabbed = this.mode === "drag" || this.mode === "coast";

    // recessed bezel
    ctx.lineCap = "butt";
    ctx.lineWidth = 34;
    ctx.strokeStyle = css("--dial-track") || "rgba(0,0,0,0.25)";
    ctx.beginPath(); ctx.arc(cx, cy, R - 12, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = low;
    ctx.beginPath(); ctx.arc(cx, cy, R + 5.5, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.globalAlpha = 1;

    // scale: every 5 min to 3 h, every 30 min beyond; lit up to the lever
    ctx.lineCap = "round";
    const ticks = [];
    for (let m = 5; m <= KNEE; m += 5) ticks.push(m);
    for (let m = KNEE + 30; m <= this.max; m += 30) ticks.push(m);
    for (const m of ticks) {
      const tf = fOf(m);
      const ta = ang(tf);
      const major = m % 60 === 0;
      const medium = m % 15 === 0 || m > KNEE;
      const len = major ? 16 : medium ? 10 : 6;
      const lit = tf <= f + 1e-6;
      ctx.strokeStyle = lit ? accent : major ? mid : low;
      ctx.globalAlpha = lit ? 1 : major ? 0.9 : 0.6;
      ctx.lineWidth = major ? 2.2 : 1.4;
      const c = Math.cos(ta), s = Math.sin(ta);
      ctx.beginPath();
      ctx.moveTo(cx + c * R, cy + s * R);
      ctx.lineTo(cx + c * (R - len), cy + s * (R - len));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.font = `500 11px ${mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [m, label] of [[30, "30m"], [60, "1h"], [120, "2h"], [180, "3h"], [360, "6h"], [540, "9h"], [720, "12h"]]) {
      const ta = ang(fOf(m));
      const rr = R - 30;
      ctx.fillStyle = fOf(m) <= f + 1e-6 ? hi : mid;
      ctx.globalAlpha = Math.abs(ta - a) < 0.16 ? 0.25 : 0.95;
      ctx.fillText(label, cx + Math.cos(ta) * rr, cy + Math.sin(ta) * rr);
    }
    ctx.globalAlpha = 1;
    ctx.font = `500 9px ${mono}`;
    ctx.fillStyle = low;
    ctx.fillText("IDLE", cx - R + 4, cy + 9);
    ctx.fillText("TOGA", cx + R - 4, cy + 9);
    // where the steps widen to 5 minutes
    const ka = ang(fOf(KNEE));
    ctx.save();
    ctx.translate(cx + Math.cos(ka) * (R + 13), cy + Math.sin(ka) * (R + 13));
    ctx.rotate(ka + Math.PI / 2);
    ctx.font = `400 8px ${mono}`;
    ctx.fillText("5-MIN STEPS →", 30, 0);
    ctx.restore();

    // thrust band
    const band = R - 46;
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = mid;
    ctx.beginPath(); ctx.arc(cx, cy, band, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.globalAlpha = 1;
    if (f > 0.001) {
      const g = ctx.createConicGradient ? ctx.createConicGradient(Math.PI, cx, cy) : null;
      if (g) {
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(Math.max(0.001, f * 0.5 * 0.999), accent);
        g.addColorStop(1, accent);
      }
      ctx.strokeStyle = g || accent;
      ctx.shadowColor = accent;
      ctx.shadowBlur = grabbed ? 16 : 9;
      ctx.beginPath(); ctx.arc(cx, cy, band, Math.PI, a); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // outer pointer at the lever
    const c = Math.cos(a), s = Math.sin(a);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cx + c * (R + 3), cy + s * (R + 3));
    ctx.lineTo(cx + Math.cos(a - 0.035) * (R + 14), cy + Math.sin(a - 0.035) * (R + 14));
    ctx.lineTo(cx + Math.cos(a + 0.035) * (R + 14), cy + Math.sin(a + 0.035) * (R + 14));
    ctx.closePath(); ctx.fill();

    // lever arm
    const armEnd = R - 58;
    ctx.strokeStyle = mid;
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + c * armEnd, cy + s * armEnd); ctx.stroke();
    // handle: a T-bar grip across the arm
    ctx.save();
    ctx.translate(cx + c * armEnd, cy + s * armEnd);
    ctx.rotate(a + Math.PI / 2);
    const hw = 30, hh = 13;
    const hg = ctx.createLinearGradient(0, -hh / 2, 0, hh / 2);
    hg.addColorStop(0, hi); hg.addColorStop(0.5, mid); hg.addColorStop(1, low);
    ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.roundRect(-hw / 2, -hh / 2, hw, hh, 6); ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = accent;
    ctx.shadowColor = accent; ctx.shadowBlur = grabbed ? 10 : 4;
    ctx.beginPath(); ctx.roundRect(-hw / 2 + 5, -1.5, hw - 10, 3, 1.5); ctx.fill();
    ctx.restore();
    ctx.shadowBlur = 0;
    // pivot hub
    const hub = ctx.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, 11);
    hub.addColorStop(0, hi); hub.addColorStop(1, low);
    ctx.fillStyle = hub;
    ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  }
}
