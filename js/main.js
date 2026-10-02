import { loadSettings, settings, effectiveTheme } from "./settings.js";
import { loadAirports, getAirport } from "./airports.js";
import { GlobeView } from "./globe.js";
import { unlockAudio, sfx } from "./audio.js";
import { Departure } from "./ui/departure.js";
import { CheckIn } from "./ui/checkin.js";
import { BoardingPass } from "./ui/pass.js";
import { Flight } from "./ui/flight.js";
import { SettingsPanel } from "./ui/settings-panel.js";

const $ = (id) => document.getElementById(id);
const app = $("app");

function applyTheme() {
  const theme = effectiveTheme();
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "day" ? "#dfe6ef" : "#080d18";
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
}

function show(screen) {
  app.dataset.screen = screen;
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

  const flightView = new Flight({
    view,
    root: $("flight-hud"),
    onEnd: () => {
      show("departure");
      departure.setHome(getAirport(settings.home));
    },
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

  show("departure");
  // let the layout settle before measuring the globe for the first camera fit
  requestAnimationFrame(() => departure.setHome(home));

  window.contrail = { view, departure, checkin, pass, flightView, settings };
}

window.addEventListener("load", boot);
