// Passport stamps as retro travel-poster postage stamps, generated as SVG.
// Each city gets its own poster (palette + scene, or a landmark for a few home
// cities) derived from its IATA code and location, unlocked on the first visit.
// A postmark cancels each stamp with the date, duration and purpose of that flight.
import { esc, hash, rng } from "./ui/common.js";
import { getAirport } from "./airports.js";

// sky top, sky bottom, sun, far land, near land, water, ink, paper
const PALETTES = [
  { sky: ["#f6c177", "#f29e6b"], sun: "#fff1cf", far: "#d1735a", near: "#7d3b4a", water: "#3f6f8a", ink: "#2a2135" },
  { sky: ["#a8dadc", "#f1e3c8"], sun: "#e76f51", far: "#2a9d8f", near: "#264653", water: "#457b9d", ink: "#1d3557" },
  { sky: ["#2d3a6b", "#c06c84"], sun: "#f8b195", far: "#6c5b7b", near: "#22223b", water: "#4a6fa5", ink: "#1b1b2f" },
  { sky: ["#fefae0", "#e9c46a"], sun: "#d62828", far: "#90be6d", near: "#386641", water: "#4d908e", ink: "#283618" },
  { sky: ["#ffd6ba", "#ffb4a2"], sun: "#fff3e0", far: "#e5989b", near: "#6d6875", water: "#5e81ac", ink: "#3d2c3e" },
  { sky: ["#f2cc8f", "#e07a5f"], sun: "#f4f1de", far: "#81b29a", near: "#3d405b", water: "#3d5a80", ink: "#272932" },
];

const EAST_ASIA = new Set(["VN", "CN", "TW", "HK", "MO", "JP", "KR", "TH", "LA", "KH", "MM"]);

/** The fixed design for a city: palette + scene. */
export function cityDesign(iata) {
  const r = rng(hash(`stamp:${iata}`));
  const a = getAirport(iata);
  const pal = PALETTES[Math.floor(r() * PALETTES.length)];
  let scene;
  if (LANDMARKS[iata]) scene = iata;
  else {
    const lat = Math.abs(a?.lat ?? 30);
    const pool = EAST_ASIA.has(a?.country) && r() < 0.55 ? ["pagoda"]
      : lat < 24 ? ["palms", "coast", "palms", "skyline"]
      : lat > 46 ? ["mountains", "skyline", "mountains"]
      : ["coast", "mountains", "skyline", "dunes", "coast"];
    scene = pool[Math.floor(r() * pool.length)];
  }
  return { pal, scene, country: a?.countryName || "", seed: hash(`scene:${iata}`) };
}

/* ---------- scene pieces (drawn in the 120×110 picture box, origin top-left at 40,20) ---------- */

const sun = (r, p, x, y, rad) => `<circle cx="${x}" cy="${y}" r="${rad}" fill="${p.sun}"/>
  <g fill="url(#SKY)">${[0.35, 0.55, 0.72].map((k, i) => `<rect x="${x - rad}" y="${(y + rad * k).toFixed(1)}" width="${rad * 2}" height="${1.4 + i * 0.7}"/>`).join("")}</g>`;

const ridge = (r, y, amp, n, color, x0 = 40, x1 = 160) => {
  let d = `M${x0} 130 L${x0} ${y}`;
  const step = (x1 - x0) / n;
  for (let i = 1; i <= n; i++) d += ` L${(x0 + i * step - step / 2).toFixed(1)} ${(y - amp * (0.4 + r() * 0.6)).toFixed(1)} L${(x0 + i * step).toFixed(1)} ${(y - r() * amp * 0.25).toFixed(1)}`;
  return `<path d="${d} L${x1} 130Z" fill="${color}"/>`;
};

