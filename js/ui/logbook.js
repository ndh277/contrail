// Logbook: a passport with turnable pages — identity + stats + heatmap,
// stamp pages, and the flight log with every archived pass. Backup lives here too.
import { allFlights, stats, minutesByDay, exportJSON, importFlights } from "../flights.js";
import { settings, updateSettings, tags, saveTags } from "../settings.js";
import { KM_PER_MILE, formatDuration } from "../geo.js";
import { stampSVG } from "../stamps.js";
import { sfx } from "../audio.js";
import { haptic } from "../haptics.js";
import { reducedMotion } from "../spring.js";
import { esc, toast } from "./common.js";

const STAMPS_PER_PAGE = 6;
const LOG_PER_PAGE = 7;
const STATUS = { landed: "Landed", diverted: "Diverted", aborted: "Cancelled" };

export class Logbook {
  constructor({ root, onBack, onChange }) {
    this.root = root;
    this.onChange = onChange;
    this.$ = (s) => root.querySelector(s);
    this.page = 0;
    this.tagFilter = null;
    this.$("#logbook-back").addEventListener("click", onBack);
    this.$("#export-btn").addEventListener("click", () => this.export());
    this.$("#import-btn").addEventListener("click", () => this.$("#import-file").click());
    this.$("#import-file").addEventListener("change", (e) => this.import(e.target.files[0]));
    this.$("#page-prev").addEventListener("click", () => this.turn(-1));
    this.$("#page-next").addEventListener("click", () => this.turn(1));
    this.book = this.$("#passport");
    this.book.addEventListener("click", (e) => this.click(e));
    this.setupDrag();
  }

  async open() {
    this.flights = await allFlights();
    this.render();
  }

  /* ================= rendering ================= */

  render() {
    const list = this.flights;
    const landed = list.filter((f) => f.status === "landed");
    const pages = [this.identityPage(list)];
    const stampPages = Math.max(1, Math.ceil(landed.length / STAMPS_PER_PAGE));
    for (let i = 0; i < stampPages; i++) pages.push(this.stampPage(landed.slice(i * STAMPS_PER_PAGE, (i + 1) * STAMPS_PER_PAGE), i, stampPages));
    const logPages = Math.max(1, Math.ceil(list.length / LOG_PER_PAGE));
    for (let i = 0; i < logPages; i++) pages.push(this.logPage(list.slice(i * LOG_PER_PAGE, (i + 1) * LOG_PER_PAGE), i, logPages));
    this.count = pages.length;
    this.page = Math.min(this.page, this.count - 1);
    this.book.innerHTML = pages.map((html, i) => `<section class="ppage" data-i="${i}">${html}<span class="pnum">${i + 1}</span></section>`).join("");
    this.layout();
  }

  layout(drag = null) {
    this.book.querySelectorAll(".ppage").forEach((el, i) => {
      let rot = i < this.page ? -180 : 0;
      if (drag && i === drag.index) rot = drag.angle;
      el.style.transform = `rotateY(${rot}deg)`;
      el.style.zIndex = i < this.page ? i : this.count - i;
      el.classList.toggle("is-turned", rot <= -90);
      el.classList.toggle("is-current", i === this.page);
    });
    this.$("#page-prev").disabled = this.page === 0;
    this.$("#page-next").disabled = this.page >= this.count - 1;
    this.$("#page-label").textContent = this.labelFor(this.page);
  }

  labelFor(i) {
    const el = this.book.querySelector(`.ppage[data-i="${i}"] .ptitle`);
    return el ? el.textContent : "";
  }

