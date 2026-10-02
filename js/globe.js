// The 3D globe: globe.gl (bundled three.js) + our own layers:
//   - day/night shader blending Blue Marble and Black Marble along the real terminator
//   - radar ring (a shader on a shell around the globe — no geometry rebuilds)
//   - airport points that pop as the ring reaches them
//   - route line, plane and contrail for take-off / in-flight
import * as THREE from "../vendor/three.core-0.185.1.min.js";
import { subsolarPoint, interpolateGC, haversineKm, EARTH_RADIUS_KM } from "./geo.js";
import { QUALITY, qualityTier } from "./settings.js";

export { THREE };

const dayNightVertex = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const dayNightFragment = /* glsl */ `
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec3 sunDirection;
  uniform float cityLights;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float cosSun = dot(n, sunDirection);
    vec3 day = texture2D(dayTexture, vUv).rgb;
    vec3 night = texture2D(nightTexture, vUv).rgb;

    // soft daylight shading, never fully flat
    float shade = 0.55 + 0.6 * clamp(cosSun, 0.0, 1.0);
    vec3 dayLit = day * shade;

    // city lights: lift the bright pixels, keep the oceans deep blue-black
    float lum = dot(night, vec3(0.299, 0.587, 0.114));
    vec3 nightLit = night * cityLights * (0.6 + 0.8 * smoothstep(0.15, 0.6, lum))
                  + vec3(0.010, 0.016, 0.032);

    // civil-twilight width ~6 degrees each side
    float blend = smoothstep(-0.1, 0.1, cosSun);
    vec3 color = mix(nightLit, dayLit, blend);

    // a warm band hugging the terminator
    float band = exp(-pow(cosSun / 0.07, 2.0));
    color += vec3(1.0, 0.52, 0.22) * band * 0.10;

    // sun glint on open water (water = blue-dominant pixels of the day map)
    float water = smoothstep(0.04, 0.16, day.b - max(day.r, day.g) * 0.95);
    vec3 halfV = normalize(sunDirection + viewDir);
    float spec = pow(max(dot(n, halfV), 0.0), 70.0) * 0.55 + pow(max(dot(n, halfV), 0.0), 12.0) * 0.06;
    color += vec3(1.0, 0.93, 0.8) * spec * water * smoothstep(0.0, 0.2, cosSun);

    // thin blue haze towards the limb on the day side
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
    color = mix(color, vec3(0.45, 0.65, 1.0), rim * 0.45 * smoothstep(-0.15, 0.4, cosSun));

    gl_FragColor = vec4(color, 1.0);
  }
`;

const radarVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const radarFragment = /* glsl */ `
  uniform vec3 uHome;
  uniform vec3 uEast;
  uniform vec3 uNorth;
  uniform float uAngle;     // ring radius (radians of arc)
  uniform float uRingStep;  // spacing of the faint inner rings (radians)
  uniform float uSweep;     // sweep beam azimuth (radians)
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float c = clamp(dot(d, uHome), -1.0, 1.0);
    float a = acos(c);
    float px = max(fwidth(a), 1e-5);
    float outside = a - uAngle;
    if (outside > px * 14.0) discard;
    float inside = step(a, uAngle);

    float edge = 1.0 - smoothstep(px * 0.8, px * 2.2, abs(outside));
    float glow = exp(-abs(outside) / (px * 7.0)) * 0.4;
    float rel = a / max(uAngle, 1e-5);
    float fill = inside * (0.035 + 0.11 * rel * rel * rel);

    float ringPos = abs(fract(a / uRingStep + 0.5) - 0.5) * uRingStep;
    float rings = inside * (1.0 - smoothstep(px * 0.4, px * 1.4, ringPos)) * 0.22 * step(px * 3.0, uAngle - a);

    vec3 t = d - uHome * c;
    float az = atan(dot(t, uNorth), dot(t, uEast));
    float lag = mod(uSweep - az, 6.2831853);
    float sweep = inside * exp(-lag * 2.6) * 0.22 * smoothstep(0.0, 0.25, rel);

    float alpha = (edge * 0.95 + glow + fill + rings + sweep) * uOpacity;
    gl_FragColor = vec4(uColor * (1.0 + edge * 0.35), alpha);
  }
`;

