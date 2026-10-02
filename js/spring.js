// Tiny damped-spring integrator for physical objects (stubs, tags, stamps).
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Spring {
  constructor({ value = 0, stiffness = 170, damping = 14, mass = 1, onUpdate, onRest } = {}) {
    Object.assign(this, { value, target: value, velocity: 0, stiffness, damping, mass, onUpdate, onRest });
    this.raf = 0;
    this.lastT = 0;
  }

  set(value) {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.value = this.target = value; this.velocity = 0;
    this.onUpdate?.(value);
  }

  to(target, velocity) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (reducedMotion()) { this.set(target); this.onRest?.(target); return; }
    if (!this.raf) { this.lastT = performance.now(); this.raf = requestAnimationFrame((t) => this.step(t)); }
  }

  /** Give the spring a kick without moving the target. */
  impulse(v) { this.to(this.target, this.velocity + v); }

  step(t) {
    let dt = Math.min(0.064, (t - this.lastT) / 1000);
    this.lastT = t;
    // sub-step for stability at high stiffness
    const n = Math.ceil(dt / 0.008); dt /= n;
    for (let i = 0; i < n; i++) {
      const f = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += (f / this.mass) * dt;
      this.value += this.velocity * dt;
    }
    this.onUpdate?.(this.value);
    if (Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001) {
      this.value = this.target; this.velocity = 0; this.raf = 0;
      this.onUpdate?.(this.value); this.onRest?.(this.value);
      return;
    }
    this.raf = requestAnimationFrame((tt) => this.step(tt));
  }
}
