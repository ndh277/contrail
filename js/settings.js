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
  units: "mi",            // mi | km (logbook)
  lastTagId: null,
  lastDuration: 25,
  hubsOnly: false,
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
  Object.assign(settings, DEFAULTS, await kvGet("settings", {}));
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
  high: { pixelRatio: 2.5, texture: "4k" },
  medium: { pixelRatio: 1.75, texture: "4k" },
  low: { pixelRatio: 1.25, texture: "2k" },
};