const pointsVertex = /* glsl */ `
  attribute float aDist;
  attribute float aLarge;
  attribute float aVisited;
  uniform float uRange;
  uniform float uPopWidth;
  uniform float uPx;
  uniform float uScale;
  varying float vLit;
  varying float vPop;
  varying float vFace;
  varying float vVisited;
  void main() {
    vVisited = aVisited;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float hidden = step(aDist, -0.5);
    float lit = step(aDist, uRange);
    float k = (uRange - aDist) / uPopWidth;
    float pop = lit * exp(-k * 1.6);
    float base = mix(3.6, 5.6, aLarge) * mix(0.75, 1.0, lit) * mix(1.35, 1.0, aVisited);
    gl_PointSize = (1.0 - hidden) * base * (1.0 + 1.4 * pop) * uPx * uScale;
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vFace = smoothstep(0.02, 0.3, dot(normalize(wp), normalize(cameraPosition - wp)));
    vLit = lit;
    vPop = pop;
  }
`;

const pointsFragment = /* glsl */ `
  uniform vec3 uLit;
  uniform vec3 uDim;
  uniform vec3 uFlash;
  varying float vLit;
  varying float vPop;
  varying float vFace;
  varying float vVisited;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p);
    if (r > 0.5) discard;
    // visited cities are filled; the rest are a dashed outline waiting to be unlocked
    float filled = 1.0 - smoothstep(0.32, 0.5, r);
    float ring = smoothstep(0.24, 0.31, r) * (1.0 - smoothstep(0.42, 0.5, r));
    float dash = smoothstep(-0.25, 0.25, sin(atan(p.y, p.x) * 6.0));
    float disc = mix(ring * (0.35 + 0.65 * dash), filled, vVisited);
    vec3 col = mix(uDim, mix(uLit, uFlash, vPop), vLit);
    float alpha = disc * mix(0.45, 1.0, vLit) * vFace;
    gl_FragColor = vec4(col, alpha);
  }
`;

const trailVertex = /* glsl */ `
  attribute float aAlpha;
  attribute float aSide;
  attribute float aU;
  varying float vAlpha;
  varying float vSide;
  varying float vU;
  void main() {
    vAlpha = aAlpha;
    vSide = aSide;
    vU = aU;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const trailFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vSide;
  varying float vU;
  void main() {
    // two engine trails that spread and merge into one soft band as they age
    float sep = 0.62 * smoothstep(0.45, 1.0, vU);
    float w = mix(0.55, 0.2, smoothstep(0.4, 1.0, vU));
    float a1 = exp(-pow((vSide - sep) / w, 2.0));
    float a2 = exp(-pow((vSide + sep) / w, 2.0));
    float body = max(a1, a2) + 0.35 * min(a1, a2);
    float haze = exp(-vSide * vSide * 2.2) * 0.35 * (1.0 - vU);
    gl_FragColor = vec4(uColor, vAlpha * (body + haze));
  }
`;

const routeVertex = /* glsl */ `
  attribute vec3 aSideVec;
  attribute float aSide;
  attribute float aU;
  uniform float uWidth;
  varying float vSide;
  varying float vU;
  void main() {
    vSide = aSide;
    vU = aU;
    vec3 p = position + aSideVec * aSide * uWidth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const routeFragment = /* glsl */ `
  uniform float uProgress;
  uniform float uTime;
  uniform float uDashes;
  uniform float uOpacity;
  uniform vec3 uFlown;
  uniform vec3 uAhead;
  varying float vSide;
  varying float vU;
  void main() {
    float s = abs(vSide);
    float aa = max(fwidth(vSide), 1e-4);
    // the geometry is 3x the line: a crisp core in the middle third, a glow around it
    float core = 1.0 - smoothstep(0.33 - aa, 0.33 + aa, s);
    float glow = exp(-s * s * 9.0);
    // ends fade in so the line meets the airport markers softly
    float ends = smoothstep(0.0, 0.012, vU) * smoothstep(1.0, 0.988, vU);
    vec3 col;
    float a;
    if (vU <= uProgress) {
      col = uFlown;
      a = core + glow * 0.45;
    } else {
      float x = (vU - uProgress) * uDashes - uTime * 0.35;
      float fx = fract(x);
      float da = max(fwidth(x), 1e-4);
      float dash = smoothstep(0.0, da * 1.5, fx) * (1.0 - smoothstep(0.55 - da * 1.5, 0.55, fx));
      col = uAhead;
      a = core * dash * 0.85;
    }
    gl_FragColor = vec4(col, a * ends * uOpacity);
  }
`;

const starsVertex = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPx;
  varying float vTw;
  void main() {
    vTw = 0.65 + 0.35 * sin(uTime * (0.6 + aPhase) + aPhase * 40.0);
    gl_PointSize = aSize * uPx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const starsFragment = /* glsl */ `
  uniform float uOpacity;
  varying float vTw;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    float a = (1.0 - smoothstep(0.0, 0.5, r)) * vTw * uOpacity;
    gl_FragColor = vec4(vec3(0.92, 0.94, 1.0), a);
  }
