// Time dial: a horizontal "altitude tape" with a detent every minute.
// Drag it, fling it (momentum), it settles on whole minutes with a spring.
import { reducedMotion } from "../spring.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class TimeDial {
  constructor(el, { min = 5, max = 180, value = 25, pxPerMin = 13, onChange, onDetent, onSettle, onGrab } = {}) {
    Object.assign(this, { el, min, max, value, pxPerMin, onChange, onDetent, onSettle, onGrab });
    this.canvas = document.createElement("canvas");
    el.append(this.canvas);
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", "Focus duration in minutes");
    el.setAttribute("aria-valuemin", min);
    el.setAttribute("aria-valuemax", max);
    this.velocity = 0;          // minutes per second
    this.mode = "idle";         // idle | drag | coast | snap | glide
    this.lastDetent = Math.round(value);
    this.samples = [];
    this.raf = 0;

    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.up(e));
    el.addEventListener("keydown", (e) => this.key(e));
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.setValue(Math.round(this.value) + Math.sign(e.deltaY || e.deltaX), { animate: true, user: true });
    }, { passive: false });

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.themeObserver = new MutationObserver(() => this.draw());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

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
    this.samples = [{ t: performance.now(), v: this.value }];
    this.velocity = 0;
    this.onGrab?.();
    this.loop();
  }

  move(e) {
    if (this.mode !== "drag") return;
    const dx = e.clientX - this.dragX;
    this.dragX = e.clientX;
    let next = this.value - dx / this.pxPerMin;
    // rubber-band past the ends
    if (next < this.min) next = this.value - (dx / this.pxPerMin) * 0.3 * Math.max(0, 1 - (this.min - this.value) / 6);
    if (next > this.max) next = this.value - (dx / this.pxPerMin) * 0.3 * Math.max(0, 1 - (this.value - this.max) / 6);
    this.value = next;
    const now = performance.now();
    this.samples.push({ t: now, v: this.value });
    while (this.samples.length > 2 && now - this.samples[0].t > 90) this.samples.shift();
    this.changed(true);
  }

  up() {
    if (this.mode !== "drag") return;
    const s = this.samples;
    const a = s[0], b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    this.velocity = dt > 0.008 ? (b.v - a.v) / dt : 0;
    if (performance.now() - b.t > 80) this.velocity = 0;
    this.mode = Math.abs(this.velocity) > 4 && !reducedMotion() ? "coast" : "snap";
    this.snapTarget = null;
    this.loop();
  }

  key(e) {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 15, PageDown: -15 }[e.key];
    if (e.key === "Home") this.setValue(this.min, { animate: true, user: true });
    else if (e.key === "End") this.setValue(this.max, { animate: true, user: true });
    else if (step) this.setValue(Math.round(this.value) + step, { animate: true, user: true });
    else return;
    e.preventDefault();
  }

  /** Programmatic value change (reverse pick). */
  setValue(v, { animate = true, user = false } = {}) {
    v = Math.max(this.min, Math.min(this.max, Math.round(v)));
    if (user) this.onGrab?.();
    if (!animate || reducedMotion()) {
      this.value = v; this.mode = "idle"; this.lastDetent = v;
      this.changed(false); this.onSettle?.(v); this.draw();
      return;
    }
    this.mode = "glide";
    this.glideFrom = this.value;
    this.glideTo = v;
    this.glideStart = performance.now();
    this.glideDur = Math.min(900, 260 + Math.abs(v - this.value) * 6);
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
        this.value += this.velocity * dt;
        this.velocity *= Math.exp(-3.2 * dt);
        if (this.value < this.min || this.value > this.max) this.velocity *= Math.exp(-18 * dt);
        this.changed(true);
        if (Math.abs(this.velocity) < 5) { this.mode = "snap"; this.snapTarget = null; }
        return true;
      }
      case "snap": {
        if (this.snapTarget == null) {
          const projected = this.value + this.velocity * 0.12;
          this.snapTarget = Math.max(this.min, Math.min(this.max, Math.round(projected)));
        }
        // critically damped approach to the detent
        const k = 220, c = 2 * Math.sqrt(k);
        const f = -k * (this.value - this.snapTarget) - c * this.velocity;
        this.velocity += f * dt;
        this.value += this.velocity * dt;
        this.changed(true);
        if (Math.abs(this.value - this.snapTarget) < 0.004 && Math.abs(this.velocity) < 0.05) {
          this.value = this.snapTarget; this.velocity = 0; this.mode = "idle";
          this.changed(false);
          this.onSettle?.(this.value);
          return false;
        }
        return true;
      }
      case "glide": {
        const p = Math.min(1, (t - this.glideStart) / this.glideDur);
        const e = 1 - Math.pow(1 - p, 3);
        this.value = this.glideFrom + (this.glideTo - this.glideFrom) * e;
        this.changed(false);
        if (p >= 1) {
          this.value = this.glideTo; this.mode = "idle"; this.lastDetent = this.value;
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
    const r = Math.max(this.min, Math.min(this.max, Math.round(this.value)));
    if (r !== this.lastDetent) {
      this.lastDetent = r;
      if (detents) this.onDetent?.(r);
    }
    this.el.setAttribute("aria-valuenow", r);
    this.el.setAttribute("aria-valuetext", `${r} minutes`);
    this.onChange?.(Math.max(this.min, Math.min(this.max, this.value)));
  }

  /* ---------- drawing ---------- */

  draw() {
    const ctx = this.canvas.getContext("2d");
    const { dpr } = this;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const ppm = this.pxPerMin;
    const low = css("--text-low"), mid = css("--text-mid"), hi = css("--text-hi"), accent = css("--accent");
    const base = h - 10;

    const first = Math.floor(this.value - cx / ppm) - 1;
    const last = Math.ceil(this.value + cx / ppm) + 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let m = first; m <= last; m++) {
      if (m < this.min || m > this.max) continue;
      const x = cx + (m - this.value) * ppm;
      const major = m % 15 === 0, five = m % 5 === 0;
      const len = major ? 30 : five ? 20 : 11;
      const near = 1 - Math.min(1, Math.abs(x - cx) / (w * 0.5));
      ctx.globalAlpha = 0.35 + 0.65 * near;
      ctx.strokeStyle = major ? hi : five ? mid : low;
      ctx.lineWidth = major ? 2 : 1.25;
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.lineTo(x, base - len);
      ctx.stroke();
      if (major && Math.abs(x - cx) > 16) {
        ctx.globalAlpha *= Math.min(1, (Math.abs(x - cx) - 16) / 18);
        ctx.fillStyle = hi;
        ctx.font = `600 13px ${css("--font-mono")}`;
        const label = m < 60 ? `${m}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
        ctx.fillText(label, x, base - len - 7);
      }
    }
    // baseline
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = low;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(w, base + 0.5); ctx.stroke();

    // needle
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cx, base + 6); ctx.lineTo(cx, base - 44); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 7, base + 9); ctx.lineTo(cx + 7, base + 9); ctx.lineTo(cx, base + 1); ctx.closePath();
    ctx.fill();
  }
}
