// Desktop companion: on a laptop the flight should stay out of the way.
// - a floating mini window (Document Picture-in-Picture) that stays on top of other
//   apps: countdown, the plane creeping along its route, ETA
// - the countdown in the tab title and on the installed app's badge
const MINI_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; overflow: hidden; cursor: default;
    background: radial-gradient(130% 120% at 15% 0%, #1d2a47, #0a0f1c 68%); color: #eef1f8;
    font-family: "Be Vietnam Pro", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  body::before { content: ""; position: fixed; inset: 0; pointer-events: none;
    background: radial-gradient(60% 50% at 85% 10%, rgba(244,177,90,.12), transparent 70%); }
  .card { width: calc(100% - 28px); position: relative; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .route { font-family: "Big Shoulders Display", sans-serif; font-weight: 800; letter-spacing: .08em; font-size: 16px; }
  .route i { font-style: normal; color: #f4b15a; margin: 0 6px; }
  .phase { font-family: "IBM Plex Mono", monospace; font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: #ffcd85; display: flex; align-items: center; gap: 5px; }
  .phase::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #f4b15a; box-shadow: 0 0 8px #f4b15a; animation: blink 2.4s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: .35; } }
  .clock { font-family: "IBM Plex Mono", monospace; font-weight: 500; font-size: 40px; line-height: 1.05; font-variant-numeric: tabular-nums; margin: 4px 0 10px; letter-spacing: -.01em; }
  .bar { position: relative; height: 4px; border-radius: 2px; background: rgba(255,255,255,.12); margin: 0 6px; }
  .fill { position: absolute; inset: 0; border-radius: 2px; transform-origin: left; background: linear-gradient(90deg, rgba(244,177,90,.3), #f4b15a); box-shadow: 0 0 10px rgba(244,177,90,.5); }
  .craft { position: absolute; top: 50%; width: 16px; height: 16px; transform: translate(-50%, -50%) rotate(90deg); color: #fff; filter: drop-shadow(0 0 4px rgba(244,177,90,.9)); }
  .meta { margin-top: 10px; font-family: "IBM Plex Mono", monospace; font-size: 10px; color: rgba(235,240,250,.6); }
  .tag { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: rgba(235,240,250,.85); }
  .tag::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--tag, #f4b15a); }
  .back { position: absolute; top: -4px; right: -4px; width: 28px; height: 28px; border: 0; border-radius: 50%;
    background: rgba(255,255,255,.08); color: #eef1f8; display: grid; place-items: center; cursor: pointer; opacity: 0; transition: opacity .25s, background .2s; }
  body:hover .back { opacity: 1; }
  .back:hover { background: rgba(255,255,255,.18); }
  .back svg { width: 14px; height: 14px; }
  body:hover .phase { visibility: hidden; }
`;

export class Companion {
  get pipSupported() { return "documentPictureInPicture" in window; }
  get isDesktop() { return matchMedia("(hover: hover) and (pointer: fine)").matches && innerWidth >= 1024; }

  async openMini() {
    if (!this.pipSupported || this.win) return false;
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 320, height: 176 });
      const doc = win.document;
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("css/fonts.css", location.href).href;
      doc.head.append(link);
      const style = doc.createElement("style");
      style.textContent = MINI_CSS;
      doc.head.append(style);
      doc.title = "Contrail";
      doc.body.innerHTML = `
        <div class="card">
          <div class="row"><span class="route" data-k="route"></span><span class="phase" data-k="phase"></span></div>
          <button class="back" data-k="back" title="Back to Contrail" aria-label="Back to Contrail"><svg viewBox="0 0 16 16"><path d="M6 3H3v10h10v-3M9 2.5h4.5V7M13.5 2.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <div class="clock" data-k="clock">--:--</div>
          <div class="bar"><div class="fill" data-k="fill"></div>
            <svg class="craft" data-k="craft" viewBox="0 0 24 24"><path d="M12 2l1.4 6.2 8.1 4.3v1.6l-8.1-2.1-.6 5.3 2.6 2v1.4L12 19.6l-3.4 1.1v-1.4l2.6-2-.6-5.3-8.1 2.1v-1.6l8.1-4.3z" fill="currentColor"/></svg>
          </div>
          <div class="row meta"><span class="tag" data-k="tag"></span><span data-k="meta"></span></div>
        </div>`;
      this.win = win;
      this.el = Object.fromEntries([...doc.querySelectorAll("[data-k]")].map((n) => [n.dataset.k, n]));
      win.addEventListener("pagehide", () => { this.win = null; this.el = null; });
      // the mini window floats over other apps; this brings the Contrail tab forward again
      this.el.back.addEventListener("click", () => { window.focus(); });
      if (this.last) this.update(this.last);
      return true;
    } catch {
      return false;
    }
  }

  closeMini() { this.win?.close(); this.win = null; this.el = null; }

  /** info: { clock, progress, from, to, eta, phase, flightNo, minutesLeft, tag, tagColor, kmLeft } */
  update(info) {
    this.last = info;
    document.title = `${info.clock} · ${info.from}→${info.to} · Contrail`;
    if ("setAppBadge" in navigator) navigator.setAppBadge(Math.max(1, info.minutesLeft)).catch(() => {});
    const e = this.el;
    if (!e) return;
    e.route.innerHTML = `${info.from}<i>→</i>${info.to}`;
    e.phase.textContent = info.phase;
    e.clock.textContent = info.clock;
    e.fill.style.transform = `scaleX(${info.progress})`;
    e.craft.style.left = `${info.progress * 100}%`;
    e.meta.textContent = `${info.kmLeft != null ? `${info.kmLeft.toLocaleString("en-US")} km · ` : ""}ETA ${info.eta}`;
    e.tag.textContent = info.tag || info.flightNo;
    if (info.tagColor) e.tag.style.setProperty("--tag", info.tagColor);
  }

  reset() {
    this.last = null;
    document.title = "Contrail";
    if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
    this.closeMini();
  }
}
