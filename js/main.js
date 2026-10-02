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

const $ = (id) => document.getElementById(id);
const app = $("app");

let globeView = null;

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

function show(screen) {
  app.dataset.screen = screen;
  requestAnimationFrame(updateGlobeOffset);
}

/** Centre the globe in whatever part of the screen the glass panels leave visible. */
function updateGlobeOffset() {
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
    const panel = scr === "departure" ? $("departure") : document.querySelector(`#${{ checkin: "checkin", pass: "pass-screen", logbook: "logbook" }[scr]}`);
    const used = panel ? W - panel.offsetLeft : 0;
    view.setCenterOffset(used / 2, -top / 2, { w: W - used - 24, h: H - top - 20 });
  } else if (scr === "departure") {
    const sheetTop = $("departure").offsetTop;
    const visH = sheetTop - top;
    view.setCenterOffset(0, (H - sheetTop - top) / 2, { w: W, h: visH });
  } else {
    view.setCenterOffset(0, 0, null);
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
  addEventListener("resize", () => requestAnimationFrame(updateGlobeOffset));
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

  window.contrail = { view, departure, checkin, pass, flightView, landing, logbook, settings };
}

window.addEventListener("load", boot);
