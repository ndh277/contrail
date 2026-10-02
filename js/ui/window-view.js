// Window view: the sky outside the cabin window, rendered with WebGL — a fragment
// shader for the sky, cirrus and the far cloud deck, and on top of it a field of soft
// cloud puffs that drift past with real depth (near ones fast, far ones slow, now and
// then a wisp sweeps right past the glass). Sun, stars and colours follow the time.
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
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
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
    p.x += uTime * 0.49;                       // flight speed (matches the drifting puffs)
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

const PUFF_VERT = `
attribute vec3 aCenter;     // world position (x right, y up, z away from the window)
attribute vec2 aCorner;     // -1..1
attribute vec4 aInfo;       // half-width, half-height, atlas cell, opacity
uniform vec2 uRes;
uniform float uPitch;
uniform float uBank;
varying vec2 vUv;
varying float vAlpha;
varying float vDepth;
varying float vH;
void main() {
  vec3 p = aCenter + vec3(aCorner.x * aInfo.x, aCorner.y * aInfo.y, 0.0);
  vec2 uv = vec2(p.x / p.z, (p.y / p.z - uPitch)) / 1.05;      // the sky shader's projection
  float c = cos(uBank), s = sin(uBank);
  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
  gl_Position = vec4(uv.x * 2.0 * uRes.y / uRes.x, uv.y * 2.0, 0.0, 1.0);
  float cell = aInfo.z;
  vUv = (vec2(mod(cell, 2.0), floor(cell / 2.0)) + (aCorner * 0.5 + 0.5)) * 0.5;
  vH = aCorner.y * 0.5 + 0.5;
  vDepth = aCenter.z;
  // fade in from the haze far away, and out just before a puff reaches the glass
  vAlpha = aInfo.w * smoothstep(2.0, 6.0, aCenter.z) * (1.0 - smoothstep(110.0, 170.0, aCenter.z));
}`;

