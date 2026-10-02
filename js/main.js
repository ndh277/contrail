import { loadSettings, settings, effectiveTheme } from "./settings.js";
import { loadAirports, getAirport } from "./airports.js";
import { GlobeView } from "./globe.js";
import { unlockAudio, sfx } from "./audio.js";
import { Departure } from "./ui/departure.js";
import { CheckIn } from "./ui/checkin.js";
import { BoardingPass } from "./ui/pass.js";
import { Flight } from "./ui/flight.js";
import { SettingsPanel } from "./ui/settings-panel.js";
import { Landing } from "./ui/landing.js";
import { Logbook } from "./ui/logbook.js";
import { getActive, visitedSet } from "./flights.js";
import { updateSettings } from "./settings.js";
import { BottomSheet } from "./ui/sheet.js";

const $ = (id) => document.getElementById(id);
const app = $("app");

let globeView = null;
let sheet = null;

function applyTheme() {
  const theme = effectiveTheme();
  globeView?.setStarOpacity(theme === "night" ? 1 : 0);
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "day" ? "#dfe6ef" : "#080d18";
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
}

/**
 * Switch screens. Where the browser supports View Transitions, shared pieces morph
 * from one screen into the next (destination card → check-in header, print button →
 * boarding pass, pass → in-flight card…) instead of fading.
 */
function show(screen) {
  const prev = app.dataset.screen;
  const apply = () => { app.dataset.screen = screen; };
  // calm frame rates where the globe is only a backdrop (flight sets its own)
  // landscape keeps the globe in view beside the panel, so it gets the full rate there too
  const side = innerWidth > innerHeight && innerWidth >= 820;
  const fps = { departure: 60, checkin: side ? 60 : 15, pass: side ? 60 : 15, logbook: side ? 60 : 10, landing: 60 }[screen];
  if (fps && globeView) globeView.setFps(fps);
  const morph = document.startViewTransition && prev !== "boot" && prev !== screen &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (morph) {
    document.documentElement.classList.add("vt");
    const vt = document.startViewTransition(apply);
    vt.finished.finally(() => document.documentElement.classList.remove("vt"));
  } else apply();
  requestAnimationFrame(() => updateGlobeOffset(700));
}

/** Centre the globe in whatever part of the screen the glass panels leave visible. */
function updateGlobeOffset(ease = 0) {
  const view = globeView;
  if (!view) return;
  const scr = app.dataset.screen;
  if (scr === "flight" || scr === "landing") return;      // the flight view manages its own
  const W = innerWidth, H = innerHeight;
  const landscape = W > H && W >= 820;
  // layout boxes (offset*), not getBoundingClientRect: panels may still be sliding in
  const bar = document.querySelector(".topbar");
  const top = bar.offsetTop + bar.offsetHeight;
  if (landscape) {
    // tablet: the master column sits on the left, the globe fills the rest
    const panel = scr === "departure" ? $("departure") : document.querySelector(`#${{ checkin: "checkin", pass: "pass-screen", logbook: "logbook" }[scr]}`);
    const used = panel ? panel.offsetLeft + panel.offsetWidth : 0;
    view.setCenterOffset(-used / 2, -top / 2, { w: W - used - 24, h: H - top - 20 }, ease);
  } else if (scr === "departure") {
    const sheetTop = H - (sheet ? sheet.visible : $("departure").offsetHeight);
    const visH = sheetTop - top;
    view.setCenterOffset(0, (H - sheetTop - top) / 2, { w: W, h: visH }, ease);
  } else {
    view.setCenterOffset(0, 0, null, ease);
  }
}

