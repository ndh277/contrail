// Window view: the sky outside the cabin window, rendered with WebGL. A slab of
// cumulus is ray-marched through 3D noise (lit by the real sun for the plane's
// position and time), with the sea or land showing through the gaps, haze toward
// the horizon, cirrus above and stars at night. The buffer is drawn at reduced
// resolution and adapts to the device, so it stays smooth and cool.
// The view banks and pitches a little with the phone's gyroscope; the shade inside
// the window frame can be dragged down by hand.
import { subsolarPoint } from "../geo.js";
import { sunElevation, look } from "../globe/skylook.js";

export { sunElevation };
import { reducedMotion } from "../spring.js";
import { haptic } from "../haptics.js";

const RAD = Math.PI / 180;

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

// A slab of cumulus seen from cruise altitude, ray-marched through 3D noise.
// The noise comes from a small 2D texture (two channels offset so a z-slice is a
// single lookup), which keeps each step cheap enough for a phone.
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
uniform sampler2D uNoise;

#define STEPS 44
const float CAM_H = 2.6;     // camera height above the cloud base (slab is 0..1)
const float TOP = 1.05;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (p.xy + vec2(37.0, 239.0) * p.z) + f.xy;
  vec2 rg = texture2D(uNoise, (uv + 0.5) / 256.0).yx;
  return mix(rg.x, rg.y, f.z);
}
float noise2(vec2 x) { return noise(vec3(x, 0.5)); }

// the flight: the cloud field slides past (+x), and slowly boils
vec3 flow(vec3 p) { return p * vec3(0.55, 1.6, 0.55) + vec3(uTime * 0.42, 0.0, uTime * 0.03); }

float density(vec3 p) {
  vec3 q = flow(p);
  float f = 0.5 * noise(q); q = q * 2.03 + vec3(1.7, 0.0, 3.1);
  f += 0.25 * noise(q);     q = q * 2.01 + vec3(4.2, 0.0, 1.3);
  f += 0.125 * noise(q);    q = q * 2.05;
  f += 0.0625 * noise(q);
  float y = p.y;
  float d = (f - uCover) * 5.0 - y * 1.6 + 0.35;
  return clamp(d, 0.0, 1.0) * smoothstep(0.0, 0.12, y) * (1.0 - smoothstep(TOP - 0.15, TOP, y));
}
float densityLow(vec3 p) {
  vec3 q = flow(p);
  float f = 0.5 * noise(q); q = q * 2.03 + vec3(1.7, 0.0, 3.1);
  f += 0.25 * noise(q);
  return clamp((f + 0.12 - uCover) * 5.0 - p.y * 1.6 + 0.35, 0.0, 1.0);
}

vec3 skyColor(vec3 rd, vec3 sunDir) {
  float h = clamp(rd.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(h, 0.45));
  float sd = max(dot(rd, sunDir), 0.0);
  sky += uSunCol * (pow(sd, 5.0) * 0.18 + pow(sd, 64.0) * 0.5) * (1.0 - uNight * 0.85);
  sky += uSunCol * smoothstep(0.9994, 0.9998, sd) * 4.0 * step(-0.02, sunDir.y);
  if (uNight > 0.01 && rd.y > 0.0) {
    vec2 sp = rd.xy / max(rd.z, 0.2) * 260.0;
    vec2 cell = floor(sp);
    float st = step(0.987, hash(cell));
    float tw = 0.7 + 0.3 * sin(uTime * (1.0 + hash(cell + 3.1) * 2.0) + hash(cell) * 40.0);
    float d = length(fract(sp) - 0.5);
    sky += vec3(0.85, 0.9, 1.0) * st * tw * smoothstep(0.2, 0.0, d) * uNight * smoothstep(0.0, 0.12, rd.y);
  }
  // thin cirrus far above
  if (rd.y > 0.0) {
    vec2 cp = rd.xz / rd.y * 1.6 + vec2(uTime * 0.01, 0.0);
    float ci = noise2(cp * vec2(0.5, 1.4)) * 0.55 + noise2(cp * vec2(1.4, 3.5)) * 0.3 + noise2(cp * vec2(4.0, 9.0)) * 0.15;
    float m = smoothstep(0.6, 0.95, ci) * smoothstep(0.02, 0.25, rd.y) * 0.22;
    sky = mix(sky, mix(uCloudShade, uCloudLit, 0.85), m * (1.0 - uNight * 0.7));
  }
  return sky;
}

