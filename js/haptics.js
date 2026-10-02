// Every haptic pattern in one place, so they're easy to tune on the S24 Ultra.
// Chrome only controls timing (not intensity), so moments differ by rhythm.
import { settings } from "./settings.js";

export const HAPTICS = {
  dialDetent: 6,                         // a light ratchet click every minute
  dialMajor: [10, 18, 6],                // a heavier notch every 15 minutes
  radarTick: 4,                          // tiny ticks as small airports come into range
  radarHit: [12, 30, 12],                // a double pulse for hubs
  seatbelt: [8, 50, 22],                 // tongue in, then the latch
  seatLight: 6,
  tagSnap: 10,
  emboss: [14, 10, 4],                   // the embosser punching one letter
  tearTension: 5,
  tearRip: [6, 9, 8, 7, 10, 6, 12, 5],   // paper fibres giving way — a rustle, not a buzz
  stubTear: [40, 20, 60],
  abortTick: 12,
  abortComplete: [30, 40, 30, 40, 80],
  stampHover: 4,
  stampSlam: [120],                      // the strongest moment in the app
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
