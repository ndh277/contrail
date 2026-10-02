// Contrail service worker.
// App code (HTML/JS/CSS) is network-first so new deploys show up immediately;
// heavy, versioned assets (vendor libs, textures, airport data) are cache-first.
// Everything except the Google 3D mode (M3) works offline.

const VERSION = "polish-1";
const SHELL_CACHE = `contrail-shell-${VERSION}`;
const ASSET_CACHE = "contrail-assets-v1";

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "config.js",
  "css/fonts.css",
  "css/tokens.css",
  "css/app.css",
  "js/main.js",
  "js/geo.js",
  "js/store.js",
  "js/settings.js",
  "js/airports.js",
  "js/globe.js",
  "js/haptics.js",
  "js/audio.js",
  "js/spring.js",
  "js/ui/common.js",
  "js/ui/dial.js",
  "js/ui/departure.js",
  "js/ui/checkin.js",
  "js/ui/pass.js",
  "js/ui/flight.js",
  "js/ui/settings-panel.js",
  "assets/icons/icon.svg",
  "assets/icons/icon-192.png",
];

const ASSETS = [
  "vendor/globe.gl-2.46.2.min.js",
  "vendor/three.core-0.185.1.min.js",
  "data/airports.json",
  "assets/textures/earth-day-4k.jpg",
  "assets/textures/earth-night-4k.jpg",
  "assets/textures/earth-day-2k.jpg",
  "assets/textures/earth-night-2k.jpg",
  "assets/fonts/be-vietnam-pro-latin-400-normal.woff2",
  "assets/fonts/be-vietnam-pro-latin-600-normal.woff2",
  "assets/fonts/be-vietnam-pro-latin-ext-400-normal.woff2",
  "assets/fonts/be-vietnam-pro-latin-ext-600-normal.woff2",
  "assets/fonts/be-vietnam-pro-vietnamese-400-normal.woff2",
  "assets/fonts/be-vietnam-pro-vietnamese-600-normal.woff2",
  "assets/fonts/big-shoulders-display-latin-600-normal.woff2",
  "assets/fonts/big-shoulders-display-latin-800-normal.woff2",
  "assets/fonts/big-shoulders-display-latin-ext-600-normal.woff2",
  "assets/fonts/big-shoulders-display-latin-ext-800-normal.woff2",
  "assets/fonts/big-shoulders-display-vietnamese-600-normal.woff2",
  "assets/fonts/big-shoulders-display-vietnamese-800-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-400-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-500-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-ext-400-normal.woff2",
  "assets/fonts/ibm-plex-mono-latin-ext-500-normal.woff2",
  "assets/fonts/ibm-plex-mono-vietnamese-400-normal.woff2",
  "assets/fonts/ibm-plex-mono-vietnamese-500-normal.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await (await caches.open(SHELL_CACHE)).addAll(SHELL);
    const assets = await caches.open(ASSET_CACHE);
    await Promise.all(ASSETS.map(async (url) => {
      if (!(await assets.match(url))) await assets.add(url);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === "navigate") return cache.match("index.html");
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (/\/(vendor|assets\/textures|assets\/fonts|data)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
  } else {
    event.respondWith(networkFirst(request));
  }
});