  identityPage(list) {
    const s = stats(list);
    const km = settings.units === "km";
    const dist = km ? s.km : s.km / KM_PER_MILE;
    return `
      <header class="phead"><span class="ptitle">Holder</span><span class="pcode">P&lt;VNM</span></header>
      <div class="holder">
        <div class="portrait" aria-hidden="true">
          <svg viewBox="0 0 80 96"><rect width="80" height="96" rx="6" fill="currentColor" opacity=".08"/><circle cx="40" cy="36" r="15" fill="currentColor" opacity=".28"/><path d="M14 88c2-18 13-27 26-27s24 9 26 27" fill="currentColor" opacity=".28"/><path d="M8 70 C 28 52, 50 44, 74 30" stroke="var(--amber-500)" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".7"/></svg>
        </div>
        <dl class="holder-data">
          <div><dt>Surname / Nom</dt><dd>NGUYEN</dd></div>
          <div><dt>Given names</dt><dd>HENRY</dd></div>
          <div><dt>Home port</dt><dd>${esc(settings.home)}</dd></div>
          <div><dt>Member since</dt><dd>${list.length ? new Date(list[list.length - 1].startedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" }).toUpperCase() : "—"}</dd></div>
        </dl>
      </div>
      <dl class="pstats">
        <div><dt>Focus hours</dt><dd>${(s.minutes / 60).toFixed(s.minutes < 600 ? 1 : 0)}</dd></div>
        <div><dt><button class="unit-toggle" data-act="units" aria-label="Switch miles and kilometres">${km ? "Kilometres" : "Miles"} ↔</button></dt><dd>${Math.round(dist).toLocaleString("en-US")}</dd></div>
        <div><dt>Flights</dt><dd>${s.flights}</dd></div>
        <div><dt>Cities</dt><dd>${s.cities}</dd></div>
        <div><dt>Streak</dt><dd>${s.streak}<small> day${s.streak === 1 ? "" : "s"}</small></dd></div>
      </dl>
      <div class="heat">
        <div class="heat-head"><span>Focus minutes · last 12 months</span><span class="heat-pick" id="heat-pick"></span></div>
        <div class="heat-tags">
          <button class="chip" data-act="tag" data-tag="" aria-pressed="${!this.tagFilter}">All</button>
          ${tags.map((t) => `<button class="chip" data-act="tag" data-tag="${esc(t.id)}" style="--tag:${esc(t.color)}" aria-pressed="${this.tagFilter === t.id}"><i></i>${esc(t.name)}</button>`).join("")}
        </div>
        ${this.heatmap(list)}
      </div>`;
  }