vec3 groundColor(vec3 rd, vec3 sunDir, float t) {
  vec3 p = vec3(0.0, CAM_H, 0.0) + rd * t;
  vec2 g = (p.xz + vec2(uTime * 0.42 / 0.55, 0.0)) * 0.12;      // moves with the clouds
  float n = noise2(g * 3.0) * 0.6 + noise2(g * 9.0) * 0.3 + noise2(g * 27.0) * 0.1;
  float land = smoothstep(0.52, 0.6, noise2(g * 0.8 + 11.0));
  vec3 sea = uGround * vec3(0.55, 0.8, 1.15) * (0.85 + 0.3 * n);
  vec3 earth = uGround * vec3(1.05, 1.0, 0.75) * (0.7 + 0.6 * n);
  vec3 col = mix(sea, earth, land);
  // sun glitter on the sea
  vec3 refl = reflect(rd, vec3(0.0, 1.0, 0.0));
  col += uSunCol * pow(max(dot(refl, sunDir), 0.0), 60.0) * 0.6 * (1.0 - land) * (1.0 - uNight);
  // town lights at night
  float towns = step(0.93, noise2(g * 40.0)) * land * uNight;
  col += vec3(1.0, 0.72, 0.38) * towns * 0.8;
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float c = cos(uBank), s = sin(uBank);
  uv = mat2(c, -s, s, c) * uv;
  vec3 rd = normalize(vec3(uv.x * 1.05, uv.y * 1.05 + uPitch, 1.0));
  vec3 sunDir = normalize(vec3(sin(uSunAz) * cos(uSunElev), sin(uSunElev), cos(uSunAz) * cos(uSunElev)));
  vec3 ro = vec3(0.0, CAM_H, 0.0);
  vec3 sky = skyColor(rd, sunDir);
  vec3 haze = mix(uHorizon, uCloudLit, 0.25) * (1.0 - uNight * 0.6);

  vec3 col = sky;
  if (rd.y < -0.004) {
    // march only inside the slab of cloud
    float t0 = (TOP - CAM_H) / rd.y;
    float t1 = min((0.0 - CAM_H) / rd.y, 90.0);
    float tg = (-0.35 - CAM_H) / rd.y;                  // the ground, a little below the cloud base
    float dt = (t1 - t0) / float(STEPS);
    float t = t0 + dt * hash(gl_FragCoord.xy + fract(uTime));
    vec4 sum = vec4(0.0);
    for (int i = 0; i < STEPS; i++) {
      if (sum.a > 0.97) break;
      vec3 p = ro + rd * t;
      float d = density(p);
      if (d > 0.01) {
        float dl = densityLow(p + sunDir * 0.22 + vec3(0.0, 0.08, 0.0));
        float lit = clamp(1.0 - (dl - d * 0.25) * 2.2, 0.0, 1.0);
        lit = lit * lit;
        float amb = 0.5 + 0.5 * smoothstep(0.0, TOP * 0.8, p.y);           // tops bright, bases grey
        vec3 cc = mix(uCloudShade * amb, uCloudLit, lit * (0.45 + 0.55 * clamp(sunDir.y * 2.0 + 0.3, 0.0, 1.0)) * (0.6 + 0.4 * amb));
        cc += uSunCol * pow(max(dot(rd, sunDir), 0.0), 3.0) * 0.35 * (1.0 - d) * (1.0 - uNight);   // silver lining
        cc = mix(cc, haze, 1.0 - exp(-t * 0.028));
        float a = 1.0 - exp(-d * dt * 7.0);
        sum += vec4(cc * a, a) * (1.0 - sum.a);
      }
      t += dt;
    }
    vec3 ground = groundColor(rd, sunDir, tg);
    ground = mix(ground, haze, 1.0 - exp(-tg * 0.035));
    vec3 below = mix(ground, sky, smoothstep(-0.03, 0.0, rd.y));
    col = sum.rgb + below * (1.0 - sum.a);
    // the horizon melts into haze
    col = mix(col, haze, smoothstep(-0.06, -0.004, rd.y) * 0.6);
  }

  col = col / (1.0 + col * 0.15);
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

/** 256² noise for 3D lookups: G is R shifted by (37, 239) so one fetch spans two z-slices. */
function noiseTexture() {
  const N = 256, r = new Uint8Array(N * N);
  let seed = 1234567;
  for (let i = 0; i < r.length; i++) { seed = (seed * 16807) % 2147483647; r[i] = seed & 255; }
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    data[i] = r[y * N + x];
    data[i + 1] = r[((y - 239) & 255) * N + ((x - 37) & 255)];
    data[i + 3] = 255;
  }
  return data;
}

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
    this.scale = 0.6;            // render scale vs CSS pixels; adapts to the device
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
    this.skyProg = prog; this.skyBuf = buf; this.skyLoc = loc;
    this.gl = gl;
    this.u = {};
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    for (const n of ["uRes", "uTime", "uSunElev", "uSunAz", "uBank", "uPitch", "uNight", "uCover", "uZenith", "uHorizon", "uSunCol", "uCloudLit", "uCloudShade", "uGround", "uNoise"]) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    // clouds are soft: a reduced buffer, scaled up by the browser, looks the same and costs a fraction
    this.canvas.width = Math.max(64, Math.round(r.width * this.scale));
    this.canvas.height = Math.max(64, Math.round(r.height * this.scale));
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Keep the march on time: shrink the buffer when frames run late, grow it back when there's room. */
  adapt(dt) {
    this.ema = this.ema ? this.ema * 0.9 + dt * 0.1 : dt;
    const now = performance.now();
    if (now - (this.lastAdapt || 0) < 1500) return;
    const max = Math.min(1, (window.devicePixelRatio || 1) * 0.5);
    if (this.ema > 0.024 && this.scale > 0.34) { this.scale = Math.max(0.34, this.scale * 0.85); this.lastAdapt = now; this.resize(); }
    else if (this.ema < 0.0175 && this.scale < max && now - (this.lastAdapt || 0) > 5000) { this.scale = Math.min(max, this.scale * 1.12); this.lastAdapt = now; this.resize(); }
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
    // 60 fps is plenty for drifting clouds (a 120 Hz screen would double the heat)
    this.acc = (this.acc || 0) + dt;
    if (this.acc < 1 / 62) return;
    dt = this.acc; this.acc = 0;
    if (this.shade >= 0.999) return;                    // nothing to see behind a closed shade
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
      this.cover = 0.47 + 0.07 * Math.sin(lat * 0.07 + lng * 0.05);   // cloudiness varies along the route
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
    this.setVars(`${(bank / RAD).toFixed(1)}deg`, `${(this.tilt.x * 0.25).toFixed(1)}px`);

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
    gl.uniform1i(u.uNoise, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.adapt(dt);
  }

  /** CSS variables for the wing and bezel, written only when they change (no restyle per frame). */
  setVars(bank, parallax) {
    if (bank !== this.lastBank) { this.lastBank = bank; this.root.style.setProperty("--bank", bank); }
    if (parallax !== this.lastPar) { this.lastPar = parallax; this.root.style.setProperty("--parallax", parallax); }
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
