// GLSL for the globe: earth surface, moving clouds, atmosphere and the sky.
// The cloud function is shared, so cloud shadows on the ground line up with the clouds.

export const NOISE = /* glsl */ `
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < OCTAVES; i++) {
      v += a * noise3(p);
      p = p * 2.07 + vec3(17.1, 9.3, 4.7);
      a *= 0.5;
    }
    return v;
  }
  // Cloud cover (0..1) for a unit direction from the earth's centre.
  // Domain-warped noise gives swirls; a latitude term thins the subtropics.
  float cloudCover(vec3 n, float t) {
    vec3 p = n * 2.6;
    vec3 q = vec3(fbm3(p + vec3(0.0, 0.0, t * 0.010)),
                  fbm3(p + vec3(5.2, 1.3, -t * 0.008)),
                  fbm3(p + vec3(2.1, 7.7, t * 0.006)));
    float d = fbm3(p * 1.7 + q * 2.4 + vec3(t * 0.004, 0.0, 0.0));
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float band = cos(lat * 6.0);                       // ITCZ and storm tracks up, subtropics down
    float thresh = 0.56 - 0.07 * band + 0.05 * smoothstep(1.2, 1.5, abs(lat));
    return smoothstep(thresh, thresh + 0.17, d);
  }
`;

// Direction <-> equirectangular UV, matching three-globe's lat/lng convention.
export const CLOUDMAP = /* glsl */ `
  uniform sampler2D cloudMap;
  uniform float uCloudShift;   // the weather drifts east, a little faster in the storm tracks
  vec2 dirToUv(vec3 n) {
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lng = 1.5707963 - atan(n.z, n.x);
    float drift = uCloudShift * (0.75 + 0.45 * cos(lat * 2.2));
    return vec2(fract(lng / 6.2831853 + 0.5 - drift), lat / 3.1415927 + 0.5);
  }
  // density, 0.5 = cloud edge. Gradients are taken across the date-line wrap so the
  // mip level never jumps there (no seam line where u goes 1 -> 0).
  float cloudDensity(vec3 n) {
    vec2 uv = dirToUv(n);
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    dx.x -= floor(dx.x + 0.5);
    dy.x -= floor(dy.x + 0.5);
    return textureGrad(cloudMap, uv, dx, dy).r;
  }
  float cloudAt(vec3 n) { return smoothstep(0.5, 0.66, cloudDensity(n)); }
`;

