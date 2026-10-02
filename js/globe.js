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
  uniform float uRange;
  uniform float uPopWidth;
  uniform float uPx;
  uniform float uScale;
  varying float vLit;
  varying float vPop;
  varying float vFace;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float hidden = step(aDist, -0.5);
    float lit = step(aDist, uRange);
    float k = (uRange - aDist) / uPopWidth;
    float pop = lit * exp(-k * 1.6);
    float base = mix(3.6, 5.6, aLarge) * mix(0.75, 1.0, lit);
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
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p);
    if (r > 0.5) discard;
    float disc = 1.0 - smoothstep(0.32, 0.5, r);
    vec3 col = mix(uDim, mix(uLit, uFlash, vPop), vLit);
    float alpha = disc * mix(0.45, 1.0, vLit) * vFace;
    gl_FragColor = vec4(col, alpha);
  }
`;

const trailVertex = /* glsl */ `
  attribute float aAlpha;
  attribute float aSide;
  varying float vAlpha;
  varying float vSide;
  void main() {
    vAlpha = aAlpha;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const trailFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vSide;
  void main() {
    float soft = exp(-vSide * vSide * 3.2);
    float core = exp(-vSide * vSide * 40.0) * 0.5;
    gl_FragColor = vec4(uColor, vAlpha * (soft + core));
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

/** Original plane silhouette, nose pointing +Y, wingspan ~2 units. */
function planeShape() {
  const half = [
    [0, 1.0], [0.07, 0.86], [0.09, 0.42], [0.98, -0.06], [0.98, -0.2], [0.1, -0.05],
    [0.07, -0.62], [0.4, -0.88], [0.4, -0.98], [0.0, -0.9],
  ];
  const pts = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
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

  setRoute(from, to, { dashed = true } = {}) {
    this.clearRoute();
    if (!from || !to) return;
    const distKm = Math.max(1, haversineKm(from.lat, from.lng, to.lat, to.lng));
    const cruise = this.routeCruise(distKm);
    const N = 160;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const p = interpolateGC(from.lat, from.lng, to.lat, to.lng, f);
      pts.push(this.coords(p.lat, p.lng, this.routeAltitude(f, cruise) + 0.002));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const color = cssColor("--accent-hi", "#ffcd85");
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 1.2, gapSize: 0.9, transparent: true, opacity: 0.9, depthWrite: false })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false });
    this.route = new THREE.Line(geo, mat);
    if (dashed) this.route.computeLineDistances();
    this.route.renderOrder = 4;
    this.scene.add(this.route);
    this.routeInfo = { from, to, distKm, cruise };
    return this.routeInfo;
  }

  clearRoute() {
    if (this.route) { this.scene.remove(this.route); this.route.geometry.dispose(); this.route = null; }
    this.routeInfo = null;
  }

  ensurePlane() {
    if (this.plane) return;
    const geo = new THREE.ShapeGeometry(planeShape());
    this.planeGeo = geo;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    // dark keyline so the craft reads against both oceans and city lights
    const outline = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: "#0b1220", side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
    outline.scale.setScalar(1.2);
    outline.position.set(0, -0.02, -0.002);
    outline.renderOrder = 6;
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: cssColor("--paper-50", "#fbf6ea"), side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    fill.renderOrder = 7;
    // amber fin stripe
    const fin = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.5), new THREE.MeshBasicMaterial({ color: cssColor("--amber-400", "#f4b15a"), side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    fin.position.set(0, -0.55, 0.002);
    fin.renderOrder = 8;
    // navigation lights: red port, green starboard, white tail strobe
    const lightsGeo = new THREE.BufferGeometry();
    lightsGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.98, -0.13, 0.01, 0.98, -0.13, 0.01, 0, -0.95, 0.01, 0, 0.1, 0.01]), 3));
    lightsGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array([1, 0.25, 0.2, 0.3, 1, 0.45, 1, 1, 1, 1, 1, 1]), 3));
    lightsGeo.setAttribute("aBlink", new THREE.BufferAttribute(new Float32Array([0, 0, 0.6, 0.85]), 1));
    this.navLights = new THREE.Points(lightsGeo, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPx: { value: this.pixelRatio } },
      vertexShader: navVertex, fragmentShader: navFragment, transparent: true, depthWrite: false,
    }));
    this.navLights.renderOrder = 9;
    this.navLights.frustumCulled = false;
    group.add(outline, fill, fin, this.navLights);
    this.plane = group;
    this.scene.add(group);

    // ground shadow: shows how high we are while climbing out
    this.shadow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: "#000000", side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false }));
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
    const w = this.planeState.scale * 0.26;
    const fade = Math.min(1, climb * 1.6);
    for (let i = 0; i <= n; i++) {
      const u = i / n;                      // 0 = tail end, 1 = at the plane
      const ff = f - lengthF * (1 - u) - 0.0004;
      const p = at(ff);
      const p2 = at(ff + 0.001);
      const dir = p2.clone().sub(p).normalize();
      const sideV = new THREE.Vector3().crossVectors(dir, p.clone().normalize()).normalize();
      const width = w * (0.4 + 1.8 * Math.pow(1 - u, 1.3)) * Math.min(1, u * 10);
      posAttr.setXYZ(i * 2, p.x + sideV.x * width, p.y + sideV.y * width, p.z + sideV.z * width);
      posAttr.setXYZ(i * 2 + 1, p.x - sideV.x * width, p.y - sideV.y * width, p.z - sideV.z * width);
      const alpha = 0.6 * Math.pow(u, 1.6) * fade * (lengthF > 0.0005 ? 1 : 0);
      aAttr.setX(i * 2, alpha); aAttr.setX(i * 2 + 1, alpha);
    }
    posAttr.needsUpdate = true;
    aAttr.needsUpdate = true;
  }

  scalePlane() {
    if (!this.plane) return;
    const camDist = this.camera.position.length();
    const s = Math.max(0.3, (camDist - this.R) * 0.028);
    this.planeState.scale = s;
    const v = new THREE.Vector3(s, s, s);
    this.plane.matrix.copy(this.planeState.basis).scale(v).setPosition(this.planeState.pos);
    this.plane.matrixWorldNeedsUpdate = true;
    this.shadow.matrix.copy(this.planeState.basis).scale(v).setPosition(this.planeState.ground);
    this.shadow.matrixWorldNeedsUpdate = true;
    this.shadow.material.opacity = this.planeState.shadow;
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
