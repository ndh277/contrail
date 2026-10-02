import { loadSettings, settings, effectiveTheme, qualityTier } from "./settings.js";
import { loadAirports, getAirport, airports } from "./airports.js";
import { GlobeView } from "./globe.js";

const $ = (id) => document.getElementById(id);

function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "day" ? "#dfe6ef" : "#080d18";
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) { $("stat-offline").textContent = "not supported"; return; }
  navigator.serviceWorker.register("sw.js").then(async () => {
    await navigator.serviceWorker.ready;
    $("stat-offline").textContent = "ready";
  }).catch(() => { $("stat-offline").textContent = "failed"; });
}

async function boot() {
  await loadSettings();
  applyTheme();
  setInterval(applyTheme, 60000);
  registerServiceWorker();

  await loadAirports();
  const home = getAirport(settings.home) || getAirport("HAN");
  $("home-code").textContent = home.iata;
  $("stat-airports").textContent = airports.length.toLocaleString("en-US");
  $("stat-home").textContent = `${home.iata} · ${home.city}`;
  $("stat-quality").textContent = `${qualityTier()} · dpr ${window.devicePixelRatio}`;
  const vp = () => { $("stat-viewport").textContent = `${innerWidth}×${innerHeight}`; };
  vp(); addEventListener("resize", vp);

  const view = new GlobeView($("globe"));
  view.pointOfView({ lat: home.lat, lng: home.lng, altitude: 2.2 });
  const s = view.sun;
  $("stat-sun").textContent = `${s.lat.toFixed(1)}°, ${s.lng.toFixed(1)}°`;
  document.getElementById("app").dataset.screen = "home";
  window.contrail = { view, settings };
}

window.addEventListener("load", boot);
