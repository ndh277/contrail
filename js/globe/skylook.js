// How the sky looks for a given sun elevation, shared by the globe's close views
// and the shader window. Also the sun's elevation for a place and time.
import { subsolarPoint } from "../geo.js";

const RAD = Math.PI / 180;

// Sky look by sun elevation:
// [elev°, zenith, horizon, sun, cloud lit, cloud shade, ground, night, cabin daylight]
const LOOKS = [
  [-90, "#03060f", "#101c38", "#1a2238", "#2b3550", "#0c1222", "#03060c", 1, 0],
  [-14, "#040916", "#14234a", "#25304e", "#3a4669", "#101830", "#04070e", 1, 0],
  [-7, "#081333", "#2a3463", "#c8604a", "#7a6f96", "#2a2c4a", "#070b16", 0.7, 0.05],
  [-2, "#16285c", "#d0795a", "#ff9a5a", "#f3b08a", "#5d4f74", "#0d1322", 0.25, 0.25],
  [3, "#2f5ca8", "#f5c08f", "#ffc27a", "#fff0dd", "#7d82a0", "#1a2436", 0, 0.6],
  [10, "#3271c9", "#bcd6ef", "#fff1d6", "#ffffff", "#8a9ab4", "#253a52", 0, 0.85],
  [30, "#2e6fd3", "#a9cdf0", "#fff8ea", "#ffffff", "#93a5c0", "#2c4660", 0, 1],
  [90, "#2464cc", "#9fc6ee", "#ffffff", "#ffffff", "#9badc7", "#2f4a66", 0, 1],
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lerp = (a, b, k) => a + (b - a) * k;

export function sunElevation(lat, lng, date = new Date()) {
  const s = subsolarPoint(date);
  const cosZ = Math.sin(lat * RAD) * Math.sin(s.lat * RAD) + Math.cos(lat * RAD) * Math.cos(s.lat * RAD) * Math.cos((lng - s.lng) * RAD);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / RAD;
}

export function look(elev) {
  let i = 0;
  while (i < LOOKS.length - 2 && elev > LOOKS[i + 1][0]) i++;
  const a = LOOKS[i], b = LOOKS[i + 1];
  const k = Math.max(0, Math.min(1, (elev - a[0]) / (b[0] - a[0])));
  const mix3 = (j) => hex(a[j]).map((v, n) => lerp(v, hex(b[j])[n], k));
  return {
    zenith: mix3(1), horizon: mix3(2), sun: mix3(3), cloudLit: mix3(4), cloudShade: mix3(5), ground: mix3(6),
    night: lerp(a[7], b[7], k), day: lerp(a[8], b[8], k),
  };
}

