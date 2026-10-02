// Passport stamps, generated as SVG. Each city gets its own design (shape, ink,
// border, ornament) derived from its IATA code, unlocked on the first visit;
// every stamp also carries the date, duration and purpose of that flight.
import { esc, hash, rng } from "./ui/common.js";

const INKS = ["#b8452f", "#2f5d8a", "#2e7a5b", "#6b3fa0", "#9a5a12", "#1f5f6e", "#8a2f5a", "#3d4f9a"];
const SHAPES = ["circle", "octagon", "rect", "notched", "hexagon", "oval"];

function shapePath(shape, r) {
  const c = 100;
  switch (shape) {
    case "octagon": case "hexagon": {
      const n = shape === "octagon" ? 8 : 6;
      const off = Math.PI / n;
      return Array.from({ length: n }, (_, i) => {
        const a = off + (i * 2 * Math.PI) / n;
        return `${i ? "L" : "M"}${(c + r * Math.cos(a)).toFixed(1)} ${(c + r * Math.sin(a)).toFixed(1)}`;
      }).join("") + "Z";
    }
    case "rect": return `M${c - r} ${c - r * 0.72}h${2 * r}v${1.44 * r}h${-2 * r}Z`;
    case "notched": {
      const w = r, h = r * 0.74, k = r * 0.2;
      return `M${c - w + k} ${c - h}H${c + w - k}L${c + w} ${c - h + k}V${c + h - k}L${c + w - k} ${c + h}H${c - w + k}L${c - w} ${c + h - k}V${c - h + k}Z`;
    }
    case "oval": return `M${c - r} ${c}a${r} ${r * 0.72} 0 1 0 ${2 * r} 0a${r} ${r * 0.72} 0 1 0 ${-2 * r} 0Z`;
    default: return `M${c - r} ${c}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  }
}

/** The fixed design for a city. */
export function cityDesign(iata) {
  const r = rng(hash(`stamp:${iata}`));
  return {
    shape: SHAPES[Math.floor(r() * SHAPES.length)],
    ink: INKS[Math.floor(r() * INKS.length)],
    border: ["double", "dashed", "dotted", "solid"][Math.floor(r() * 4)],
    ornament: ["plane", "stars", "rays", "wings"][Math.floor(r() * 4)],
  };
}

const ORNAMENT = {
  plane: `<path d="M100 38 l3 10 14 7 v3 l-14-3 -1 9 5 4 v2 l-7-2 -7 2 v-2 5-4 -1-9 -14 3 v-3 14-7z" />`,
  stars: `<g><path d="M80 46l1.8 4 4.2.4-3.2 2.8 1 4.2-3.8-2.2-3.8 2.2 1-4.2-3.2-2.8 4.2-.4z"/><path d="M100 40l2.2 5 5.2.5-4 3.4 1.2 5.1-4.6-2.7-4.6 2.7 1.2-5.1-4-3.4 5.2-.5z"/><path d="M120 46l1.8 4 4.2.4-3.2 2.8 1 4.2-3.8-2.2-3.8 2.2 1-4.2-3.2-2.8 4.2-.4z"/></g>`,
  rays: `<g>${Array.from({ length: 9 }, (_, i) => { const a = Math.PI * (1.1 + i * 0.1); return `<path d="M${100 + 18 * Math.cos(a)} ${62 + 18 * Math.sin(a)}L${100 + 28 * Math.cos(a)} ${62 + 28 * Math.sin(a)}" stroke-width="2.2" stroke="currentColor"/>`; }).join("")}<circle cx="100" cy="62" r="8"/></g>`,
  wings: `<path d="M100 44c-4 0-6 3-6 6s2 6 6 6 6-3 6-6-2-6-6-6zm-10 5c-8-2-18-1-26 2 8 1 16 3 24 5zm20 0c8-2 18-1 26 2-8 1-16 3-24 5z"/>`,
};

/**
 * @param {object} f  flight record (dest, destCity, startedAt, durationMin, tagName, firstVisit, id)
 * @param {object} [opts] { size, tilt }
 */
export function stampSVG(f, { size = 200, tilt = true, idPrefix = "s" } = {}) {
  const d = cityDesign(f.dest);
  const r = rng(hash(f.id || f.dest));
  const rot = tilt ? (r() * 16 - 8).toFixed(1) : 0;
  const date = new Date(f.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  const mins = Math.round(f.flownMin ?? f.durationMin);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}H ${String(mins % 60).padStart(2, "0")}M` : `${mins} MIN`;
  const fid = `${idPrefix}${hash(String(f.id) + idPrefix).toString(36)}`;
  const outer = shapePath(d.shape, 86);
  const inner = shapePath(d.shape, 76);
  const dash = { double: "", dashed: "6 4", dotted: "1.5 4", solid: "" }[d.border];
  const city = esc(String(f.destCity || f.dest).toUpperCase().slice(0, 18));
  const arc = d.shape === "circle" || d.shape === "oval" || d.shape === "octagon";
  return `<svg class="stamp" viewBox="0 0 200 200" width="${size}" height="${size}" style="color:${d.ink}" role="img" aria-label="Stamp ${esc(f.dest)} ${esc(f.destCity || "")}">
    <defs>
      <filter id="${fid}" x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${hash(f.dest) % 97}" result="n"/>
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.55" result="worn"/>
        <feComposite in="SourceGraphic" in2="worn" operator="in" result="inked"/>
        <feTurbulence type="turbulence" baseFrequency="0.04" numOctaves="1" seed="${hash(f.id || "") % 97}" result="w"/>
        <feDisplacementMap in="inked" in2="w" scale="2.2"/>
      </filter>
      ${arc ? `<path id="${fid}a" d="M38 100 A62 62 0 0 1 162 100"/><path id="${fid}b" d="M44 104 A56 56 0 0 0 156 104"/>` : ""}
    </defs>
    <g transform="rotate(${rot} 100 100)" filter="url(#${fid})" fill="currentColor" stroke="currentColor" opacity="0.88">
      <path d="${outer}" fill="none" stroke-width="${d.border === "double" ? 2.4 : 3.2}" ${dash ? `stroke-dasharray="${dash}"` : ""}/>
      ${d.border === "double" ? `<path d="${inner}" fill="none" stroke-width="1.4"/>` : `<path d="${inner}" fill="none" stroke-width="0.8" opacity=".6"/>`}
      <g stroke="none">${ORNAMENT[d.ornament]}</g>
      ${arc
        ? `<text font-family="IBM Plex Mono, monospace" font-size="10.5" font-weight="500" letter-spacing="2.4" stroke="none" text-anchor="middle"><textPath href="#${fid}a" startOffset="50%">${city}</textPath></text>`
        : `<text x="100" y="${d.shape === "rect" || d.shape === "notched" ? 82 : 80}" font-family="IBM Plex Mono, monospace" font-size="10.5" font-weight="500" letter-spacing="2" stroke="none" text-anchor="middle">${city}</text>`}
      <text x="100" y="118" font-family="Big Shoulders Display, sans-serif" font-weight="800" font-size="40" letter-spacing="3" stroke="none" text-anchor="middle">${esc(f.dest)}</text>
      <path d="M58 126h84" stroke-width="1.2"/>
      <text x="100" y="140" font-family="IBM Plex Mono, monospace" font-size="9.5" font-weight="500" letter-spacing="1.2" stroke="none" text-anchor="middle">${date}</text>
      ${arc
        ? `<text font-family="IBM Plex Mono, monospace" font-size="8.5" letter-spacing="1.6" stroke="none" text-anchor="middle"><textPath href="#${fid}b" startOffset="50%">${dur} · ${esc(String(f.tagName || "").toUpperCase().slice(0, 14))}</textPath></text>`
        : `<text x="100" y="153" font-family="IBM Plex Mono, monospace" font-size="8.5" letter-spacing="1.4" stroke="none" text-anchor="middle">${dur} · ${esc(String(f.tagName || "").toUpperCase().slice(0, 14))}</text>`}
      ${f.firstVisit ? `<g transform="rotate(-14 100 100)"><rect x="46" y="160" width="108" height="16" rx="2" fill="none" stroke-width="1.6"/><text x="100" y="172" font-family="IBM Plex Mono, monospace" font-size="9" font-weight="500" letter-spacing="2.6" stroke="none" text-anchor="middle">FIRST VISIT</text></g>` : ""}
    </g>
  </svg>`;
}