const PUFF_FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uSunCol;
uniform vec3 uHaze;
uniform float uSunSide;     // -1 sun to the left .. 1 to the right
uniform float uNight;
varying vec2 vUv;
varying float vAlpha;
varying float vDepth;
varying float vH;
void main() {
  vec4 t = texture2D(uTex, vUv);              // r = light (self-shadowed), a = density
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  // thin edges let the light through, so they read bright rather than outlined
  float light = clamp(t.r * 0.85 + vH * 0.2, 0.0, 1.0);
  vec3 col = mix(uShade, uLit, light);
  // silver lining on the thin edges facing the sun
  col += uSunCol * (1.0 - t.a) * 0.18 * max(0.0, 0.5 + uSunSide * (vUv.x - 0.25)) * (1.0 - uNight);
  col = mix(col, uHaze, (1.0 - exp(-vDepth * 0.0065)) * 0.85);
  gl_FragColor = vec4(col * a, a);            // premultiplied
}`;

/** Soft cloud puffs: four variants in a 2×2 atlas. r = lit side (self-shadowed), a = density. */
function puffAtlas(size = 256) {
  const N = size * 2;
  const data = new Uint8ClampedArray(N * N * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lat = new Float32Array(33 * 33).map(() => rnd());
  const vnoise = (x, y) => {
    const xi = Math.floor(x) & 31, yi = Math.floor(y) & 31, xf = x - Math.floor(x), yf = y - Math.floor(y);
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const g = (i, j) => lat[((j & 31) * 33) + (i & 31)];
    return (g(xi, yi) * (1 - sx) + g(xi + 1, yi) * sx) * (1 - sy) + (g(xi, yi + 1) * (1 - sx) + g(xi + 1, yi + 1) * sx) * sy;
  };
  const fbm = (x, y) => vnoise(x, y) * 0.5 + vnoise(x * 2.1 + 5, y * 2.1 + 3) * 0.28 + vnoise(x * 4.3 + 9, y * 4.3 + 1) * 0.15 + vnoise(x * 8.7, y * 8.7) * 0.07;
  for (let v = 0; v < 4; v++) {
    // a cauliflower of overlapping blobs, flatter at the base
    const blobs = Array.from({ length: 9 + v * 2 }, () => {
      const bx = 0.22 + rnd() * 0.56, by = 0.26 + rnd() * 0.3;
      return [bx, by, 0.12 + rnd() * 0.14 * (1 - Math.abs(bx - 0.5))];
    });
    const dens = (x, y) => {
      let d = 0;
      for (const [bx, by, r] of blobs) { const q = ((x - bx) ** 2 + ((y - by) * 1.15) ** 2) / (r * r); d += Math.exp(-q * 1.6); }
      // cauliflower edges: big lumps, then fine billows eating into the rim
      d *= 0.5 + 0.8 * fbm(x * 5 + v * 7, y * 5 + v * 3);
      d -= (fbm(x * 11 + v, y * 11 - v) - 0.45) * 0.26;
      d *= Math.min(1, Math.max(0, (0.92 - y) * 6)) * Math.min(1, Math.max(0, y * 9));
      d *= Math.min(1, Math.max(0, Math.min(x, 1 - x) * 7));
      const e = Math.max(0, Math.min(1, (d - 0.16) / 0.5));
      return e * e * (3 - 2 * e);
    };
    const ox = (v % 2) * size, oy = Math.floor(v / 2) * size;
    // shade the puff as a lumpy height field lit from above: bright tops, shadowed folds
    const D = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) D[y * size + x] = dens(x / size, 1 - y / size);
    const Lx = 0.35, Ly = 0.62, Lz = 0.7;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = (xx, yy) => D[Math.min(size - 1, Math.max(0, yy)) * size + Math.min(size - 1, Math.max(0, xx))];
        const d = at(x, y);
        const gx = (at(x + 2, y) - at(x - 2, y)) * 9, gy = (at(x, y - 2) - at(x, y + 2)) * 9;   // +y = up
        const nl = Math.hypot(gx, gy, 1);
        const lam = Math.max(0, (-gx * Lx - gy * Ly + Lz) / nl);
        const i = ((oy + y) * N + ox + x) * 4;
        data[i] = Math.round(255 * Math.min(1, 0.25 + 0.85 * lam));
        data[i + 1] = data[i + 2] = 0;
        data[i + 3] = Math.round(255 * d);
      }
    }
  }
  return { data, N };
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
    this.initGL();
    this.initPuffs();
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
    for (const n of ["uRes", "uTime", "uSunElev", "uSunAz", "uBank", "uPitch", "uNight", "uCover", "uZenith", "uHorizon", "uSunCol", "uCloudLit", "uCloudShade", "uGround"]) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
  }

  /* ---------- cloud puffs ---------- */

  initPuffs() {
    const gl = this.gl;
    if (!gl) return;
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(x)); return x; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, PUFF_VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, PUFF_FRAG));
    gl.linkProgram(prog);
    this.puffProg = prog;
    this.pu = {};
    for (const n of ["uRes", "uPitch", "uBank", "uTex", "uLit", "uShade", "uSunCol", "uHaze", "uSunSide", "uNight"]) this.pu[n] = gl.getUniformLocation(prog, n);
    this.pa = { center: gl.getAttribLocation(prog, "aCenter"), corner: gl.getAttribLocation(prog, "aCorner"), info: gl.getAttribLocation(prog, "aInfo") };
    const { data, N } = puffAtlas();
    this.puffTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.puffTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // the field: a deck of puffs below, and a few wisps at our own height
    this.puffs = [];
    for (let i = 0; i < 64; i++) this.puffs.push(this.spawn({ deck: true }, true));
    for (let i = 0; i < 5; i++) this.puffs.push(this.spawn({ deck: false }, true));
    this.puffBuf = gl.createBuffer();
    this.puffData = new Float32Array(this.puffs.length * 6 * 9);
  }

  /** A new puff, just beyond the right-hand edge of the view (or anywhere at start). */
  spawn(kind, anywhere = false) {
    const r = Math.random;
    let z, y, w;
    if (kind.deck) {
      z = 9 + Math.pow(r(), 1.4) * 150;
      y = -6 - r() * 1.6 + (this.coverY || 0);
      w = 3.5 + r() * 5 + z * 0.02;
    } else {
      z = 3 + r() * 14;
      y = -1.6 + r() * 2.4;
      w = 2.5 + r() * 4;
    }
    const xr = z * 0.42 + w;                 // half the visible width at that depth, plus the puff
    return {
      deck: kind.deck, z, y, w, h: w * (kind.deck ? 0.5 + r() * 0.2 : 0.35 + r() * 0.2),
      x: anywhere ? (r() * 2 - 1) * xr * 1.3 : xr * (1 + r() * 0.5),
      cell: Math.floor(r() * 4), a: kind.deck ? 0.9 + r() * 0.1 : 0.16 + r() * 0.2, xr,
    };
  }

  drawPuffs(dt, bank, pitch) {
    const gl = this.gl;
    if (!this.puffProg) return;
    const v = reducedMotion() ? 0 : 3.2;     // world units per second; parallax does the rest
    for (let i = 0; i < this.puffs.length; i++) {
      const p = this.puffs[i];
      p.x -= v * dt;
      if (p.x < -p.xr * 1.15) this.puffs[i] = this.spawn(p);
    }
    this.puffs.sort((a, b) => b.z - a.z);    // far to near
    const d = this.puffData;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    let o = 0;
    for (const p of this.puffs) {
      for (const [cx, cy] of corners) {
        d[o++] = p.x; d[o++] = p.y; d[o++] = p.z;
        d[o++] = cx; d[o++] = cy;
        d[o++] = p.w; d[o++] = p.h; d[o++] = p.cell; d[o++] = p.a;
      }
    }
    gl.useProgram(this.puffProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.puffBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    const st = 9 * 4, a = this.pa;
    gl.enableVertexAttribArray(a.center); gl.vertexAttribPointer(a.center, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(a.corner); gl.vertexAttribPointer(a.corner, 2, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(a.info); gl.vertexAttribPointer(a.info, 4, gl.FLOAT, false, st, 20);
    const u = this.pu, L = this.look;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uPitch, pitch);
    gl.uniform1f(u.uBank, bank);
    gl.uniform3fv(u.uLit, L.cloudLit);
    gl.uniform3fv(u.uShade, L.cloudShade);
    gl.uniform3fv(u.uSunCol, L.sun);
    gl.uniform3fv(u.uHaze, L.horizon);
    gl.uniform1f(u.uSunSide, Math.sin(this.sunAz || 0));
    gl.uniform1f(u.uNight, L.night);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.puffTex);
    gl.uniform1i(u.uTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.puffs.length * 6);
    gl.disable(gl.BLEND);
    // hand the state back to the sky pass
    gl.disableVertexAttribArray(a.corner); gl.disableVertexAttribArray(a.info);
    gl.useProgram(this.skyProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.enableVertexAttribArray(this.skyLoc);
    gl.vertexAttribPointer(this.skyLoc, 2, gl.FLOAT, false, 0, 0);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);    // soft sky and clouds need few pixels
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
    this.drawPuffs(dt, bank, pitch);
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