async function boot() {
  await loadSettings();
  applyTheme();
  setInterval(applyTheme, 60000);
  registerServiceWorker();
  unlockAudio();

  await loadAirports();
  const home = getAirport(settings.home) || getAirport("HAN");
  $("home-code").textContent = home.iata;

  const view = new GlobeView($("globe"));
  globeView = view;
  applyTheme();
  addEventListener("resize", () => requestAnimationFrame(() => updateGlobeOffset()));
  // the departure sheet: peek (time + dial), half, full
  const depEl = $("departure");
  sheet = new BottomSheet(depEl, {
    handles: [depEl.querySelector(".sheet-grip"), depEl.querySelector(".readout")],
    detents: () => {
      const dial = $("dial");
      const peek = dial.offsetTop + dial.offsetHeight + 18;
      return [peek, Math.round(innerHeight * 0.54), depEl.offsetHeight];
    },
    onChange: () => { if (app.dataset.screen === "departure") updateGlobeOffset(); },
  });
  requestAnimationFrame(() => sheet.snap(1, false));
  new ResizeObserver(() => updateGlobeOffset()).observe($("departure"));
  view.pointOfView({ lat: home.lat, lng: home.lng, altitude: 2.4 }, 0);

  const departure = new Departure({
    view,
    root: $("departure"),
    onCheckIn: (trip) => { checkin.open(trip); show("checkin"); },
  });

  const checkin = new CheckIn({
    root: $("checkin"),
    onBack: () => show("departure"),
    onPrint: (flight) => { show("pass"); pass.open(flight); },
  });

  const pass = new BoardingPass({
    root: $("pass-screen"),
    onBack: () => { pass.close(); show("checkin"); },
    onTorn: (flight) => { show("flight"); flightView.start(flight); },
  });

  const refreshVisited = async () => {
    const seen = await visitedSet();
    view.setVisited([...seen].map((iata) => getAirport(iata)?.i).filter((i) => i != null));
  };

  const flightView = new Flight({
    view,
    root: $("flight-hud"),
    onLanded: (rec) => { show("landing"); landing.show(rec, { home: settings.home }); },
  });

  const landing = new Landing({
    root: $("landing"),
    onDone: async (next, rec) => {
      flightView.reset();
      if (next === "continue" && getAirport(rec.dest)) {
        await updateSettings({ home: rec.dest });
        $("home-code").textContent = rec.dest;
      }
      show("departure");
      departure.setHome(getAirport(settings.home));
      refreshVisited();
    },
  });

  const logbook = new Logbook({
    root: $("logbook"),
    onBack: () => show("departure"),
    onChange: refreshVisited,
  });
  $("logbook-btn").addEventListener("click", () => {
    if (app.dataset.screen !== "departure") return;
    sfx.tap(); logbook.open(); show("logbook");
  });

  const panel = new SettingsPanel({
    dialog: $("settings-dialog"),
    onHome: (a) => { $("home-code").textContent = a.iata; departure.setHome(a); },
    onScale: () => departure.rescale(),
    onTheme: applyTheme,
    onDial: (style) => { departure.dial.setStyle(style); sheet.snap(sheet.index, false); },
  });
  $("settings-btn").addEventListener("click", () => { sfx.tap(); panel.open(); });
  $("home-chip").addEventListener("click", () => {
    if (app.dataset.screen !== "departure") return;
    sfx.tap(); panel.open(true);
  });

  // let the layout settle before measuring the globe for the first camera fit
  requestAnimationFrame(async () => {
    departure.setHome(home);
    await refreshVisited();
    const active = await getActive();
    if (active) { show("flight"); flightView.resume(active); }
    else show("departure");
  });

  // ---- keyboard: the desktop way through every step of the flight ----
  addEventListener("keydown", (e) => {
    const scr = app.dataset.screen;
    const typing = e.target.matches("input, textarea, [contenteditable]");
    const dlgOpen = document.querySelector("dialog[open]");
    if (typing || dlgOpen) return;
    const k = e.key;
    const cmd = e.ctrlKey || e.metaKey;
    const help = $("shortcuts");
    if (k === "?") { help.hidden = !help.hidden; return; }
    if (!help.hidden && k === "Escape") { help.hidden = true; return; }
    if (scr === "departure") {
      if (k === "Enter" && departure.selected >= 0) { e.preventDefault(); departure.checkIn(); }
      else if (k === "l" || k === "L") $("logbook-btn").click();
      else if (k === "ArrowLeft" || k === "ArrowRight") { if (document.activeElement !== $("dial")) { e.preventDefault(); departure.dial.nudge(k === "ArrowRight" ? 1 : -1); } }
    } else if (scr === "checkin") {
      if (k === "Enter") { e.preventDefault(); checkin.print(); }
      else if (k === "Escape") show("departure");
    } else if (scr === "pass") {
      if (k === "Enter" && cmd) { e.preventDefault(); pass.tearNow?.(); }
      else if (k === "Escape") { pass.close(); show("checkin"); }
    } else if (scr === "flight") {
      if (k === " ") { e.preventDefault(); flightView.togglePause(); }
      else if (k === "g" || k === "G") flightView.setMode("globe");
      else if (k === "d" || k === "D") flightView.setMode("chase");
      else if (k === "w" || k === "W") flightView.setMode("window");
      else if (k === "s" || k === "S") app.classList.contains("shade-down") ? flightView.openShade() : flightView.closeShade();
      else if (k === "m" || k === "M") flightView.toggleMixer();
      else if (k === "p" || k === "P") flightView.companion.win ? flightView.companion.closeMini() : flightView.companion.openMini();
      else if (k === "Escape" && !e.repeat) flightView.abortStart?.();
    } else if (scr === "landing") {
      if (k === "Enter") document.querySelector("#landing-next .btn.primary")?.click();
    } else if (scr === "logbook") {
      if (k === "Escape") show("departure");
      else if (k === "ArrowRight") logbook.turn(1);
      else if (k === "ArrowLeft") logbook.turn(-1);
    }
  });
  addEventListener("keyup", (e) => { if (e.key === "Escape" && app.dataset.screen === "flight") flightView.abortCancel?.(); });

  window.contrail = { view, departure, checkin, pass, flightView, landing, logbook, settings };

  // ?debug — a small meter: globe frames per second, frame time, resolution
  if (new URLSearchParams(location.search).has("debug")) {
    const meter = document.createElement("div");
    meter.style.cssText = "position:fixed;left:8px;bottom:calc(env(safe-area-inset-bottom) + 8px);z-index:99;padding:6px 9px;border-radius:10px;background:rgba(0,0,0,.72);color:#9fe8a8;font:500 11px/1.35 'IBM Plex Mono',monospace;pointer-events:none;white-space:pre";
    document.body.append(meter);
    let lastDraws = 0, lastT = performance.now(), worst = 0, prev = performance.now();
    const rafLoop = (t) => { worst = Math.max(worst, t - prev); prev = t; requestAnimationFrame(rafLoop); };
    requestAnimationFrame(rafLoop);
    setInterval(() => {
      const now = performance.now();
      const fps = ((view.draws || 0) - lastDraws) / ((now - lastT) / 1000);
      lastDraws = view.draws || 0; lastT = now;
      meter.textContent = `globe ${fps.toFixed(0)} fps (cap ${now < view.burstUntil ? 60 : view.fpsCap})\nframe ${(view.frameEma || 0).toFixed(1)} ms · worst ${worst.toFixed(0)} ms\nres ${view.pixelRatio}x / ${view.maxPixelRatio}x · ${view.tier}`;
      worst = 0;
    }, 1000);
  }
}

window.addEventListener("load", boot);