const waves = (p, y, n = 3) => Array.from({ length: n }, (_, i) => {
  const yy = y + 6 + i * 7;
  let d = `M40 ${yy}`;
  for (let x = 40; x < 160; x += 10) d += ` q5 -2.4 10 0`;
  return `<path d="${d}" fill="none" stroke="${p.sun}" stroke-width="1" opacity="${0.55 - i * 0.12}"/>`;
}).join("");

const SCENES = {
  coast(r, p) {
    const sx = 60 + r() * 60;
    return `${sun(r, p, sx, 62, 15 + r() * 6)}
      ${ridge(r, 96, 22, 3, p.far)}
      <rect x="40" y="98" width="120" height="32" fill="${p.water}"/>${waves(p, 98)}
      <g transform="translate(${(70 + r() * 40).toFixed(0)} 88)" fill="${p.near}"><path d="M0 12 h18 l-3 5 h-12z"/><path d="M8 11 V-8 L-2 9z"/><path d="M10 11 V-4 L18 9z" opacity=".8"/></g>`;
  },
  mountains(r, p) {
    const peaks = [[62, 52, 30], [104, 40, 38], [142, 58, 26]];
    const snow = peaks.map(([x, y, w]) => `<path d="M${x} ${y} L${x + w * 0.28} ${y + 14} L${x + w * 0.12} ${y + 11} L${x} ${y + 16} L${x - w * 0.12} ${y + 11} L${x - w * 0.28} ${y + 14}Z" fill="${p.sun}"/>`).join("");
    const body = peaks.map(([x, y, w]) => `<path d="M${x - w * 1.2} 130 L${x} ${y} L${x + w * 1.2} 130Z" fill="${p.far}"/>`).join("");
    return `${sun(r, p, 70 + r() * 50, 46, 12)}${body}${snow}${ridge(r, 112, 14, 6, p.near)}
      <g fill="${p.near}">${Array.from({ length: 7 }, (_, i) => { const x = 46 + i * 17 + r() * 6; return `<path d="M${x} 130 L${x + 4} 112 L${x + 8} 130Z"/>`; }).join("")}</g>`;
  },
  skyline(r, p) {
    let b = "", x = 40;
    while (x < 160) {
      const w = 8 + r() * 12, h = 22 + r() * 52;
      b += `<rect x="${x.toFixed(1)}" y="${(126 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${(h + 4).toFixed(1)}"/>`;
      if (r() < 0.3) b += `<rect x="${(x + w / 2 - 0.6).toFixed(1)}" y="${(126 - h - 10).toFixed(1)}" width="1.2" height="10"/>`;
      x += w + 1.5;
    }
    let lights = "";
    for (let i = 0; i < 26; i++) lights += `<rect x="${(44 + r() * 112).toFixed(1)}" y="${(70 + r() * 50).toFixed(1)}" width="1.6" height="2.2"/>`;
    return `${sun(r, p, 60 + r() * 60, 52, 16)}${ridge(r, 104, 18, 4, p.far)}<g fill="${p.near}">${b}</g><g fill="${p.sun}" opacity=".75">${lights}</g>`;
  },
  palms(r, p) {
    const palm = (x, h, lean) => {
      const tx = x + lean, ty = 126 - h;
      const fronds = [-150, -115, -70, -30, 10].map((a) => {
        const rad = (a * Math.PI) / 180, L = 15;
        return `<path d="M${tx} ${ty} q${(Math.cos(rad) * L * 0.5).toFixed(1)} ${(Math.sin(rad) * L * 0.5 - 6).toFixed(1)} ${(Math.cos(rad) * L).toFixed(1)} ${(Math.sin(rad) * L + 4).toFixed(1)}" stroke="${p.near}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      }).join("");
      return `<path d="M${x} 128 Q${x + lean * 0.3} ${126 - h * 0.5} ${tx} ${ty}" stroke="${p.near}" stroke-width="2.6" fill="none"/>${fronds}`;
    };
    return `${sun(r, p, 100, 70, 22)}<rect x="40" y="96" width="120" height="34" fill="${p.water}"/>${waves(p, 96)}
      <path d="M40 130 Q80 112 125 118 T160 112 V130Z" fill="${p.far}"/>
      ${palm(58, 52, 8)}${palm(138, 44, -10)}${palm(124, 30, -6)}`;
  },
  dunes(r, p) {
    return `${sun(r, p, 70 + r() * 40, 58, 18)}
      <path d="M40 104 Q70 84 100 100 T160 92 V130 H40Z" fill="${p.far}"/>
      <path d="M40 116 Q80 100 120 114 T160 108 V130 H40Z" fill="${p.near}"/>
      <g fill="${p.near}" transform="translate(${(64 + r() * 30).toFixed(0)} 92)"><path d="M0 0 h3 v-6 h-1 v-3 h-1 v3 h-1z"/><path d="M8 0 h3 v-6 h-1 v-3 h-1 v3 h-1z" transform="translate(6 0)"/></g>`;
  },
  pagoda(r, p) {
    let tiers = "";
    const n = 4 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const w = 30 - i * 5, y = 116 - i * 13;
      tiers += `<rect x="${100 - w / 2 + 3}" y="${y - 9}" width="${w - 6}" height="9"/>
        <path d="M${100 - w / 2 - 6} ${y - 8} Q${100 - w / 2} ${y - 9} ${100 - w / 2 + 2} ${y - 13} H${100 + w / 2 - 2} Q${100 + w / 2} ${y - 9} ${100 + w / 2 + 6} ${y - 8} L${100 + w / 2 - 1} ${y - 9} H${100 - w / 2 + 1}Z"/>`;
    }
    const top = 116 - n * 13 - 13;
    return `${sun(r, p, r() < 0.5 ? 64 : 136, 56, 15)}${ridge(r, 104, 20, 4, p.far)}
      <rect x="40" y="116" width="120" height="14" fill="${p.water}"/>
      <g fill="${p.near}">${tiers}<rect x="99" y="${top - 8}" width="2" height="10"/><rect x="82" y="116" width="36" height="4"/></g>`;
  },
};

// A few cities get their landmark.
const LANDMARKS = {
  // Hà Nội: the Turtle Tower in Hoàn Kiếm lake, the red Thê Húc bridge
  HAN: (r, p) => `${sun(r, p, 128, 50, 14)}
    <path d="M40 96 Q60 90 80 95 T120 93 T160 96 V130 H40Z" fill="${p.far}" opacity=".7"/>
    <rect x="40" y="100" width="120" height="30" fill="${p.water}"/>${waves(p, 104, 2)}
    <path d="M42 108 Q58 90 76 106" fill="none" stroke="#c0392b" stroke-width="3"/>
    <path d="M44 104 Q58 88 74 102" fill="none" stroke="#c0392b" stroke-width="1" opacity=".8"/>
    <g fill="${p.near}">
      <ellipse cx="112" cy="108" rx="24" ry="4"/>
      <rect x="101" y="84" width="22" height="22"/><rect x="104" y="72" width="16" height="12"/><rect x="107" y="63" width="10" height="9"/>
      <path d="M99 85 h26 l-2 -3 h-22z M102 73 h20 l-2 -3 h-16z M105 64 h14 l-7 -6z"/>
    </g>
    <g fill="${p.sun}" opacity=".85"><path d="M106 106 v-7 a3 3 0 0 1 6 0 v7z"/><path d="M114 106 v-7 a3 3 0 0 1 6 0 v7z" transform="translate(-1 0)"/><path d="M110 82 v-5 a2 2 0 0 1 4 0 v5z"/></g>`,
  // Sài Gòn: Bến Thành market and its clock tower
  SGN: (r, p) => `${sun(r, p, 62, 52, 15)}
    ${ridge(r, 100, 14, 5, p.far)}
    <g fill="${p.near}">
      <rect x="46" y="96" width="108" height="34"/><path d="M44 97 h112 l-6 -6 h-100z"/>
      <rect x="88" y="62" width="24" height="36"/><path d="M86 63 h28 l-14 -14z"/><rect x="99" y="42" width="2" height="9"/>
    </g>
    <circle cx="100" cy="74" r="6.5" fill="${p.sun}"/><path d="M100 74 v-4 M100 74 h3" stroke="${p.near}" stroke-width="1" stroke-linecap="round"/>
    <g fill="${p.sun}" opacity=".85">${[54, 66, 78, 116, 128, 140].map((x) => `<path d="M${x} 126 v-14 a3.5 3.5 0 0 1 7 0 v14z"/>`).join("")}<path d="M94 126 v-18 a6 6 0 0 1 12 0 v18z"/></g>`,
  // Đà Nẵng: Sơn Trà ridge behind the Dragon Bridge over the Hàn river
  DAD: (r, p) => `${sun(r, p, 130, 52, 16)}
    <path d="M40 96 Q62 66 92 84 T160 80 V130 H40Z" fill="${p.far}"/>
    <rect x="40" y="104" width="120" height="26" fill="${p.water}"/>${waves(p, 104, 2)}
    <path d="M40 104 H160" stroke="${p.near}" stroke-width="2.5"/>
    <path d="M44 103 C54 86 64 86 72 100 S90 112 98 96 S118 82 126 98 S146 108 156 92" fill="none" stroke="${p.sun}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M154 94 l6 -6 l1 4z" fill="${p.sun}"/>
    <g fill="${p.near}">${[52, 76, 100, 124, 148].map((x) => `<rect x="${x}" y="104" width="2.4" height="10"/>`).join("")}</g>`,
};

function perforationMask(id, x, y, w, h, gap = 8.4, rad = 3.2) {
  const holes = [];
  for (let i = 0; i <= Math.round(w / gap); i++) { const cx = x + (i * w) / Math.round(w / gap); holes.push([cx, y], [cx, y + h]); }
  for (let i = 1; i < Math.round(h / gap); i++) { const cy = y + (i * h) / Math.round(h / gap); holes.push([x, cy], [x + w, cy]); }
  return `<mask id="${id}"><rect x="0" y="0" width="200" height="200" fill="#fff"/>${holes.map(([a, b]) => `<circle cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="${rad}" fill="#000"/>`).join("")}</mask>`;
}

/**
 * @param {object} f  flight record (dest, destCity, startedAt, durationMin, tagName, firstVisit, id)
 * @param {object} [opts] { size, tilt }
 */
export function stampSVG(f, { size = 200, tilt = true, idPrefix = "s" } = {}) {
  const d = cityDesign(f.dest);
  const p = d.pal;
  const r = rng(hash(f.id || f.dest));
  const rot = tilt ? (r() * 10 - 5).toFixed(1) : 0;
  const pmRot = (r() * 40 - 20).toFixed(1);
  const date = new Date(f.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }).toUpperCase();
  const mins = Math.round(f.flownMin ?? f.durationMin);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}H${String(mins % 60).padStart(2, "0")}` : `${mins} MIN`;
  const fid = `${idPrefix}${hash(String(f.id) + idPrefix).toString(36)}`;
  const cityRaw = String(f.destCity || f.dest).toUpperCase();
  const city = esc(cityRaw.slice(0, 16));
  const citySize = cityRaw.length > 12 ? 12 : cityRaw.length > 8 ? 15 : 19;
  const scene = (LANDMARKS[d.scene] || SCENES[d.scene])(rng(d.seed), p).replaceAll("url(#SKY)", `url(#${fid}k)`);
  const tag = esc(String(f.tagName || "").toUpperCase().slice(0, 12));
  return `<svg class="stamp" viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="Stamp ${esc(f.dest)} ${esc(f.destCity || "")}">
    <defs>
      ${perforationMask(`${fid}m`, 32, 10, 136, 180)}
      <linearGradient id="${fid}k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient>
      <clipPath id="${fid}c"><rect x="40" y="20" width="120" height="110"/></clipPath>
      <filter id="${fid}p" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${hash(f.dest) % 97}" result="n"/>
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.4 1.6" result="worn"/>
        <feComposite in="SourceGraphic" in2="worn" operator="in" result="inked"/>
        <feTurbulence type="turbulence" baseFrequency="0.05" numOctaves="1" seed="${hash(f.id || "") % 97}" result="w"/>
        <feDisplacementMap in="inked" in2="w" scale="2"/>
      </filter>
      <path id="${fid}a" d="M122 46 A24 24 0 0 1 170 46"/>
      <path id="${fid}b" d="M119 46 A27 27 0 0 0 173 46"/>
    </defs>
    <g transform="rotate(${rot} 100 100)">
      <g mask="url(#${fid}m)" class="stamp-paper">
        <rect x="32" y="10" width="136" height="180" fill="#f7f0de"/>
        <rect x="40" y="20" width="120" height="110" fill="url(#${fid}k)"/>
        <g clip-path="url(#${fid}c)">${scene}</g>
        <rect x="40" y="20" width="120" height="110" fill="none" stroke="${p.ink}" stroke-width="1" opacity=".5"/>
        <text x="100" y="${150 + citySize * 0.15}" font-family="Big Shoulders Display, sans-serif" font-weight="800" font-size="${citySize}" letter-spacing="2" text-anchor="middle" fill="${p.ink}">${city}</text>
        <text x="100" y="166" font-family="IBM Plex Mono, monospace" font-size="7" letter-spacing="1.8" text-anchor="middle" fill="${p.ink}" opacity=".7">${esc(f.dest)} · ${esc(d.country.toUpperCase().slice(0, 14))}</text>
        <text x="100" y="181" font-family="IBM Plex Mono, monospace" font-size="5.6" letter-spacing="1.6" text-anchor="middle" fill="${p.ink}" opacity=".55">CONTRAIL · AIR MAIL</text>
      </g>
      <!-- postmark: cancels the corner of the picture -->
      <g filter="url(#${fid}p)" fill="#1e2433" stroke="#1e2433" opacity="0.8" transform="rotate(${pmRot} 146 46)">
        <circle cx="146" cy="46" r="31" fill="none" stroke-width="1.8"/>
        <circle cx="146" cy="46" r="17" fill="none" stroke-width="0.9"/>
        <text font-family="IBM Plex Mono, monospace" font-size="6.6" font-weight="500" letter-spacing="1.2" stroke="none" text-anchor="middle"><textPath href="#${fid}a" startOffset="50%">${date}</textPath></text>
        <text font-family="IBM Plex Mono, monospace" font-size="5.8" letter-spacing="1" stroke="none" text-anchor="middle" dominant-baseline="hanging"><textPath href="#${fid}b" startOffset="50%">${dur} · ${tag}</textPath></text>
        <text x="146" y="50.5" font-family="Big Shoulders Display, sans-serif" font-weight="800" font-size="12" letter-spacing="0.5" stroke="none" text-anchor="middle">${esc(f.dest)}</text>
        <g fill="none" stroke-width="1.5">${[-9, -3, 3, 9].map((dy) => `<path d="M40 ${46 + dy} q7 -2.6 14 0 t14 0 t14 0 t14 0 t14 0"/>`).join("")}</g>
      </g>
      ${f.firstVisit ? `<g transform="rotate(-8 100 120)" filter="url(#${fid}p)" fill="#a3271b" stroke="#a3271b" opacity=".9"><rect x="62" y="110" width="76" height="16" rx="2" fill="#f7f0de" fill-opacity=".55" stroke-width="1.8"/><text x="100" y="121.5" font-family="IBM Plex Mono, monospace" font-size="8.6" font-weight="600" letter-spacing="2.4" stroke="none" text-anchor="middle">FIRST VISIT</text></g>` : ""}
    </g>
  </svg>`;
}
