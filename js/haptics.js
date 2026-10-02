// Every haptic pattern in one place, so they're easy to tune on the S24 Ultra.
// Chrome only controls timing (not intensity), so moments differ by rhythm.
import { settings } from "./settings.js";

export const HAPTICS = {
  dialDetent: 8,
  radarHit: [12, 30, 12],
  seatbelt: 20,
  tagSnap: 10,
  tearTension: 5,
  stubTear: [40, 20, 60],
  abortComplete: [30, 40, 30, 40, 80],
  stampSlam: [90],
  tap: 6,
};

let last = 0;
export function haptic(name, { minGapMs = 0 } = {}) {
  if (!settings.haptics || !navigator.vibrate) return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  const now = performance.now();
  if (now - last < minGapMs) return;
  last = now;
  try { navigator.vibrate(HAPTICS[name] ?? 0); } catch { /* not allowed before user activation */ }
}
