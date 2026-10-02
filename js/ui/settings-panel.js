// Settings sheet: home airport, route scale, theme, quality, sound, haptics.
import { settings, updateSettings } from "../settings.js";
import { searchAirports, getAirport } from "../airports.js";
import { setVolume, sfx } from "../audio.js";
import { haptic } from "../haptics.js";
import { esc, toast } from "./common.js";

export class SettingsPanel {
  constructor({ dialog, onHome, onScale, onTheme }) {
    this.dlg = dialog;
    Object.assign(this, { onHome, onScale, onTheme });
    const $ = (s) => dialog.querySelector(s);
    this.$ = $;

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog || e.target.closest("[data-close]")) { dialog.close(); return; }
      const seg = e.target.closest("button[data-setting]");
      if (seg) { this.choose(seg.dataset.setting, seg.dataset.value); return; }
      const ap = e.target.closest("button[data-iata]");
      if (ap) this.setHome(ap.dataset.iata);
    });
    $("#home-search").addEventListener("input", (e) => this.search(e.target.value));
    $("#set-sound").addEventListener("change", (e) => { updateSettings({ sound: e.target.checked }); if (e.target.checked) sfx.tap(); });
    $("#set-haptics").addEventListener("change", (e) => { updateSettings({ haptics: e.target.checked }); if (e.target.checked) haptic("seatbelt"); });
    $("#set-volume").addEventListener("input", (e) => { const v = +e.target.value; setVolume(v); updateSettings({ volume: v }); });
    $("#set-volume").addEventListener("change", () => sfx.blip());
  }

  open(focusHome = false) {
    this.render();
    this.dlg.showModal();
    if (focusHome) this.$("#home-search").focus();
  }

  render() {
    const home = getAirport(settings.home);
    this.$("#home-current").innerHTML = `<b>${esc(home.iata)}</b> ${esc(home.city)} · ${esc(home.name)}`;
    this.$("#home-search").value = "";
    this.$("#home-results").innerHTML = "";
    this.dlg.querySelectorAll("button[data-setting]").forEach((b) => {
      const on = String(settings[b.dataset.setting]) === b.dataset.value;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on);
    });
    this.$("#set-sound").checked = settings.sound;
    this.$("#set-haptics").checked = settings.haptics;
    this.$("#set-volume").value = settings.volume;
  }

  search(q) {
    const list = searchAirports(q, 12);
    this.$("#home-results").innerHTML = list.map((a) => `
      <li><button data-iata="${a.iata}"><b>${a.iata}</b><span>${esc(a.city)} · ${esc(a.countryName)}</span><small>${esc(a.name)}</small></button></li>`).join("");
  }

  async setHome(iata) {
    await updateSettings({ home: iata });
    this.render();
    sfx.tap();
    this.onHome(getAirport(iata));
    toast(`Home airport set to ${iata}.`);
  }

  async choose(key, raw) {
    const value = key === "routeScale" ? Number(raw) : raw;
    if (settings[key] === value) return;
    await updateSettings({ [key]: value });
    this.render();
    sfx.tap();
    if (key === "routeScale") this.onScale();
    if (key === "theme") this.onTheme();
    if (key === "quality") toast("Quality applies the next time Contrail opens.");
  }
}
