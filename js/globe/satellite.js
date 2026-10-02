// Satellite imagery close to the plane, for the 3D follow view and the window view.
// A few nested rings of slippy-map tiles (coarse → fine) are draped on the sphere around
// a centre point, lit by the real sun and hazed toward the horizon, fading out at the
// edges so they blend into the global Blue Marble texture.
//
// Imagery: Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus
// Sentinel data), CC BY-NC-SA 4.0 — fine for this personal, non-commercial app.
import * as THREE from "../../vendor/three.core-0.185.1.min.js";

export const SATELLITE_ATTRIBUTION = "Imagery: Sentinel-2 cloudless by EOX (Copernicus Sentinel data)";
const URL = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;

const tileVertex = /* glsl */ `
  attribute vec2 aTile;      // slippy-map coordinates of this vertex
  uniform vec2 uCenter;      // the plane, in the same coordinates
  uniform float uN;          // tiles per axis at this zoom
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vEdge;
  void main() {
    vUv = uv;
    vec2 d = aTile - uCenter;
    d.x = d.x - uN * floor(d.x / uN + 0.5);    // wrap across the antimeridian
    vEdge = max(abs(d.x), abs(d.y));
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const tileFragment = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D nightMap;   // Black Marble city lights, for the night side
  uniform vec3 sunDirection;
  uniform float uFade;
  uniform float uRing;
  uniform vec3 uHaze;
  uniform float uHazeDist;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vEdge;
  void main() {
    vec3 c = texture2D(map, vUv).rgb;
    vec3 nrm = normalize(vNormal);
    float cosSun = dot(nrm, sunDirection);
    float light = smoothstep(-0.1, 0.25, cosSun);
    // night: faint blue moonlight on the land, and the real city lights glowing through
    float lat = asin(clamp(nrm.y, -1.0, 1.0));
    float lng = 1.5707963 - atan(nrm.z, nrm.x);
    vec3 lights = texture2D(nightMap, vec2(fract(lng / 6.2831853 + 0.5), lat / 3.1415927 + 0.5)).rgb;
    vec3 moon = c * vec3(0.2, 0.26, 0.4) + vec3(0.012, 0.018, 0.035) + lights * vec3(1.35, 1.05, 0.7) * 1.8;
    vec3 col = mix(moon, c * vec3(1.0, 0.98, 0.95), light);
    col = mix(col, col * vec3(1.05, 0.8, 0.62), exp(-pow(cosSun / 0.12, 2.0)) * 0.6);
    float d = distance(cameraPosition, vWorldPos);
    float haze = 1.0 - exp(-d / uHazeDist);
    col = mix(col, uHaze * (0.12 + 0.88 * light), haze * 0.85);
    float edge = 1.0 - smoothstep(uRing - 0.9, uRing + 0.35, vEdge);
    gl_FragColor = vec4(col, edge * uFade);
  }
`;

const lon2x = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

export class SatelliteLayer {
  constructor(view) {
    this.view = view;
    this.group = new THREE.Group();
    this.group.visible = false;
    view.scene.add(this.group);
    this.tiles = new Map();
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin("anonymous");
    this.failures = 0;
    this.successes = 0;
    this.levels = [{ z: 7, ring: 3 }, { z: 9, ring: 3 }, { z: 11, ring: 2 }];
    this.haze = new THREE.Color("#b9cde6");
    this.hazeDist = 8;
    this.ready = [];          // decoded tiles waiting to go to the GPU (a couple per frame)
  }

  get available() { return !(this.failures > 6 && this.successes === 0) && navigator.onLine !== false; }

  setVisible(v) { this.group.visible = v; }

  configure({ levels, haze, hazeDist }) {
    if (levels) this.levels = levels;
    if (haze) this.haze.set(haze);
    if (hazeDist) this.hazeDist = hazeDist;
    for (const t of this.tiles.values()) {
      t.mesh.material.uniforms.uHaze.value.copy(this.haze);
      t.mesh.material.uniforms.uHazeDist.value = this.hazeDist;
    }
  }

