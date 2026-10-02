// Spherical geometry + solar position helpers. All angles in degrees unless noted.

export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_MILE = 1.609344;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const dp = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point a fraction `f` (0..1) along the great circle from A to B. */
export function interpolateGC(lat1, lon1, lat2, lon2, f) {
  const p1 = lat1 * RAD, l1 = lon1 * RAD, p2 = lat2 * RAD, l2 = lon2 * RAD;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-9) return { lat: lat1, lng: lon1 };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) * DEG, lng: Math.atan2(y, x) * DEG };
}

export function initialBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

/**
 * Subsolar point (where the sun is directly overhead) for a Date.
 * Low-precision solar ephemeris (~0.01°), plenty for drawing the terminator.
 */
export function subsolarPoint(date = new Date()) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = ((357.529 + 0.98560028 * d) % 360) * RAD;          // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360;                  // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * RAD;                    // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) * DEG;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) * DEG;
  let eqtHours = (q - ra) / 15;
  eqtHours = ((eqtHours + 12) % 24 + 24) % 24 - 12;
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lng = -15 * (utcHours - 12 + eqtHours);
  lng = ((lng + 540) % 360) - 180;
  return { lat: dec, lng };
}

/** Local solar time (hours 0..24) at a longitude. */
export function localSolarHours(lng, date = new Date()) {
  const sub = subsolarPoint(date);
  return (((lng - sub.lng) / 15 + 12) % 24 + 24) % 24;
}

export function formatDuration(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
}

export function formatClock(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
