// Flight records + the active flight, local-first in IndexedDB.
// A record is the archived boarding pass plus what actually happened.
import { kvGet, kvSet, flightsPut, flightsAll } from "./store.js";
import { now } from "./clock.js";
import { haversineKm } from "./geo.js";

export const DIVERT_AFTER_MS = 10000;

let cache = null;

export async function allFlights() {
  if (!cache) cache = (await flightsAll()).sort((a, b) => b.startedAt - a.startedAt);
  return cache;
}

export async function saveFlight(rec) {
  rec.updatedAt = Date.now();
  await flightsPut(rec);
  const list = await allFlights();
  const i = list.findIndex((f) => f.id === rec.id);
  if (i >= 0) list[i] = rec; else list.unshift(rec);
  list.sort((a, b) => b.startedAt - a.startedAt);
}

/** IATA codes Henry has landed at (completed flights only). */
export async function visitedSet() {
  const s = new Set();
  for (const f of await allFlights()) if (f.status === "landed") s.add(f.dest);
  return s;
}

/* ---------- active flight ---------- */

export const getActive = () => kvGet("activeFlight", null);
export const setActive = (f) => kvSet("activeFlight", f);
export const clearActive = () => kvSet("activeFlight", null);

/** Milliseconds actually flown (pauses excluded). */
export function flownMs(f, t = now()) {
  const paused = f.pausedMs + (f.pausedAt ? t - f.pausedAt : 0);
  return Math.max(0, Math.min(f.durationMin * 60000, t - f.startedAt - paused));
}

export function progressOf(f, t = now()) {
  return flownMs(f, t) / (f.durationMin * 60000);
}

export function toRecord(f, status, t = now()) {
  const p = status === "landed" ? 1 : progressOf(f, t);
  return {
    id: f.id,
    origin: f.origin.iata, originCity: f.origin.city,
    dest: f.dest.iata, destCity: f.dest.city, destCountry: f.dest.country,
    divertedTo: f.divertedTo || null,
    distKm: Math.round(f.distKm), flownKm: Math.round(f.distKm * p),
    durationMin: f.durationMin, flownMin: Math.round((flownMs(f, t) / 60000) * 10) / 10,
    scale: f.scale, seat: f.seat, cls: f.cls,
    tagId: f.tag.id, tagName: f.tag.name, tagColor: f.tag.color,
    flightNo: f.flightNo, gate: f.gate, group: f.group,
    startedAt: f.startedAt, endedAt: t, status,
    firstVisit: !!f.firstVisit,
  };
}

/* ---------- stats ---------- */

const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export function stats(list) {
  let minutes = 0, km = 0, flights = 0;
  const cities = new Set();
  const days = new Set();
  for (const f of list) {
    minutes += f.flownMin || 0;
    km += f.flownKm || 0;
    if (f.status === "landed") { flights++; cities.add(f.dest); }
    if ((f.flownMin || 0) >= 1) days.add(dayKey(f.startedAt));
  }
  // streak: consecutive days with focus, ending today (or yesterday if today is still empty)
  let streak = 0;
  const d = new Date(); d.setHours(12, 0, 0, 0);
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
  return { minutes, km, flights, cities: cities.size, streak };
}

/** Minutes per local day for the heatmap, optionally for one tag. */
export function minutesByDay(list, tagId = null) {
  const m = new Map();
  for (const f of list) {
    if (tagId && f.tagId !== tagId) continue;
    const k = dayKey(f.startedAt);
    m.set(k, (m.get(k) || 0) + (f.flownMin || 0));
  }
  return { get: (date) => m.get(dayKey(date.getTime())) || 0 };
}

export { dayKey };

/* ---------- backup ---------- */

export async function exportJSON(extra) {
  return JSON.stringify({ app: "contrail", version: 1, exportedAt: new Date().toISOString(), ...extra, flights: await allFlights() }, null, 1);
}

/** Merge flights from a backup: last-write-wins per record. Returns the number added or updated. */
export async function importFlights(data) {
  if (!data || data.app !== "contrail" || !Array.isArray(data.flights)) throw new Error("Not a Contrail backup file.");
  const mine = new Map((await allFlights()).map((f) => [f.id, f]));
  let n = 0;
  for (const f of data.flights) {
    if (!f || typeof f.id !== "string" || typeof f.startedAt !== "number") continue;
    const cur = mine.get(f.id);
    if (!cur || (f.updatedAt || 0) > (cur.updatedAt || 0)) { await flightsPut(f); n++; }
  }
  cache = null;
  return n;
}

/** Nearest airport to a point, for diversions. */
export function nearestAirport(list, lat, lng, exclude = []) {
  let best = null, bd = Infinity;
  for (const a of list) {
    if (!a.large || exclude.includes(a.iata)) continue;
    const d = haversineKm(lat, lng, a.lat, a.lng);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}
