// The 3D globe: globe.gl (bundled three.js) + a custom day/night shader that
// blends NASA Blue Marble and Black Marble along the real terminator.
import * as THREE from "../vendor/three.core-0.185.1.min.js";
import { subsolarPoint } from "./geo.js";
import { QUALITY, qualityTier } from "./settings.js";

export { THREE };

const dayNightVertex = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const dayNightFragment = /* glsl */ `
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec3 sunDirection;
  uniform float cityLights;
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  void main() {
    vec3 n = normalize(vWorldNormal);
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

    gl_FragColor = vec4(color, 1.0);
  }
`;

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
      .globeMaterial(this.material);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.R = this.globe.getGlobeRadius();

    this.ready = this.loadTextures(q.texture);
    this.updateSun();
    this.sunTimer = setInterval(() => this.updateSun(), 30000);

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
}
