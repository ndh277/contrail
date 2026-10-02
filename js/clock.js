// App clock. Normally just Date.now(); `?warp=N` in the URL runs time N× faster
// (handy for testing a whole flight in seconds — never used in normal use).
const warp = Math.max(1, Number(new URLSearchParams(location.search).get("warp")) || 1);
let t0 = Date.now();
if (warp > 1) {
  // keep warped time continuous across reloads in the same tab
  try { t0 = Number(sessionStorage.getItem("contrail-warp-t0")) || t0; sessionStorage.setItem("contrail-warp-t0", String(t0)); } catch { /* ignore */ }
}
export const now = () => (warp === 1 ? Date.now() : t0 + (Date.now() - t0) * warp);
export const WARP = warp;