  heatmap(list) {
    const byDay = minutesByDay(list, this.tagFilter);
    const color = this.tagFilter ? tags.find((t) => t.id === this.tagFilter)?.color || "#d98f35" : "#d98f35";
    const end = new Date(); end.setHours(12, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - 7 * 52 - end.getDay());
    const cell = 6, gap = 1.6, step = cell + gap;
    let cells = "", months = "", lastMonth = -1, lastLabelCol = -9, col = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const row = d.getDay();
      if (row === 0 && d > start) col++;
      const m = byDay.get(d);
      const lvl = m <= 0 ? 0 : m < 25 ? 1 : m < 60 ? 2 : m < 120 ? 3 : 4;
      const label = `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${Math.round(m)} min`;
      cells += `<rect x="${col * step}" y="${12 + row * step}" width="${cell}" height="${cell}" rx="1.4" class="l${lvl}" data-label="${label}"/>`;
      if (d.getMonth() !== lastMonth && row === 0 && col - lastLabelCol >= 3) {
        lastMonth = d.getMonth();
        lastLabelCol = col;
        months += `<text x="${col * step}" y="8">${d.toLocaleDateString("en-GB", { month: "short" })}</text>`;
      }
    }
    const w = (col + 1) * step;
    return `<svg class="heatmap" viewBox="0 0 ${w} ${12 + 7 * step}" style="--heat:${color}" role="img" aria-label="Focus minutes per day, last 12 months">${months}${cells}</svg>
      <div class="heat-legend"><span>Less</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>More</span></div>`;
  }

  stampPage(items, i, n) {
    const slots = items.map((f) => `<div class="stamp-cell">${stampSVG(f, { size: 150, idPrefix: `p${i}` })}</div>`).join("");
    const empty = items.length ? "" : `<div class="stamp-empty"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="5 6"/></svg><p>Your first stamp lands here.<br>Finish a flight to earn it.</p></div>`;
    return `<header class="phead"><span class="ptitle">Visas &amp; stamps${n > 1 ? ` · ${i + 1}/${n}` : ""}</span><span class="pcode">ENTRY</span></header>
      <div class="stamp-grid">${slots}${empty}</div>`;
  }

  logPage(items, i, n) {
    const rows = items.map((f) => {
      const d = new Date(f.startedAt);
      return `<li class="log-row status-${f.status}" style="--tag:${esc(f.tagColor)}">
        <button data-act="log" data-id="${esc(f.id)}" aria-expanded="false">
          <span class="log-date">${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }).toUpperCase()}</span>
          <span class="log-route">${esc(f.origin)}<i>→</i>${esc(f.status === "diverted" && f.divertedTo ? f.divertedTo.iata : f.dest)}</span>
          <span class="log-time">${formatDuration(f.flownMin)}</span>
          <span class="log-status">${STATUS[f.status] || f.status}</span>
        </button>
        <div class="log-detail" hidden>
          <span><b>${esc(f.flightNo)}</b> · Gate ${esc(f.gate || "—")} · Seat ${esc(f.seat)} · ${esc(f.cls)}</span>
          <span><i class="dot"></i>${esc(f.tagName)} · ${f.flownKm.toLocaleString("en-US")} / ${f.distKm.toLocaleString("en-US")} km · ${f.scale}×</span>
          <span>${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} → ${new Date(f.endedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}${f.status === "diverted" && f.divertedTo ? ` · planned ${esc(f.dest)}` : ""}</span>
        </div>
      </li>`;
    }).join("");
    return `<header class="phead"><span class="ptitle">Flight log${n > 1 ? ` · ${i + 1}/${n}` : ""}</span><span class="pcode">LOG</span></header>
      ${items.length ? `<ul class="log">${rows}</ul>` : `<p class="log-empty">No flights yet. Your boarding passes are archived here.</p>`}`;
  }

  /* ================= interaction ================= */

  click(e) {
    const b = e.target.closest("[data-act]");
    if (b) {
      if (b.dataset.act === "units") {
        updateSettings({ units: settings.units === "km" ? "mi" : "km" }).then(() => this.render());
        sfx.tap();
      } else if (b.dataset.act === "tag") {
        this.tagFilter = b.dataset.tag || null;
        sfx.tap();
        this.render();
      } else if (b.dataset.act === "log") {
        const det = b.nextElementSibling;
        det.hidden = !det.hidden;
        b.setAttribute("aria-expanded", !det.hidden);
        sfx.tap();
      }
      return;
    }
    const cell = e.target.closest(".heatmap rect");
    if (cell) this.$("#heat-pick").textContent = cell.dataset.label;
  }

  turn(dir) {
    const next = this.page + dir;
    if (next < 0 || next >= this.count) return;
    this.page = next;
    this.layout();
    sfx.strain();
    haptic("tap");
  }

  setupDrag() {
    let start = null;
    this.book.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, rect")) return;
      start = { x: e.clientX, y: e.clientY, w: this.book.clientWidth, dragging: false };
    });
    this.book.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      if (!start.dragging) {
        if (Math.abs(dx) < 10 || Math.abs(e.clientY - start.y) > Math.abs(dx)) return;
        start.dragging = true;
        this.book.setPointerCapture(e.pointerId);
        this.book.classList.add("is-dragging");
      }
      const k = Math.max(-1, Math.min(1, dx / start.w));
      if (k < 0 && this.page < this.count - 1) { start.index = this.page; start.angle = k * 180; }
      else if (k > 0 && this.page > 0) { start.index = this.page - 1; start.angle = -180 + k * 180; }
      else return;
      this.layout({ index: start.index, angle: start.angle });
    });
    const end = () => {
      if (!start) return;
      const s = start; start = null;
      this.book.classList.remove("is-dragging");
      if (!s.dragging || s.index == null) { this.layout(); return; }
      const forward = s.index === this.page;
      const done = forward ? s.angle < -60 : s.angle > -120;
      if (done) this.turn(forward ? 1 : -1); else this.layout();
    };
    this.book.addEventListener("pointerup", end);
    this.book.addEventListener("pointercancel", end);
    if (reducedMotion()) this.book.classList.add("no-motion");
  }

  /* ================= backup ================= */

  async export() {
    const json = await exportJSON({ settings: { ...settings }, tags });
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `contrail-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`Backup saved · ${this.flights.length} flight${this.flights.length === 1 ? "" : "s"}.`);
  }

  async import(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const n = await importFlights(data);
      if (Array.isArray(data.tags)) {
        const have = new Set(tags.map((t) => t.id));
        const extra = data.tags.filter((t) => t && t.id && !have.has(t.id));
        if (extra.length) await saveTags([...tags, ...extra]);
      }
      this.flights = await allFlights();
      this.render();
      this.onChange?.();
      toast(n ? `Imported ${n} flight${n === 1 ? "" : "s"}.` : "Everything in that backup is already here.");
    } catch (err) {
      toast(err.message || "That file couldn't be read.");
    } finally {
      this.$("#import-file").value = "";
    }
  }
}