  /** Keep the tile rings centred on a point. Cheap to call every frame. */
  update(lat, lng) {
    if (!this.group.visible) return;
    // hand decoded tiles to the GPU a couple at a time, so uploads never pile into one frame
    for (let k = 0; k < 2 && this.ready.length; k++) {
      const { t, tex } = this.ready.shift();
      if (!this.tiles.has(`${t.z}/${t.x}/${t.y}`)) { tex.dispose(); continue; }
      t.mesh.material.uniforms.map.value = tex;
      t.loadedAt = performance.now();
    }
    // which tiles we need only changes when the plane crosses a tile edge: work it out
    // a few times a second; per frame just slide the rings' centre and fade tiles in
    const now = performance.now();
    if (!this.lastPlan || now - this.lastPlan > 200) {
      this.lastPlan = now;
      const want = new Set();
      for (const [li, { z, ring }] of this.levels.entries()) {
        const cx = Math.floor(lon2x(lng, z)), cy = Math.floor(lat2y(Math.max(-84, Math.min(84, lat)), z));
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            const n = 2 ** z;
            const x = ((cx + dx) % n + n) % n, y = cy + dy;
            if (y < 0 || y >= n) continue;
            const key = `${z}/${x}/${y}`;
            want.add(key);
            let t = this.tiles.get(key);
            if (!t) t = this.addTile(z, x, y, li);
            t.ring = ring;
          }
        }
      }
      for (const [key, t] of this.tiles) if (!want.has(key)) this.removeTile(key, t);
    }
    for (const t of this.tiles.values()) {
      const u = t.mesh.material.uniforms;
      u.uRing.value = t.ring ?? 3;
      u.uCenter.value.set(lon2x(lng, t.z), lat2y(lat, t.z));
      u.uFade.value = t.loadedAt ? Math.min(1, (now - t.loadedAt) / 500) : 0;
    }
  }

  addTile(z, x, y, levelIndex) {
    const N = z <= 7 ? 12 : 8;
    const pos = new Float32Array((N + 1) * (N + 1) * 3), uv = new Float32Array((N + 1) * (N + 1) * 2);
    const tx = new Float32Array((N + 1) * (N + 1) * 2);
    const lift = 0.00004 + levelIndex * 0.00002;  // finer levels sit a hair above coarser ones (~250 m)
    let k = 0;
    for (let j = 0; j <= N; j++) {
      const lat = y2lat(y + j / N, z);
      for (let i = 0; i <= N; i++) {
        const lng = ((x + i / N) / 2 ** z) * 360 - 180;
        const c = this.view.globe.getCoords(lat, lng, lift);
        pos.set([c.x, c.y, c.z], k * 3);
        uv.set([i / N, 1 - j / N], k * 2);
        tx.set([x + i / N, y + j / N], k * 2);
        k++;
      }
    }
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("aTile", new THREE.BufferAttribute(tx, 2));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null }, nightMap: this.view.material.uniforms.nightTexture, sunDirection: this.view.material.uniforms.sunDirection,
        uFade: { value: 0 }, uRing: { value: 3 }, uCenter: { value: new THREE.Vector2() }, uN: { value: 2 ** z },
        uHaze: { value: this.haze.clone() }, uHazeDist: { value: this.hazeDist },
      },
      vertexShader: tileVertex, fragmentShader: tileFragment,
      transparent: true, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1 + levelIndex;
    mesh.frustumCulled = false;
    const t = { mesh, z, x, y, born: performance.now() };
    this.tiles.set(`${z}/${x}/${y}`, t);
    this.group.add(mesh);
    this.fetchTile(URL(z, x, y)).then((tex) => {
      this.successes++;
      if (!this.tiles.has(`${z}/${x}/${y}`)) { tex.dispose(); return; }
      this.ready.push({ t, tex });
    }).catch(() => { this.failures++; });
    return t;
  }

  /** Download and decode a tile off the main thread (ImageBitmap); falls back to an <img>. */
  async fetchTile(url) {
    if (typeof createImageBitmap !== "function") {
      return new Promise((ok, fail) => this.loader.load(url, (tex) => { tex.anisotropy = 4; ok(tex); }, undefined, fail));
    }
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(res.status);
    const bmp = await createImageBitmap(await res.blob(), { imageOrientation: "flipY" });
    const tex = new THREE.Texture(bmp);
    tex.flipY = false;                 // already flipped while decoding
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  removeTile(key, t) {
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.mesh.material.uniforms.map.value?.dispose();
    t.mesh.material.dispose();
    this.tiles.delete(key);
  }

  clear() { for (const [k, t] of this.tiles) this.removeTile(k, t); }
}
