// Window view: the sky outside the cabin window, rendered with a small WebGL
// fragment shader — a sea of clouds below, cirrus above, the sun, stars at night.
// Lighting follows the sun's real elevation at the plane's position; the view
// banks and pitches a little with the phone's gyroscope. The shade inside the
// window frame can be dragged down by hand.
import { subsolarPoint } from "../geo.js";
import { sunElevation, look } from "../globe/skylook.js";

export { sunElevation };
import { reducedMotion } from "../spring.js";
import { haptic } from "../haptics.js";

const RAD = Math.PI / 180;

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uSunElev;
uniform float uSunAz;
uniform float uBank;
uniform float uPitch;
uniform float uNight;
uniform float uCover;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunCol;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec3 uGround;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++) { v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float c = cos(uBank), s = sin(uBank);
  uv = mat2(c, -s, s, c) * uv;
  vec3 dir = normalize(vec3(uv.x * 1.05, uv.y * 1.05 + uPitch, 1.0));
  vec3 sunDir = normalize(vec3(sin(uSunAz) * cos(uSunElev), sin(uSunElev), cos(uSunAz) * cos(uSunElev)));
  float sd = max(dot(dir, sunDir), 0.0);

  // sky: zenith -> horizon, with a forward-scattering glow around the sun
  float h = clamp(dir.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(h, 0.42));
  sky += uSunCol * (pow(sd, 6.0) * 0.22 + pow(sd, 48.0) * 0.45) * (1.0 - uNight * 0.85);
  sky += uSunCol * smoothstep(0.99955, 0.99985, sd) * 3.0 * step(-0.02, sunDir.y);
  if (uNight > 0.01 && dir.y > 0.0) {
    vec2 sp = dir.xy / dir.z * 220.0;
    vec2 cell = floor(sp);
    float st = step(0.985, hash(cell));
    float tw = 0.6 + 0.4 * sin(uTime * (1.0 + hash(cell + 3.1) * 3.0) + hash(cell) * 40.0);
    float d = length(fract(sp) - 0.5);
    sky += vec3(0.85, 0.9, 1.0) * st * tw * smoothstep(0.18, 0.0, d) * uNight * smoothstep(0.0, 0.15, dir.y);
  }
  vec3 col = sky;

  // high, thin cirrus streaks
  if (dir.y > 0.0) {
    float t = 2.4 / dir.y;
    vec2 p = dir.xz * t;
    p.x += uTime * 0.012;
    float ci = fbm(p * vec2(0.09, 0.6));
    float m = smoothstep(0.52, 0.86, ci) * smoothstep(0.0, 0.12, dir.y) * exp(-t * 0.02);
    col = mix(col, mix(uCloudShade, uCloudLit, 0.8) + uSunCol * pow(sd, 6.0) * 0.3, m * 0.4);
  }

  // the cloud deck below the plane
  if (dir.y < 0.02) {
    float dy = min(dir.y, -0.0005);
    float t = 1.0 / -dy;
    vec2 p = dir.xz * t;
    p.x += uTime * 0.075;                      // flight speed
    float d = fbm(p * 0.42);
    float cov = smoothstep(uCover, uCover + 0.22, d);
    float d2 = fbm((p + sunDir.xz * 0.35) * 0.42);
    float lit = clamp(0.52 + (d - d2) * 3.0 + sunDir.y * 0.25, 0.0, 1.0);
    vec3 cloud = mix(uCloudShade, uCloudLit, lit);
    cloud += uSunCol * pow(sd, 3.0) * 0.18 * cov;                       // silver lining toward the sun
    vec3 ground = uGround * (0.75 + 0.5 * noise(p * 0.08));
    vec3 surf = mix(ground, cloud, cov);
    float fog = 1.0 - exp(-t * 0.055);
    col = mix(surf, uHorizon, fog);
    col = mix(col, sky, smoothstep(-0.004, 0.02, dir.y));
  }

  // soft filmic curve + tiny grain so gradients never band
  col = col / (1.0 + col * 0.18);
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export class WindowView {
  constructor(root, { onShadeClosed } = {}) {
    this.root = root;
    this.onShadeClosed = onShadeClosed;
    this.canvas = root.querySelector(".sky-canvas");
    this.shadeEl = root.querySelector(".window-shade");
    this.shade = 0;
    this.tilt = { x: 0, y: 0 };
    this.target = { x: 0, y: 0 };
    this.time = Math.random() * 100;
    this.active = false;
    this.onOrient = (e) => {
      if (e.gamma == null) return;
      this.target.x = Math.max(-35, Math.min(35, e.gamma));
      this.target.y = Math.max(-30, Math.min(30, (e.beta ?? 60) - 60));
    };
    this.initGL();
    this.setupShade();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  initGL() {
    const gl = this.canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) { this.root.classList.add("no-gl"); return; }
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.gl = gl;
    this.u = {};
    for (const n of ["uRes", "uTime", "uSunElev", "uSunAz", "uBank", "uPitch", "uNight", "uCover", "uZenith", "uHorizon", "uSunCol", "uCloudLit", "uCloudShade", "uGround"]) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  show(on) {
    this.active = on;
    if (on) { addEventListener("deviceorientation", this.onOrient); this.resize(); }
    else removeEventListener("deviceorientation", this.onOrient);
  }

  /** Called every frame while visible. heading = degrees the plane is flying toward. */
  frame(dt, lat, lng, date, heading = 90) {
    if (!this.active) return;
    if (this.external) { this.tiltOnly(dt, lat, lng, date); return; }
    if (!this.gl) return;
    if (!this.look || date - this.lastLook > 4000) {
      this.lastLook = date;
      const elev = sunElevation(lat, lng, new Date(date));
      const s = subsolarPoint(new Date(date));
      // sun azimuth seen from the plane, relative to the left-hand window (which faces heading − 90°)
      const y = Math.sin((s.lng - lng) * RAD) * Math.cos(s.lat * RAD);
      const x = Math.cos(lat * RAD) * Math.sin(s.lat * RAD) - Math.sin(lat * RAD) * Math.cos(s.lat * RAD) * Math.cos((s.lng - lng) * RAD);
      const az = Math.atan2(y, x) / RAD;
      this.sunAz = (((az - (heading - 90)) + 540) % 360 - 180) * RAD;
      this.elev = elev;
      this.look = look(elev);
      this.cover = 0.42 + 0.12 * Math.sin(lat * 0.07 + lng * 0.05);   // cloudiness varies along the route
      const st = this.root.style;
      st.setProperty("--day", this.look.day.toFixed(3));
      st.setProperty("--sky-tint", `rgb(${this.look.horizon.map((v) => Math.round(v * 255)).join(",")})`);
    }
    const still = reducedMotion();
    this.time += dt * (still ? 0 : 1);
    const k = 1 - Math.exp(-3 * dt);
    this.tilt.x += (this.target.x - this.tilt.x) * k;
    this.tilt.y += (this.target.y - this.tilt.y) * k;
    const bank = -this.tilt.x * 0.006 + Math.sin(this.time * 0.21) * 0.012;
    const pitch = -0.2 + this.tilt.y * 0.004 + Math.sin(this.time * 0.13) * 0.006;
    this.root.style.setProperty("--bank", `${(bank / RAD).toFixed(2)}deg`);
    this.root.style.setProperty("--parallax", `${(this.tilt.x * 0.25).toFixed(1)}px`);

    const gl = this.gl, u = this.u, L = this.look;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uSunElev, Math.max(-0.3, this.elev * RAD));
    gl.uniform1f(u.uSunAz, this.sunAz);
    gl.uniform1f(u.uBank, bank);
    gl.uniform1f(u.uPitch, pitch);
    gl.uniform1f(u.uNight, L.night);
    gl.uniform1f(u.uCover, this.cover);
    gl.uniform3fv(u.uZenith, L.zenith);
    gl.uniform3fv(u.uHorizon, L.horizon);
    gl.uniform3fv(u.uSunCol, L.sun);
    gl.uniform3fv(u.uCloudLit, L.cloudLit);
    gl.uniform3fv(u.uCloudShade, L.cloudShade);
    gl.uniform3fv(u.uGround, L.ground);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** When the 3D globe renders the view itself: keep the lighting vars, wing parallax and tilt. */
  tiltOnly(dt, lat, lng, date) {
    if (!this.look || date - this.lastLook > 4000) {
      this.lastLook = date;
      this.look = look(sunElevation(lat, lng, new Date(date)));
      this.root.style.setProperty("--day", this.look.day.toFixed(3));
      this.root.style.setProperty("--sky-tint", `rgb(${this.look.horizon.map((v) => Math.round(v * 255)).join(",")})`);
    }
    const k = 1 - Math.exp(-3 * dt);
    this.tilt.x += (this.target.x - this.tilt.x) * k;
    this.tilt.y += (this.target.y - this.tilt.y) * k;
    this.root.style.setProperty("--bank", `${(-this.tilt.x * 0.35).toFixed(2)}deg`);
    this.root.style.setProperty("--parallax", `${(this.tilt.x * 0.25).toFixed(1)}px`);
  }

  setExternal(on) {
    this.external = on;
    this.root.classList.toggle("is-external", on);
    this.lastLook = 0;
  }

  /* ---------- the shade inside the frame ---------- */

  setShade(v, animate = false) {
    this.shade = Math.max(0, Math.min(1, v));
    this.shadeEl.style.transition = animate ? "height 0.7s cubic-bezier(.32,.72,0,1)" : "none";
    this.root.style.setProperty("--shade", this.shade.toFixed(3));
    this.shadeEl.setAttribute("aria-valuenow", Math.round(this.shade * 100));
  }

  setupShade() {
    const el = this.shadeEl;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", "Window shade");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    const pane = el.parentElement;
    let start = null;
    const down = (e) => {
      start = { y: e.clientY, v: this.shade, h: pane.clientHeight };
      pane.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!start) return;
      this.setShade(start.v + (e.clientY - start.y) / start.h);
    };
    const up = () => {
      if (!start) return;
      start = null;
      if (this.shade > 0.86) {
        this.setShade(1, true);
        haptic("tap");
        setTimeout(() => this.onShadeClosed?.(), 650);
      } else if (this.shade < 0.06) this.setShade(0, true);
    };
    pane.addEventListener("pointerdown", down);
    pane.addEventListener("pointermove", move);
    pane.addEventListener("pointerup", up);
    pane.addEventListener("pointercancel", up);
    el.addEventListener("keydown", (e) => {
      const d = { ArrowDown: 0.1, ArrowUp: -0.1 }[e.key];
      if (!d) return;
      e.preventDefault();
      this.setShade(this.shade + d, true);
      if (this.shade >= 1) setTimeout(() => this.onShadeClosed?.(), 650);
    });
    this.setShade(0);
  }
}