// Bakes the slowly evolving cloud field into an equirectangular texture.
export const bakeVertex = /* glsl */ `
  uniform vec2 uStrip;      // [start, end] in v, so the bake can be spread over frames
  varying vec2 vUv;
  void main() {
    vUv = vec2(uv.x, mix(uStrip.x, uStrip.y, uv.y));
    gl_Position = vec4(position.x, vUv.y * 2.0 - 1.0, 0.0, 1.0);
  }
`;
export const bakeFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  ${NOISE}
  void main() {
    float lat = (vUv.y - 0.5) * 3.1415927;
    float lng = (vUv.x - 0.5) * 6.2831853;
    float th = 1.5707963 - lng;
    vec3 n = vec3(cos(lat) * cos(th), sin(lat), cos(lat) * sin(th));
    vec3 p = n * 3.4;
    vec3 q = vec3(fbm3(p + vec3(0.0, 0.0, uTime * 0.010)),
                  fbm3(p + vec3(5.2, 1.3, -uTime * 0.008)),
                  fbm3(p + vec3(2.1, 7.7, uTime * 0.006)));
    float d = fbm3(p * 1.9 + q * 2.6 + vec3(uTime * 0.004, 0.0, 0.0));
    d -= (fbm3(p * 9.0 + q) - 0.5) * 0.18;                  // erode the edges into wisps
    float band = cos(lat * 6.0);
    float thresh = 0.59 - 0.07 * band + 0.05 * smoothstep(1.2, 1.5, abs(lat));
    gl_FragColor = vec4(clamp(d - thresh + 0.5, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`;

export const earthVertex = /* glsl */ `
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

export const earthFragment = /* glsl */ `
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform sampler2D reliefTexture;   // r = height, g = water
  uniform vec2 reliefTexel;
  uniform vec3 sunDirection;
  uniform float cityLights;
  uniform float uTime;
  uniform float uCloudShadow;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec2 vUv;
  ${CLOUDMAP}
  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 dayRaw = texture2D(dayTexture, vUv).rgb;
    vec3 night = texture2D(nightTexture, vUv).rgb;
    vec4 rel = texture2D(reliefTexture, vUv);
    float water = smoothstep(0.4, 0.6, rel.g);

    // terrain relief from the height map (bump mapping in the local east/north frame)
    float hL = texture2D(reliefTexture, vUv - vec2(reliefTexel.x, 0.0)).r;
    float hR = texture2D(reliefTexture, vUv + vec2(reliefTexel.x, 0.0)).r;
    float hD = texture2D(reliefTexture, vUv - vec2(0.0, reliefTexel.y)).r;
    float hU = texture2D(reliefTexture, vUv + vec2(0.0, reliefTexel.y)).r;
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-5));
    vec3 north = cross(n, east);
    vec3 nb = normalize(n - (east * (hR - hL) + north * (hU - hD)) * 2.2 * (1.0 - water));

    float cosSun = dot(n, sunDirection);
    float lambert = max(dot(nb, sunDirection), 0.0);

    // cloud shadows, offset a little away from the sun
    float shadow = uCloudShadow * cloudAt(normalize(n + sunDirection * 0.006));

    vec3 day = pow(dayRaw, vec3(1.08)) * 1.06;
    vec3 dayLit = day * (0.18 + 0.95 * lambert) * (1.0 - shadow * 0.55);

    // sun glint on water only
    vec3 halfV = normalize(sunDirection + viewDir);
    float spec = pow(max(dot(n, halfV), 0.0), 180.0) * 0.7 + pow(max(dot(n, halfV), 0.0), 30.0) * 0.05;
    dayLit += vec3(1.0, 0.94, 0.82) * spec * water * smoothstep(0.0, 0.15, cosSun) * (1.0 - shadow);

    // city lights, warmer and dimmed under cloud
    float lum = dot(night, vec3(0.299, 0.587, 0.114));
    vec3 lights = night * vec3(1.15, 0.95, 0.72) * cityLights * (0.5 + 0.9 * smoothstep(0.12, 0.55, lum));
    vec3 nightLit = lights * (1.0 - shadow * 0.7) + vec3(0.006, 0.010, 0.022) + day * 0.012;

    float blend = smoothstep(-0.12, 0.08, cosSun);
    vec3 color = mix(nightLit, dayLit, blend);

    // twilight: a warm band and reddened light along the terminator
    float band = exp(-pow((cosSun - 0.01) / 0.12, 2.0));
    color += vec3(1.0, 0.45, 0.18) * band * 0.05;

    // aerial perspective: blue haze grows toward the limb on the lit side
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.6);
    color = mix(color, vec3(0.42, 0.62, 1.0), rim * 0.55 * smoothstep(-0.2, 0.35, cosSun));

    gl_FragColor = vec4(color, 1.0);
  }
`;

export const cloudVertex = earthVertex;

export const cloudFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  ${NOISE}
  ${CLOUDMAP}
  void main() {
    vec3 n = normalize(vWorldNormal);
    float dens = cloudDensity(n);
    if (dens < 0.38) discard;
    // the map carries the real structure; a whisper of noise keeps close-ups from going flat
    float detail = (noise3(n * 220.0 + uTime * 0.02) - 0.5) * 0.06 + (noise3(n * 700.0) - 0.5) * 0.025;
    float c = pow(smoothstep(0.385, 0.70, dens + detail), 0.85);
    if (c < 0.01) discard;
    // fake volume: brighter where the density falls off toward the sun, greyer in the cores
    float towardSun = cloudDensity(normalize(n + sunDirection * 0.004));
    float vol = clamp(0.9 + (dens - towardSun) * 1.6, 0.74, 1.04);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float cosSun = dot(n, sunDirection);
    // soft wrap lighting: clouds stay lit a little past the terminator, then go grey-blue
    float light = smoothstep(-0.18, 0.35, cosSun);
    vec3 lit = mix(vec3(0.05, 0.06, 0.09), vec3(1.0), light);
    float band = exp(-pow((cosSun - 0.02) / 0.1, 2.0));
    lit = mix(lit, vec3(1.0, 0.66, 0.45), band * 0.32);
    lit *= mix(1.0, vol, light) * (0.86 + 0.14 * (1.0 - smoothstep(0.6, 0.85, dens)));
    float edge = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
    float a = c * uOpacity * (0.92 - edge * 0.5);
    gl_FragColor = vec4(lit, a);
  }
`;

export const atmosphereVertex = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Rendered on the back faces of a slightly larger sphere: the glow around the limb.
export const atmosphereFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform vec3 uCenter;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 n = normalize(vWorldPos - uCenter);
    float facing = dot(-n, viewDir);                    // 0 at the outer edge, ~0.43 at the Earth's limb
    float x = clamp(facing / 0.434, 0.0, 1.0);          // 0 at the outer edge, 1 at the limb
    float glow = pow(x, 5.0) * 1.1 + pow(x, 1.8) * 0.22;
    float cosSun = dot(n, sunDirection);
    float day = smoothstep(-0.35, 0.3, cosSun);
    vec3 blue = vec3(0.32, 0.56, 1.0);
    vec3 dusk = vec3(1.0, 0.5, 0.25);
    float band = exp(-pow((cosSun + 0.05) / 0.18, 2.0));
    vec3 col = mix(blue, dusk, band * 0.7) * (0.08 + day * 0.92);
    gl_FragColor = vec4(col * glow, glow * (0.12 + day * 0.88));
  }
`;

export const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;                                // always at the far plane
  }
`;

// Deep space, baked once into an equirectangular texture: near-black navy, a faint
// Milky Way band and a sparse scatter of dim stars. Kept quiet so the Earth leads.
export const skyBakeFragment = /* glsl */ `
  varying vec2 vUv;
  ${NOISE}
  float starField(vec3 d, float scale, float density) {
    vec3 p = d * scale;
    vec3 cell = floor(p);
    float h = hash3(cell);
    if (h < 1.0 - density) return 0.0;
    vec3 c = cell + 0.5 + 0.35 * (vec3(hash3(cell + 1.3), hash3(cell + 2.7), hash3(cell + 4.1)) - 0.5);
    float dist = length(p - c);
    return smoothstep(0.22, 0.0, dist) * (0.4 + 0.6 * hash3(cell + 9.1));
  }
  void main() {
    float lat = (vUv.y - 0.5) * 3.1415927;
    float lng = (vUv.x - 0.5) * 6.2831853;
    vec3 d = vec3(cos(lat) * cos(lng), sin(lat), cos(lat) * sin(lng));
    vec3 galN = normalize(vec3(0.25, 0.86, 0.45));    // tilted galactic plane
    float g = dot(d, galN);
    float bandW = exp(-g * g * 30.0);
    float core = exp(-pow(length(d - normalize(vec3(-0.6, -0.1, 0.79))), 2.0) * 4.0);
    float clouds = fbm3(d * 4.0) * 0.7 + fbm3(d * 11.0) * 0.3;
    float dust = smoothstep(0.5, 0.75, fbm3(d * 8.0 + 3.0)) * exp(-g * g * 160.0);
    float milky = bandW * (0.3 + 0.7 * clouds) * (0.5 + 0.8 * core) * (1.0 - dust * 0.7);
    vec3 col = vec3(0.006, 0.009, 0.020);
    col += milky * mix(vec3(0.40, 0.46, 0.62), vec3(0.85, 0.76, 0.62), core) * 0.085;
    float s = starField(d, 160.0, 0.025 + bandW * 0.05) * 0.35;
    col += vec3(0.85, 0.9, 1.0) * s;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const skyFragment = /* glsl */ `
  uniform float uOpacity;
  uniform sampler2D skyMap;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5);
    gl_FragColor = vec4(texture2D(skyMap, uv).rgb * uOpacity, 1.0);
  }
`;

// Detailed cumulus near the plane (3D follow + window views). Anchored to the ground,
// shaped by the global cloud field so weather matches the globe view.
export const deckFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform float uTime;
  uniform vec3 uCenter;
  uniform float uRadius;
  uniform vec3 uHaze;
  uniform float uHazeDist;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  ${NOISE}
  ${CLOUDMAP}
  void main() {
    vec3 n = normalize(vWorldNormal);
    float big = cloudAt(n);
    vec3 p = n * 620.0 + vec3(uTime * 0.05, 0.0, uTime * 0.03);
    float detail = fbm3(p) * 0.85 + noise3(p * 3.1) * 0.15;
    float d = detail - mix(0.6, 0.36, big);
    float c = smoothstep(0.0, 0.16, d);
    float fade = 1.0 - smoothstep(uRadius * 0.6, uRadius, distance(vWorldPos, uCenter));
    c *= fade;
    if (c < 0.01) discard;
    float d2 = noise3(p + sunDirection * 1.6);
    float self = clamp(0.62 + (detail - d2 * 0.9) * 2.2, 0.3, 1.0);
    float cosSun = dot(n, sunDirection);
    float light = smoothstep(-0.12, 0.3, cosSun);
    vec3 col = mix(vec3(0.05, 0.06, 0.09), vec3(1.0, 0.99, 0.97) * self + vec3(0.12, 0.14, 0.2) * (1.0 - self), light);
    col = mix(col, vec3(1.0, 0.62, 0.4) * self, exp(-pow((cosSun - 0.03) / 0.1, 2.0)) * 0.5);
    float haze = 1.0 - exp(-distance(cameraPosition, vWorldPos) / uHazeDist);
    col = mix(col, uHaze * (0.08 + 0.92 * light), haze * 0.8);
    gl_FragColor = vec4(col, c * 0.94);
  }
`;

// Daytime sky seen from inside the atmosphere (3D follow + window views).
export const airSkyFragment = /* glsl */ `
  uniform vec3 uUp;
  uniform vec3 sunDirection;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunCol;
  uniform float uNight;
  varying vec3 vDir;
  ${NOISE}
  void main() {
    vec3 d = normalize(vDir);
    float e = dot(d, uUp);
    float h = clamp(e + 0.02, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(h, 0.45));
    col = mix(col, uHorizon * 0.9, smoothstep(0.02, -0.08, e));       // haze below the horizon line
    float sd = max(dot(d, sunDirection), 0.0);
    col += uSunCol * (pow(sd, 6.0) * 0.22 + pow(sd, 60.0) * 0.5) * (1.0 - uNight * 0.85);
    col += uSunCol * smoothstep(0.9996, 0.99985, sd) * 3.0 * step(-0.02, dot(sunDirection, uUp));
    if (uNight > 0.01) {
      vec3 cell = floor(d * 260.0);
      float st = step(0.992, hash3(cell)) * smoothstep(0.0, 0.2, e);
      col += vec3(0.85, 0.9, 1.0) * st * uNight * 0.8;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;
