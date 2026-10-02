// Airport dataset (OurAirports, public domain): large + medium airports with
// scheduled service and an IATA code. See tools/build-airports.py.
import { haversineKm } from "./geo.js";

export let airports = [];          // [{ iata, name, city, country, countryName, lat, lng, large, i }]
const byIata = new Map();

export async function loadAirports() {
  if (airports.length) return airports;
  const res = await fetch("data/airports.json");
  const data = await res.json();
  airports = data.rows.map(([iata, name, city, country, lat, lng, large], i) => ({
    iata, name, city, country, countryName: data.countries[country] || country, lat, lng, large: !!large, i,
  }));
  airports.forEach((a) => byIata.set(a.iata, a));
  return airports;
}

export function getAirport(iata) { return byIata.get(iata); }

/** Distances (km) from `origin` to every airport, plus indices sorted by distance. */
export function distancesFrom(origin) {
  const dist = new Float32Array(airports.length);
  for (const a of airports) dist[a.i] = haversineKm(origin.lat, origin.lng, a.lat, a.lng);
  const order = Uint32Array.from(airports.keys()).sort((x, y) => dist[x] - dist[y]);
  return { dist, order };
}

// Extra names people actually type.
const ALIASES = { SGN: "saigon sai gon", HAN: "hanoi", DAD: "danang", HUI: "hue", CXR: "nhatrang", PQC: "phuquoc", VCA: "cantho", DLI: "dalat" };

/** Lowercase, strip diacritics (Vietnamese included), so "ha noi" finds "Hà Nội". */
export const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");

export function searchAirports(query, limit = 30) {
  const q = fold(query.trim());
  if (!q) return [];
  const qs = q.replace(/\s+/g, "");
  const scored = [];
  for (const a of airports) {
    const iata = a.iata.toLowerCase();
    const city = fold(a.city);
    const alias = ALIASES[a.iata] || "";
    let s = -1;
    if (iata === q) s = 100;
    else if (iata.startsWith(q)) s = 80;
    else if (city.startsWith(q) || city.replace(/\s+/g, "").startsWith(qs) || alias.startsWith(q) || alias.includes(` ${q}`)) s = 60;
    else if (city.includes(q)) s = 40;
    else if (fold(a.name).includes(q)) s = 30;
    else if (fold(a.countryName).startsWith(q)) s = 20;
    if (s >= 0) scored.push([s + (a.large ? 5 : 0), a]);
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map((x) => x[1]);
}
