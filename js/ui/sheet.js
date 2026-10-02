// Draggable bottom sheet with detents (phone portrait).
// Drag the grip or header; release and it springs to the nearest detent,
// carrying the flick's momentum (with a little overshoot, like a real object).
import { Spring, reducedMotion } from "../spring.js";
import { haptic } from "../haptics.js";

export class BottomSheet {
  /**
   * @param {HTMLElement} el      the sheet
   * @param {object} opts
   *   handles  — elements that start a drag
   *   detents  — () => array of visible heights in px, smallest first
   *   onChange — (visibleHeight) during drags and on settle
   */
  constructor(el, { handles, detents, onChange }) {
    Object.assign(this, { el, detents, onChange });
    this.index = 1;
    this.offset = 0;   // px pushed down from fully open
    this.spring = new Spring({ stiffness: 260, damping: 26, onUpdate: (v) => this.apply(v), onRest: () => this.onChange?.(this.visible) });
    for (const h of handles) h.addEventListener("pointerdown", (e) => this.down(e));
    addEventListener("pointermove", (e) => this.move(e));
    addEventListener("pointerup", (e) => this.up(e));
    addEventListener("pointercancel", (e) => this.up(e));
    new ResizeObserver(() => this.snap(this.index, false)).observe(document.documentElement);
  }

  get enabled() { return !(innerWidth > innerHeight && innerWidth >= 820); }
  get full() { return this.el.offsetHeight; }
  get visible() { return this.full - this.offset; }

  apply(offset) {
    this.offset = offset;
    this.el.style.setProperty("--sheet-offset", `${offset}px`);
    this.onChange?.(this.visible);
  }

  heights() { return this.detents().map((h) => Math.min(h, this.full)); }

  snap(index, animate = true, velocity = 0) {
    if (!this.enabled) { this.el.style.setProperty("--sheet-offset", "0px"); this.offset = 0; return; }
    const hs = this.heights();
    this.index = Math.max(0, Math.min(hs.length - 1, index));
    const target = this.full - hs[this.index];
    if (!animate || reducedMotion()) { this.spring.set(target); this.onChange?.(this.visible); return; }
    this.spring.set(this.offset);
    this.spring.to(target, velocity);
  }

  down(e) {
    if (!this.enabled || e.button > 0) return;
    if (e.target.closest("button, input, .dial")) return;
    this.drag = { y: e.clientY, start: this.offset, samples: [{ t: performance.now(), y: e.clientY }] };
    this.spring.set(this.offset);
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (!d.active && Math.abs(dy) < 6) return;
    d.active = true;
    const hs = this.heights();
    const min = this.full - hs[hs.length - 1], max = this.full - hs[0];
    let o = d.start + dy;
    // rubber band past the first and last detent
    if (o < min) o = min - (min - o) * 0.25;
    if (o > max) o = max + (o - max) * 0.25;
    this.apply(o);
    d.samples.push({ t: performance.now(), y: e.clientY });
    if (d.samples.length > 5) d.samples.shift();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.active) return;
    const a = d.samples[0], b = d.samples[d.samples.length - 1];
    const v = (b.y - a.y) / Math.max(0.016, (b.t - a.t) / 1000);   // px/s, positive = down
    const projected = this.offset + v * 0.18;
    const hs = this.heights();
    let best = 0, bd = Infinity;
    hs.forEach((h, i) => { const dist = Math.abs(this.full - h - projected); if (dist < bd) { bd = dist; best = i; } });
    if (best !== this.index) haptic("tap");
    this.snap(best, true, v);
  }
}