`;

const navVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aBlink;
  uniform float uTime;
  uniform float uPx;
  varying vec3 vColor;
  varying float vOn;
  void main() {
    vColor = aColor;
    float strobe = step(0.9, fract(uTime * 0.9 + aBlink));
    vOn = mix(0.85, strobe, step(0.5, aBlink));
    gl_PointSize = mix(5.0, 8.0, strobe) * uPx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const navFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vOn;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    gl_FragColor = vec4(vColor, (1.0 - smoothstep(0.1, 0.5, r)) * vOn);
  }
`;

const cssColor = (name, fallback) =>
  new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

/**
 * A top-down twin-jet airliner drawn on a canvas (original artwork).
 * Nose toward the top of the texture = local +Y. Returns { plane, shadow } canvases.
 */
function airlinerTextures(accent = "#f4b15a") {
  const S = 512;
  const mk = () => { const c = document.createElement("canvas"); c.width = c.height = S; return c; };
  const shapes = (g) => {
    const path = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
    const mirror = (pts) => pts.map(([x, y]) => [S - x, y]);
    const wing = [[238, 206], [26, 318], [24, 340], [238, 290]];
    const stab = [[246, 404], [168, 452], [168, 468], [246, 452]];
    return { path, mirror, wing, stab };
  };
  const body = (g) => {
    g.beginPath();
    g.moveTo(256, 34);
    g.bezierCurveTo(276, 40, 278, 84, 278, 120);
    g.lineTo(277, 380);
    g.bezierCurveTo(276, 430, 266, 470, 256, 486);
    g.bezierCurveTo(246, 470, 236, 430, 235, 380);
    g.lineTo(234, 120);
    g.bezierCurveTo(234, 84, 236, 40, 256, 34);
    g.closePath();
  };

  const plane = mk();
  const g = plane.getContext("2d");
  const { path, mirror, wing, stab } = shapes(g);
  // wings + stabilisers
  const wg = g.createLinearGradient(0, 0, S / 2, 0);
  wg.addColorStop(0, "#aeb7c4"); wg.addColorStop(0.7, "#d9dee6"); wg.addColorStop(1, "#e8ecf1");
  const wgR = g.createLinearGradient(S, 0, S / 2, 0);
  wgR.addColorStop(0, "#aeb7c4"); wgR.addColorStop(0.7, "#d9dee6"); wgR.addColorStop(1, "#e8ecf1");
  for (const [pts, grad] of [[wing, wg], [mirror(wing), wgR], [stab, wg], [mirror(stab), wgR]]) {
    path(pts); g.fillStyle = grad; g.fill();
    g.strokeStyle = "rgba(60,70,90,.35)"; g.lineWidth = 1.2; g.stroke();
  }
  // flap lines
  g.strokeStyle = "rgba(70,80,100,.28)"; g.lineWidth = 1;
  for (const sgn of [1, -1]) {
    g.beginPath(); g.moveTo(256 - sgn * 40, 285); g.lineTo(256 - sgn * 190, 318); g.stroke();
  }
  // engines under the wings
  for (const x of [160, S - 160]) {
    const eg = g.createLinearGradient(x - 14, 0, x + 14, 0);
    eg.addColorStop(0, "#6c7586"); eg.addColorStop(0.5, "#c9cfd8"); eg.addColorStop(1, "#5e6676");
    g.fillStyle = eg;
    g.beginPath(); g.roundRect(x - 13, 226, 26, 66, 12); g.fill();
    g.fillStyle = "#2b303b"; g.beginPath(); g.ellipse(x, 229, 10, 4, 0, 0, Math.PI * 2); g.fill();
  }
  // fuselage
  body(g);
  const fg = g.createLinearGradient(234, 0, 278, 0);
  fg.addColorStop(0, "#c3c9d3"); fg.addColorStop(0.35, "#ffffff"); fg.addColorStop(0.65, "#f4f6f9"); fg.addColorStop(1, "#b9c0cb");
  g.fillStyle = fg; g.fill();
  g.strokeStyle = "rgba(60,70,90,.35)"; g.lineWidth = 1.2; g.stroke();
  // cockpit windows
  g.fillStyle = "#1d2433";
  g.beginPath(); g.moveTo(244, 66); g.quadraticCurveTo(256, 56, 268, 66); g.lineTo(266, 74); g.quadraticCurveTo(256, 68, 246, 74); g.closePath(); g.fill();
  // fin seen from above, with the accent stripe
  g.fillStyle = accent; g.beginPath(); g.roundRect(252, 396, 8, 84, 4); g.fill();
  g.fillStyle = "rgba(255,255,255,.35)"; g.fillRect(253, 400, 2, 70);

  const shadow = mk();
  const sg = shadow.getContext("2d");
  sg.filter = "blur(9px)";
  sg.fillStyle = "#000";
  const sh = shapes(sg);
  for (const pts of [sh.wing, sh.mirror(sh.wing), sh.stab, sh.mirror(sh.stab)]) { sh.path(pts); sg.fill(); }
  body(sg); sg.fill();
  return { plane, shadow };
}

