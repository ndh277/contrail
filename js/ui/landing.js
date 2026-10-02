// Landing ceremony: chime, a warm light sweep, confetti, and the passport stamp
// that hovers and then slams down. Diversions get a calm card instead.
import { sfx } from "../audio.js";
import { haptic } from "../haptics.js";
import { reducedMotion } from "../spring.js";
import { stampSVG } from "../stamps.js";
import { esc, sleep } from "./common.js";
import { formatDuration } from "../geo.js";

const minutes = (m) => (m < 1 ? "under a minute" : formatDuration(m));

export class Landing {
  constructor({ root, onDone }) {
    this.root = root;
    this.onDone = onDone;
    this.$ = (s) => root.querySelector(s);
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-next]");
      if (b) this.close(b.dataset.next);
    });
    this.canvas = this.$("#confetti");
  }

  async show(rec, { home }) {
    this.rec = rec;
    const landed = rec.status === "landed";
    this.root.classList.toggle("is-diverted", !landed);
    this.$("#landing-eyebrow").textContent = landed ? "Welcome to" : rec.status === "diverted" ? "Diverted to" : "Back at the gate in";
    this.$("#landing-city").textContent = landed ? rec.destCity : rec.status === "diverted" ? `${rec.divertedTo?.city || "a nearby airport"}` : rec.originCity;
    const tag = `<span class="landing-tag" style="--tag:${esc(rec.tagColor)}">${esc(rec.tagName)}</span>`;
    this.$("#landing-sub").innerHTML = landed
      ? `${minutes(rec.flownMin)} of ${tag} · ${rec.flownKm.toLocaleString("en-US")} km flown`
      : rec.status === "diverted"
        ? `You stepped away for a while, so ${esc(rec.flightNo)} set down early. The ${rec.flownKm.toLocaleString("en-US")} km and ${minutes(rec.flownMin)} of ${tag} you flew are still yours.`
        : `Flight cancelled. ${minutes(rec.flownMin)} of ${tag} still counts toward today.`;
    this.$("#landing-unlock").hidden = !rec.firstVisit;
    this.$("#stamp-slot").innerHTML = landed ? stampSVG(rec, { size: 220, idPrefix: "land" }) : "";
    this.$("#stamp-slot").hidden = !landed;
    const next = this.$("#landing-next");
    next.innerHTML = landed
      ? `<button class="btn primary" data-next="continue">Fly on from ${esc(rec.dest)}</button><button class="btn ghost" data-next="home">Back to ${esc(home)}</button>`
      : `<button class="btn primary" data-next="home">Back to the gate</button>`;

    this.root.classList.add("is-open");
    if (!landed) return;

    sfx.chime();
    this.root.classList.remove("sweep"); void this.root.offsetWidth; this.root.classList.add("sweep");
    if (!reducedMotion()) this.confetti(rec.tagColor);
    await this.slam();
  }

  async slam() {
    const stamp = this.$("#stamp-slot .stamp");
    const page = this.$(".landing-page");
    if (!stamp) return;
    if (reducedMotion()) { stamp.style.opacity = 1; haptic("stampSlam"); sfx.thud(); return; }
    stamp.style.opacity = 0;
    await sleep(500);
    // hover: lifted, big, soft shadow, a slow bob
    const hover = stamp.animate([
      { opacity: 0, transform: "translateY(-70px) scale(1.5)", filter: "drop-shadow(0 40px 18px rgba(0,0,0,.35)) blur(1.5px)" },
      { opacity: 0.95, transform: "translateY(-46px) scale(1.42)", filter: "drop-shadow(0 34px 16px rgba(0,0,0,.3)) blur(0.6px)" },
      { opacity: 0.95, transform: "translateY(-54px) scale(1.44)", filter: "drop-shadow(0 38px 17px rgba(0,0,0,.3)) blur(0.6px)" },
    ], { duration: 950, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
    await hover.finished;
    // slam
    const down = stamp.animate([
      { opacity: 0.95, transform: "translateY(-54px) scale(1.44)", filter: "drop-shadow(0 38px 17px rgba(0,0,0,.3)) blur(0.6px)" },
      { opacity: 1, transform: "translateY(0) scale(0.97)", filter: "drop-shadow(0 0 0 rgba(0,0,0,0)) blur(0)" },
    ], { duration: 120, easing: "cubic-bezier(.55,0,1,.45)", fill: "forwards" });
    await down.finished;
    sfx.thud();
    haptic("stampSlam");
    page.animate([
      { transform: "translateY(0)" }, { transform: "translateY(5px) rotate(-0.4deg)" }, { transform: "translateY(-2px)" }, { transform: "translateY(0)" },
    ], { duration: 260, easing: "ease-out" });
    stamp.animate([{ transform: "scale(0.97)" }, { transform: "scale(1.02)" }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out", fill: "forwards" });
    stamp.style.opacity = 1;
    if (this.rec.firstVisit) this.$("#landing-unlock").classList.add("is-on");
  }

  confetti(tagColor) {
    const c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    const colors = [tagColor, "#f4b15a", "#fbf6ea", "#ffcd85", "#6fa8ff", "#e86fa0"];
    const parts = Array.from({ length: 150 }, (_, i) => ({
      x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.42,
      vx: (Math.random() - 0.5) * 900, vy: -350 - Math.random() * 700,
      w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
      flip: Math.random() * 6.28, vf: 4 + Math.random() * 8,
      color: colors[i % colors.length],
    }));
    let last = performance.now();
    const t0 = last;
    const step = (t) => {
      const dt = Math.min(0.033, (t - last) / 1000); last = t;
      g.clearRect(0, 0, W, H);
      const age = (t - t0) / 1000;
      for (const p of parts) {
        p.vy += 980 * dt; p.vx *= Math.exp(-1.6 * dt); p.vy *= Math.exp(-1.1 * dt);
        p.x += (p.vx + Math.sin(p.flip) * 40) * dt; p.y += p.vy * dt;
        p.rot += p.vr * dt; p.flip += p.vf * dt;
        g.save();
        g.globalAlpha = Math.max(0, Math.min(1, 4.2 - age));
        g.translate(p.x, p.y); g.rotate(p.rot); g.scale(1, Math.cos(p.flip));
        g.fillStyle = p.color;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        g.restore();
      }
      if (age < 4.3) requestAnimationFrame(step); else g.clearRect(0, 0, W, H);
    };
    requestAnimationFrame(step);
  }

  close(next) {
    this.root.classList.remove("is-open", "sweep");
    this.$("#landing-unlock").classList.remove("is-on");
    this.onDone(next, this.rec);
  }
}
