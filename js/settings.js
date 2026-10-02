// User settings + purpose tags, persisted in IndexedDB.
import { kvGet, kvSet } from "./store.js";

export const CRUISE_KMH = 800;

const DEFAULTS = {
  home: "HAN",
  routeScale: 1,          // 1, 2 or 4
  sound: true,
  volume: 0.8,
  haptics: true,
  theme: "auto",          // auto | night | day
  quality: "auto",        // auto | high | medium | low
  units: "nm",            // nm | mi | km (logbook)
  unitsV: 2,              // bumped when the default unit changed to nautical miles
  lastTagId: null,
  lastDuration: 25,
  hubsOnly: false,
  dialStyle: "arc",       // arc (throttle quadrant) | tape
};

export const TAG_COLORS = [
  "#f4b15a", "#ff8a6b", "#e86fa0", "#a98bff",
  "#6fa8ff", "#5fd0c8", "#9bd36a", "#e8e1cf",
];

const DEFAULT_TAGS = [
  { id: "cfa", name: "CFA L1", color: "#f4b15a" },
  { id: "fmva", name: "FMVA", color: "#6fa8ff" },
  { id: "neu", name: "NEU", color: "#ff8a6b" },
  { id: "waasee", name: "Waasee", color: "#5fd0c8" },
  { id: "reading", name: "Reading", color: "#a98bff" },
  { id: "deep", name: "Deep Work", color: "#e8e1cf" },
];

export const settings = { ...DEFAULTS };
export let tags = DEFAULT_TAGS.map((t) => ({ ...t }));

const listeners = new Set();
export function onSettingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function loadSettings() {
  const stored = await kvGet("settings", {});
  Object.assign(settings, DEFAULTS, stored);
  // the logbook speaks aviation: nautical miles by default (once; later choices stick)
  if (stored.unitsV !== 2) { settings.units = "nm"; settings.unitsV = 2; }
  const saved = await kvGet("tags", null);
  if (Array.isArray(saved) && saved.length) tags = saved;
  return settings;
}

export async function updateSettings(patch) {
  Object.assign(settings, patch);
  await kvSet("settings", { ...settings });
  listeners.forEach((fn) => fn(patch, settings));
}

export async function saveTags(next) {
  tags = next;
  await kvSet("tags", tags);
  listeners.forEach((fn) => fn({ tags }, settings));
}

export function effectiveTheme() {
  if (settings.theme !== "auto") return settings.theme;
  const h = new Date().getHours();
  return h >= 6 && h < 18 ? "day" : "night";
}

/** Quality tier resolved for this device. */
export function qualityTier() {
  if (settings.quality !== "auto") return settings.quality;
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (mem >= 8 && cores >= 8) return "high";
  if (mem >= 4) return "medium";
  return "low";
}

export const QUALITY = {
  // the globe is soft imagery: past ~2x the extra pixels only cost heat
  high: { pixelRatio: 2, texture: "4k" },
  medium: { pixelRatio: 1.5, texture: "4k" },
  low: { pixelRatio: 1.15, texture: "2k" },
};