export class GlobeView {
  constructor(el) {
    this.el = el;
    this.tier = qualityTier();
    const q = QUALITY[this.tier];
    this.globe = new window.Globe(el, {
      rendererConfig: { antialias: this.tier !== "low", alpha: true, powerPreference: "high-performance" },
      animateIn: false,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        dayTexture: { value: null },
        nightTexture: { value: null },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
        cityLights: { value: 1.35 },
      },
      vertexShader: dayNightVertex,
      fragmentShader: dayNightFragment,
    });

    this.globe
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true)
      .atmosphereColor(getComputedStyle(document.documentElement).getPropertyValue("--globe-atmosphere").trim() || "#79a7ff")
      .atmosphereAltitude(0.16)
      .globeMaterial(this.material)
      .htmlTransitionDuration(0)
      .htmlElement((d) => d.el);

    this.pixelRatio = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.R = this.globe.getGlobeRadius();
    this.controls.minDistance = this.R * 1.08;
    this.controls.maxDistance = this.R * 6;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;

    this.ready = this.loadTextures(q.texture);
    this.updateSun();
    this.sunTimer = setInterval(() => this.updateSun(), 30000);

    this.labels = new Map();
    this.camTarget = null;
    this.userInteracting = false;
    this.lastUserInput = 0;
    this.controls.addEventListener("start", () => { this.userInteracting = true; this.lastUserInput = performance.now(); this.camTarget = null; });
    this.controls.addEventListener("end", () => { this.userInteracting = false; this.lastUserInput = performance.now(); });

    this.addStars();
    this.frameHooks = new Set();
    const loop = (t) => { this.tick(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el);
    this.resize();
  }

  get renderer() { return this.globe.renderer(); }
  get camera() { return this.globe.camera(); }
  get scene() { return this.globe.scene(); }
  get controls() { return this.globe.controls(); }

  async loadTextures(res) {
    const loader = new THREE.TextureLoader();
    const load = (url) => new Promise((ok, fail) => loader.load(url, ok, undefined, fail));
    const [day, night] = await Promise.all([
      load(`assets/textures/earth-day-${res}.jpg`),
      load(`assets/textures/earth-night-${res}.jpg`),
    ]);
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    for (const t of [day, night]) t.anisotropy = aniso;
    this.material.uniforms.dayTexture.value = day;
    this.material.uniforms.nightTexture.value = night;
    this.el.classList.add("is-ready");
  }

  /** Vector (globe units) for a lat/lng at an altitude given in globe radii. */
  coords(lat, lng, alt = 0) {
    const c = this.globe.getCoords(lat, lng, alt);
    return new THREE.Vector3(c.x, c.y, c.z);
  }

  updateSun(date = new Date()) {
    const s = subsolarPoint(date);
    this.sun = s;
    this.material.uniforms.sunDirection.value.copy(this.coords(s.lat, s.lng, 0)).normalize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.globe.width(w).height(h);
  }

  pointOfView(pov, ms = 0) { return this.globe.pointOfView(pov, ms); }

  onFrame(fn) { this.frameHooks.add(fn); return () => this.frameHooks.delete(fn); }

  tick(t) {
    const dt = Math.min(0.05, (t - (this.lastT || t)) / 1000);
    this.lastT = t;
    if (this.radar) this.radar.material.uniforms.uSweep.value = (t / 1000) * 1.7;
    if (this.stars) this.stars.material.uniforms.uTime.value = t / 1000;
    if (this.navLights) this.navLights.material.uniforms.uTime.value = t / 1000;
    if (this.route) {
      const u = this.route.material.uniforms;
      u.uTime.value = t / 1000;
      // keep the line ~2 px thick at any zoom (the mesh is 3x the core for the glow)
      u.uWidth.value = Math.max(0.02, (this.camera.position.length() - this.R) * 0.0042) * (this.pixelRatio > 1.5 ? 1 : 1.2);
    }
    this.stepPings(t);
    for (const fn of this.frameHooks) fn(t, dt);
    this.stepCamera(dt);
    if (this.plane) this.scalePlane();
  }

  /* ---------------- camera ---------------- */

  /** Altitude (globe radii) that fits a cap of `angle` radians around the view centre. */
  fitAltitude(angle, margin = 0.82) {
    const cam = this.camera;
    const vfov = (cam.fov * Math.PI) / 180;
    const aspect = Math.max(0.3, (this.el.clientWidth || 1) / (this.el.clientHeight || 1));
    const half = Math.min(vfov / 2, Math.atan(Math.tan(vfov / 2) * aspect)) * margin;
    const a = Math.min(angle, Math.PI / 2 * 0.98);
    const D = Math.cos(a) + Math.sin(a) / Math.tan(half);
    return Math.min(4.5, Math.max(0.12, D - 1));
  }

  /** Smoothly glide the camera towards a point of view (cancelled by user input). */
  glideTo(pov, rate = 3) { this.camTarget = { ...pov, rate }; }

  stepCamera(dt) {
    const target = this.camTarget;
    if (!target || this.userInteracting) return;
    const cur = this.globe.pointOfView();
    const k = 1 - Math.exp(-target.rate * dt);
    let dLng = ((target.lng - cur.lng + 540) % 360) - 180;
    const next = {
      lat: cur.lat + (target.lat - cur.lat) * k,
      lng: cur.lng + dLng * k,
      altitude: cur.altitude + (target.altitude - cur.altitude) * k,
    };
    this.globe.pointOfView(next, 0);
    if (Math.abs(target.lat - cur.lat) < 0.01 && Math.abs(dLng) < 0.01 && Math.abs(target.altitude - cur.altitude) < 0.001) {
      if (!target.keep) this.camTarget = null;
    }
  }

  /* ---------------- radar ---------------- */

  setHome(home) {
    this.home = home;
    const up = this.coords(home.lat, home.lng).normalize();
    const north = this.coords(home.lat + 0.01, home.lng).normalize().sub(up).normalize();
    const east = new THREE.Vector3().crossVectors(north, up).normalize();
    if (!this.radar) {
      const geo = new THREE.SphereGeometry(this.R * 1.0015, 160, 80);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uHome: { value: up }, uEast: { value: east }, uNorth: { value: north },
          uAngle: { value: 0 }, uRingStep: { value: 0.05 }, uSweep: { value: 0 },
          uOpacity: { value: 1 }, uColor: { value: cssColor("--radar", "#f4b15a") },
        },
        vertexShader: radarVertex,
        fragmentShader: radarFragment,
        transparent: true,
        depthWrite: false,
      });
      this.radar = new THREE.Mesh(geo, mat);
      this.radar.renderOrder = 2;
      this.scene.add(this.radar);
    } else {
      const u = this.radar.material.uniforms;
      u.uHome.value = up; u.uEast.value = east; u.uNorth.value = north;
    }
  }

  setRadar(rangeKm, ringStepKm) {
    const u = this.radar.material.uniforms;
    u.uAngle.value = rangeKm / EARTH_RADIUS_KM;
    u.uRingStep.value = Math.max(ringStepKm, 1) / EARTH_RADIUS_KM;
    if (this.points) this.points.material.uniforms.uRange.value = rangeKm;
    if (this.points) this.points.material.uniforms.uPopWidth.value = Math.max(30, rangeKm * 0.06);
  }

  showRadar(visible) {
    if (this.radar) this.radar.visible = visible;
    if (this.points) this.points.visible = visible;
  }

  /* ---------------- airports ---------------- */

  setAirports(list, dist, hideIndex = -1) {
    const n = list.length;
    if (!this.points) {
      const pos = new Float32Array(n * 3);
      const large = new Float32Array(n);
      list.forEach((a, i) => {
        const v = this.coords(a.lat, a.lng, 0.0025);
        pos.set([v.x, v.y, v.z], i * 3);
        large[i] = a.large ? 1 : 0;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aLarge", new THREE.BufferAttribute(large, 1));
      geo.setAttribute("aDist", new THREE.BufferAttribute(new Float32Array(n), 1));
      geo.setAttribute("aVisited", new THREE.BufferAttribute(new Float32Array(n), 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uRange: { value: 0 }, uPopWidth: { value: 60 }, uPx: { value: this.pixelRatio }, uScale: { value: 1 },
          uLit: { value: cssColor("--airport-lit", "#ffe2b0") },
          uDim: { value: cssColor("--airport-dim", "#55617a") },
          uFlash: { value: new THREE.Color("#ffffff") },
        },
        vertexShader: pointsVertex,
        fragmentShader: pointsFragment,
        transparent: true,
        depthWrite: false,
      });
      this.points = new THREE.Points(geo, mat);
      this.points.renderOrder = 3;
      this.points.frustumCulled = false;
      this.scene.add(this.points);
    }
    const attr = this.points.geometry.getAttribute("aDist");
    attr.array.set(dist);
    if (hideIndex >= 0) attr.array[hideIndex] = -1;
    attr.needsUpdate = true;
  }

  /** Mark the airports Henry has landed at (filled markers). */
  setVisited(indices) {
    if (!this.points) return;
    const attr = this.points.geometry.getAttribute("aVisited");
    attr.array.fill(0);
    for (const i of indices) attr.array[i] = 1;
    attr.needsUpdate = true;
  }

  /* ---------------- labels (HTML) ---------------- */

  setLabels(items) {
    // items: [{ key, lat, lng, alt?, el }]
    this.globe.htmlElementsData(items).htmlLat("lat").htmlLng("lng").htmlAltitude((d) => d.alt ?? 0.004);
  }

  /* ---------------- route, plane, contrail ---------------- */

  /** Visual altitude profile along the route (globe radii). */
  routeAltitude(f, cruise) {
    const ramp = 0.12;
    const up = Math.min(1, f / ramp), down = Math.min(1, (1 - f) / ramp);
    const s = (x) => x * x * (3 - 2 * x);
    return cruise * s(Math.max(0, Math.min(up, down)));
  }

  routeCruise(distKm) { return Math.min(0.12, 0.012 + distKm / 40000); }

  setRoute(from, to, { preview = false } = {}) {
    this.clearRoute();
    if (!from || !to) return;
    const distKm = Math.max(1, haversineKm(from.lat, from.lng, to.lat, to.lng));
    const cruise = this.routeCruise(distKm);
    const N = 220;
    const centers = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const p = interpolateGC(from.lat, from.lng, to.lat, to.lng, f);
      centers.push(this.coords(p.lat, p.lng, this.routeAltitude(f, cruise) + 0.0015));
    }
    const pos = new Float32Array((N + 1) * 2 * 3), side = new Float32Array((N + 1) * 2 * 3);
    const sgn = new Float32Array((N + 1) * 2), uu = new Float32Array((N + 1) * 2);
    for (let i = 0; i <= N; i++) {
      const a = centers[Math.max(0, i - 1)], b = centers[Math.min(N, i + 1)];
      const tan = b.clone().sub(a).normalize();
      const sv = new THREE.Vector3().crossVectors(tan, centers[i].clone().normalize()).normalize();
      for (const k of [0, 1]) {
        const j = i * 2 + k;
        pos.set([centers[i].x, centers[i].y, centers[i].z], j * 3);
        side.set([sv.x, sv.y, sv.z], j * 3);
        sgn[j] = k ? -1 : 1;
        uu[j] = i / N;
      }
    }
    const idx = [];
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSideVec", new THREE.BufferAttribute(side, 3));
    geo.setAttribute("aSide", new THREE.BufferAttribute(sgn, 1));
    geo.setAttribute("aU", new THREE.BufferAttribute(uu, 1));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uWidth: { value: 0.3 }, uProgress: { value: 0 }, uTime: { value: 0 }, uOpacity: { value: 1 },
        uDashes: { value: Math.max(6, Math.min(140, distKm / 70)) },
        uFlown: { value: cssColor("--amber-400", "#f4b15a") },
        uAhead: { value: new THREE.Color(preview ? cssColor("--amber-200", "#ffe2b0") : "#f2f4f8") },
      },
      vertexShader: routeVertex, fragmentShader: routeFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.route = new THREE.Mesh(geo, mat);
    this.route.frustumCulled = false;
    this.route.renderOrder = 4;
    this.scene.add(this.route);
    this.routeInfo = { from, to, distKm, cruise };
    return this.routeInfo;
  }

  setRouteProgress(p) { if (this.route) this.route.material.uniforms.uProgress.value = p; }

  clearRoute() {
    if (this.route) { this.scene.remove(this.route); this.route.geometry.dispose(); this.route.material.dispose(); this.route = null; }
    this.routeInfo = null;
  }

  ensurePlane() {
    if (this.plane) return;
    if (!this.planeTex) {
      const { plane, shadow } = airlinerTextures(getComputedStyle(document.documentElement).getPropertyValue("--amber-400").trim() || "#f4b15a");
      const mk = (c) => { const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; };
      this.planeTex = { plane: mk(plane), shadow: mk(shadow) };
    }
    const quad = new THREE.PlaneGeometry(2, 2);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const body = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ map: this.planeTex.plane, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    body.renderOrder = 7;
    // navigation lights: red port, green starboard, white tail strobe, red beacon
    const lightsGeo = new THREE.BufferGeometry();
    lightsGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.91, -0.27, 0.01, 0.91, -0.27, 0.01, 0, -0.9, 0.01, 0, 0.1, 0.01]), 3));
    lightsGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array([1, 0.25, 0.2, 0.3, 1, 0.45, 1, 1, 1, 1, 0.3, 0.25]), 3));
    lightsGeo.setAttribute("aBlink", new THREE.BufferAttribute(new Float32Array([0, 0, 0.6, 0.85]), 1));
    this.navLights = new THREE.Points(lightsGeo, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: this.pixelRatio } },
      vertexShader: navVertex, fragmentShader: navFragment, transparent: true, depthWrite: false,
    }));
    this.navLights.renderOrder = 9;
    this.navLights.frustumCulled = false;
    group.add(body, this.navLights);
    this.plane = group;
    this.scene.add(group);

    // soft ground shadow: shows how high we are while climbing out
    this.shadow = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ map: this.planeTex.shadow, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    this.shadow.matrixAutoUpdate = false;
    this.shadow.renderOrder = 4;
    this.scene.add(this.shadow);

    const maxSeg = 110;
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((maxSeg + 1) * 2 * 3), 3));
    tgeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array((maxSeg + 1) * 2), 1));
    const side = new Float32Array((maxSeg + 1) * 2);
    for (let i = 0; i <= maxSeg; i++) { side[i * 2] = 1; side[i * 2 + 1] = -1; }
    tgeo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    const uAttr = new Float32Array((maxSeg + 1) * 2);
    for (let i = 0; i <= maxSeg; i++) { uAttr[i * 2] = uAttr[i * 2 + 1] = i / maxSeg; }
    tgeo.setAttribute("aU", new THREE.BufferAttribute(uAttr, 1));
    const idx = [];
    for (let i = 0; i < maxSeg; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    tgeo.setIndex(idx);
    const tmat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color("#f7f3ea") } },
      vertexShader: trailVertex, fragmentShader: trailFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.trail = new THREE.Mesh(tgeo, tmat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 5;
    this.trail.maxSeg = maxSeg;
    this.scene.add(this.trail);
    this.planeState = { scale: 1, pos: new THREE.Vector3(), ground: new THREE.Vector3(), basis: new THREE.Matrix4(), shadow: 0 };
  }

  removePlane() {
    for (const k of ["plane", "trail", "shadow"]) {
      if (this[k]) { this.scene.remove(this[k]); this[k] = null; }
    }
    this.navLights = null;
  }

  /**
   * Place the plane at fraction `f` of the current route.
   * `climb` (0..1) scales the altitude for the take-off animation.
   */
  updatePlane(f, climb = 1) {
    if (!this.routeInfo) return;
    this.ensurePlane();
    const { from, to, cruise } = this.routeInfo;
    const at = (ff, ground = false) => {
      const p = interpolateGC(from.lat, from.lng, to.lat, to.lng, Math.max(0, Math.min(1, ff)));
      const alt = ground ? 0.0008 : Math.max(this.routeAltitude(ff, cruise), 0) * climb + 0.003;
      return this.coords(p.lat, p.lng, alt);
    };
    const pos = at(f);
    const ahead = at(f + 0.002);
    const forward = ahead.clone().sub(pos);
    if (forward.lengthSq() < 1e-10) forward.copy(pos.clone().sub(at(f - 0.002)));
    forward.normalize();
    const up = pos.clone().normalize();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const fwd = new THREE.Vector3().crossVectors(up, right).normalize();
    this.planeState.pos.copy(pos);
    this.planeState.ground.copy(at(f, true));
    this.planeState.basis.makeBasis(right, fwd, up);
    // shadow fades as the plane climbs away, and only exists in daylight
    const sunUp = up.dot(this.material.uniforms.sunDirection.value);
    const height = pos.length() / this.R - 1;
    this.planeState.shadow = 0.34 * Math.max(0, Math.min(1, (sunUp + 0.05) / 0.25)) * Math.max(0, 1 - height / 0.06);
    this.scalePlane();

    // contrail: a soft ribbon behind the plane, widening and fading as it ages
    const n = this.trail.maxSeg;
    const lengthF = Math.min(f, Math.max(0.06, 900 / Math.max(1, this.routeInfo.distKm) * 0.6));
    const posAttr = this.trail.geometry.getAttribute("position");
    const aAttr = this.trail.geometry.getAttribute("aAlpha");
    const w = this.planeState.scale;
    const fade = Math.min(1, climb * 1.6);
    for (let i = 0; i <= n; i++) {
      const u = i / n;                      // 0 = tail end, 1 = at the plane
      const ff = f - lengthF * (1 - u) - 0.0002;
      const p = at(ff);
      const p2 = at(ff + 0.001);
      const dir = p2.clone().sub(p).normalize();
      const sideV = new THREE.Vector3().crossVectors(dir, p.clone().normalize()).normalize();
      const width = w * (0.5 + 1.1 * Math.pow(1 - u, 1.2));
      posAttr.setXYZ(i * 2, p.x + sideV.x * width, p.y + sideV.y * width, p.z + sideV.z * width);
      posAttr.setXYZ(i * 2 + 1, p.x - sideV.x * width, p.y - sideV.y * width, p.z - sideV.z * width);
      // condensation forms a little behind the engines, then slowly dissipates
      const alpha = 0.62 * Math.pow(u, 1.5) * (1 - Math.pow(Math.max(0, (u - 0.965) / 0.035), 2)) * fade * (lengthF > 0.0005 ? 1 : 0);
      aAttr.setX(i * 2, alpha); aAttr.setX(i * 2 + 1, alpha);
    }
    posAttr.needsUpdate = true;
    aAttr.needsUpdate = true;
  }

  scalePlane() {
    if (!this.plane) return;
    const camDist = this.camera.position.length();
    const s = Math.max(0.3, (camDist - this.R) * 0.03);
    this.planeState.scale = s;
    const v = new THREE.Vector3(s, s, s);
    this.plane.matrix.copy(this.planeState.basis).scale(v).setPosition(this.planeState.pos);
    this.plane.matrixWorldNeedsUpdate = true;
    this.shadow.matrix.copy(this.planeState.basis).scale(v).setPosition(this.planeState.ground);
    this.shadow.matrixWorldNeedsUpdate = true;
    this.shadow.material.opacity = Math.min(0.6, this.planeState.shadow * 1.6);
  }

  /* ---------------- stars + pings ---------------- */

  addStars() {
    const N = this.tier === "low" ? 900 : 1800;
    const pos = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 4200;
      const q = Math.sqrt(1 - u * u);
      pos.set([r * q * Math.cos(th), r * u, r * q * Math.sin(th)], i * 3);
      size[i] = Math.random() < 0.06 ? 2.6 + Math.random() * 1.4 : 0.9 + Math.random() * 1.3;
      phase[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    this.stars = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: this.pixelRatio }, uOpacity: { value: 1 } },
      vertexShader: starsVertex, fragmentShader: starsFragment, transparent: true, depthWrite: false,
    }));
    this.stars.renderOrder = -1;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
    const cam = this.camera;
    if (cam.far < 9000) { cam.far = 9000; cam.updateProjectionMatrix(); }
  }

  setStarOpacity(v) { if (this.stars) this.stars.material.uniforms.uOpacity.value = v; }

  /** A quick expanding ripple on the surface (an airport coming into range). */
  ping(lat, lng) {
    if (!this.pings) {
      this.pings = [];
      const geo = new THREE.RingGeometry(0.82, 1, 48);
      for (let i = 0; i < 8; i++) {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: cssColor("--amber-200", "#ffe2b0"), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
        m.renderOrder = 3;
        m.visible = false;
        this.scene.add(m);
        this.pings.push({ mesh: m, t0: -1 });
      }
    }
    const slot = this.pings.find((p) => p.t0 < 0) || this.pings.reduce((a, b) => (a.t0 < b.t0 ? a : b));
    const pos = this.coords(lat, lng, 0.003);
    slot.mesh.position.copy(pos);
    slot.mesh.lookAt(pos.clone().multiplyScalar(2));
    slot.t0 = performance.now();
    slot.mesh.visible = true;
  }

  stepPings(t) {
    if (!this.pings) return;
    const base = Math.max(0.25, (this.camera.position.length() - this.R) * 0.03);
    for (const p of this.pings) {
      if (p.t0 < 0) continue;
      const k = (t - p.t0) / 750;
      if (k >= 1) { p.t0 = -1; p.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - k, 3);
      p.mesh.scale.setScalar(base * (0.4 + 2.6 * e));
      p.mesh.material.opacity = 0.85 * (1 - k);
    }
  }

  /* ---------------- picking ---------------- */

  /** km on the ground per CSS pixel at the view centre (approx). */
  kmPerPixel() {
    const alt = this.globe.pointOfView().altitude;
    const vfov = (this.camera.fov * Math.PI) / 180;
    return (alt * EARTH_RADIUS_KM * 2 * Math.tan(vfov / 2)) / (this.el.clientHeight || 1);
  }
}
