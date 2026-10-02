// Check-in: pick a seat on a top-down cabin map (seat class = strictness) and a purpose tag.
import { settings, tags, saveTags, updateSettings, TAG_COLORS } from "../settings.js";
import { haptic } from "../haptics.js";
import { sfx } from "../audio.js";
import { Spring } from "../spring.js";
import { esc, hash, rng, toast } from "./common.js";

const ICON = {
  pause: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/></svg>`,
  nopause: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor" opacity=".45"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor" opacity=".45"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  stay: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="1.5" width="8" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2 1.3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`,
  awake: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></g></svg>`,
  full: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  sound: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.6a6 6 0 010 8.8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>`,
};

export const CLASSES = {
  first: {
    name: "First",
    line: "The strictest cabin. Everything set up for deep focus.",
    rules: [["nopause", "No pause"], ["stay", "Leave >10 s = divert"], ["awake", "Screen stays awake"], ["full", "Fullscreen"], ["sound", "Ambience on"]],
  },
  business: {
    name: "Business",
    line: "Committed, but human. You keep the miles you fly even if you divert.",
    rules: [["nopause", "No pause"], ["stay", "Leave >10 s = divert"]],
  },
  economy: {
    name: "Economy",
    line: "The relaxed cabin. Step away whenever you need to.",
    rules: [["pause", "Pause allowed"]],
  },
};

const CABIN = [
  { cls: "first", rows: [1, 2], layout: ["A", null, "F"] },
  { cls: "business", rows: [3, 4, 5], layout: ["A", "C", null, "D", "F"] },
  { cls: "economy", rows: [10, 11, 12, 14, 15, 16, 17, 18], layout: ["A", "B", "C", null, "D", "E", "F"], wingAfter: 12 },
];

export class CheckIn {
  constructor({ root, onPrint, onBack }) {
    this.root = root;
    this.onPrint = onPrint;
    this.$ = (s) => root.querySelector(s);
    this.seat = null;
    this.springs = new Map();
    this.$("#checkin-back").addEventListener("click", onBack);
    this.$("#print-btn").addEventListener("click", () => this.print());
    this.$("#cabin").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-seat]");
      if (b && !b.disabled) this.pickSeat(b);
    });
    this.$("#tag-rail").addEventListener("click", (e) => {
      if (e.target.closest("[data-add]")) { this.openEditor(true); return; }
      const b = e.target.closest("[data-tag]");
      if (b) this.pickTag(b.dataset.tag);
    });
    this.$("#tags-edit").addEventListener("click", () => this.openEditor());
    this.setupEditor();
  }

  open(trip) {
    this.trip = trip;
    this.seat = null;
    this.tagId = tags.some((t) => t.id === settings.lastTagId) ? settings.lastTagId : null;
    this.$("#checkin-route").textContent = `${trip.origin.iata} → ${trip.dest.iata}`;
    this.renderCabin();
    this.renderTags();
    this.renderInfo();
    this.root.scrollTop = 0;
  }

  /* ---------- cabin ---------- */

  renderCabin() {
    const r = rng(hash(`${this.trip.origin.iata}${this.trip.dest.iata}${new Date().toDateString()}`));
    const zones = CABIN.map((zone) => {
      const rows = zone.rows.map((row) => {
        const seats = zone.layout.map((letter) => {
          if (!letter) return `<span class="aisle" aria-hidden="true">${zone.cls === "economy" ? row : ""}</span>`;
          const taken = zone.cls === "first" ? false : r() < (zone.cls === "business" ? 0.3 : 0.3);
          const id = `${row}${letter}`;
          if (taken) return `<span class="seat seat-${zone.cls} is-taken" role="img" aria-label="Seat ${id} taken"><span class="pax"></span></span>`;
          return `<button class="seat seat-${zone.cls}" data-seat="${id}" data-cls="${zone.cls}" aria-label="Seat ${id}, ${CLASSES[zone.cls].name}"><span class="seat-id">${id}</span></button>`;
        }).join("");
        const wing = zone.wingAfter === row ? `<div class="wing-row" aria-hidden="true"><span class="exit l">EXIT</span><span class="exit r">EXIT</span></div>` : "";
        return `<div class="seat-row">${seats}</div>${wing}`;
      }).join("");
      return `<section class="cabin-zone zone-${zone.cls}" aria-label="${CLASSES[zone.cls].name} class">
        <div class="zone-head"><span>${CLASSES[zone.cls].name}</span><i></i></div>${rows}</section>`;
    });
    this.$("#cabin").innerHTML =
      `<div class="galley" aria-hidden="true"><span>Galley</span></div>` +
      zones.join(`<div class="bulkhead" aria-hidden="true"><span class="exit l">EXIT</span><span class="lav">Lav</span><span class="exit r">EXIT</span></div>`) +
      `<div class="galley" aria-hidden="true"><span>Galley</span></div>`;
  }

  pickSeat(btn) {
    this.root.querySelectorAll(".seat.is-mine").forEach((b) => b.classList.remove("is-mine"));
    btn.classList.add("is-mine");
    btn.classList.remove("buckle"); void btn.offsetWidth; btn.classList.add("buckle");
    this.seat = { id: btn.dataset.seat, cls: btn.dataset.cls };
    sfx.seatbelt();
    haptic("seatbelt");
    this.renderInfo();
  }

  renderInfo() {
    const info = this.$("#class-info");
    if (!this.seat) {
      info.innerHTML = `<p class="class-hint">Tap a free seat. The cabin you sit in decides how strict this flight will be.</p>`;
    } else {
      const c = CLASSES[this.seat.cls];
      info.innerHTML = `<div class="class-badge cls-${this.seat.cls}"><b>${this.seat.id}</b><span>${c.name}</span></div>
        <div class="class-rules"><p>${c.line}</p><ul>${c.rules.map(([icon, text]) => `<li>${ICON[icon]}<span>${text}</span></li>`).join("")}</ul></div>`;
    }
    const ready = this.seat && this.tagId;
    const btn = this.$("#print-btn");
    btn.disabled = !ready;
    btn.textContent = !this.seat ? "Choose a seat" : !this.tagId ? "Choose a purpose" : "Print boarding pass";
  }

  /* ---------- purpose tags ---------- */

  renderTags() {
    const rail = this.$("#tag-rail");
    rail.innerHTML = tags.map((t) => `
      <button class="luggage-tag${t.id === this.tagId ? " is-on" : ""}" data-tag="${esc(t.id)}" style="--tag:${esc(t.color)}" aria-pressed="${t.id === this.tagId}">
        <span class="tag-string" aria-hidden="true"></span>
        <span class="tag-body"><span class="tag-hole" aria-hidden="true"></span><span class="tag-name">${esc(t.name)}</span></span>
      </button>`).join("") + `
      <button class="luggage-tag tag-add" data-add aria-label="Add a purpose tag">
        <span class="tag-string" aria-hidden="true"></span>
        <span class="tag-body"><span class="tag-hole" aria-hidden="true"></span><span class="tag-name">+ New</span></span>
      </button>`;
    this.springs.clear();
    rail.querySelectorAll(".luggage-tag[data-tag]").forEach((el) => {
      const body = el;
      const s = new Spring({ stiffness: 120, damping: 7, onUpdate: (v) => { body.style.setProperty("--swing", `${v}deg`); } });
      this.springs.set(el.dataset.tag, s);
    });
  }

  pickTag(id) {
    const changed = id !== this.tagId;
    this.tagId = id;
    this.root.querySelectorAll(".luggage-tag").forEach((el) => {
      const on = el.dataset.tag === id;
      el.classList.toggle("is-on", on);
      el.setAttribute("aria-pressed", on);
    });
    const ids = tags.map((t) => t.id);
    const at = ids.indexOf(id);
    // the picked tag swings hard; neighbours sway a little on the shared rail
    ids.forEach((tid, i) => {
      const d = Math.abs(i - at);
      const s = this.springs.get(tid);
      if (!s) return;
      if (d === 0) s.impulse(changed ? 260 : 150);
      else if (d <= 2) s.impulse((i < at ? -1 : 1) * (70 / d));
    });
    sfx.snap();
    haptic("tagSnap");
    this.renderInfo();
  }

  /* ---------- tag editor ---------- */

  setupEditor() {
    const dlg = document.getElementById("tags-dialog");
    this.dlg = dlg;
    dlg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) { if (e.target === dlg) this.closeEditor(); return; }
      const i = +b.dataset.i;
      const list = this.draft;
      switch (b.dataset.act) {
        case "up": if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]]; break;
        case "down": if (i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]]; break;
        case "del":
          if (list.length <= 1) { toast("Keep at least one tag."); return; }
          list.splice(i, 1); break;
        case "color": list[i].color = b.dataset.color; break;
        case "add": list.push({ id: `t${Date.now().toString(36)}`, name: "New tag", color: TAG_COLORS[list.length % TAG_COLORS.length] }); break;
        case "done": this.saveEditor(); return;
        case "cancel": this.closeEditor(); return;
        default: return;
      }
      sfx.tap();
      this.renderEditor(b.dataset.act === "add" ? list.length - 1 : null);
    });
    dlg.addEventListener("input", (e) => {
      if (e.target.matches("input[data-i]")) this.draft[+e.target.dataset.i].name = e.target.value.slice(0, 18);
    });
  }

  openEditor(addNew = false) {
    this.draft = tags.map((t) => ({ ...t }));
    if (addNew) this.draft.push({ id: `t${Date.now().toString(36)}`, name: "New tag", color: TAG_COLORS[this.draft.length % TAG_COLORS.length] });
    this.dlg.showModal();
    this.renderEditor(addNew ? this.draft.length - 1 : null);
  }

  renderEditor(focusIndex = null) {
    const list = this.draft;
    this.dlg.querySelector(".tag-edit-list").innerHTML = list.map((t, i) => `
      <li class="tag-edit" style="--tag:${esc(t.color)}">
        <div class="tag-edit-row">
          <span class="tag-dot" aria-hidden="true"></span>
          <input type="text" value="${esc(t.name)}" data-i="${i}" maxlength="18" aria-label="Tag name">
          <button class="icon-btn" data-act="up" data-i="${i}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="icon-btn" data-act="down" data-i="${i}" aria-label="Move down" ${i === list.length - 1 ? "disabled" : ""}>↓</button>
          <button class="icon-btn danger" data-act="del" data-i="${i}" aria-label="Delete tag">×</button>
        </div>
        <div class="swatches">${TAG_COLORS.map((c) => `<button class="swatch${c === t.color ? " is-on" : ""}" style="--c:${c}" data-act="color" data-i="${i}" data-color="${c}" aria-label="Colour ${c}"></button>`).join("")}</div>
      </li>`).join("");
    if (focusIndex != null) {
      const input = this.dlg.querySelector(`input[data-i="${focusIndex}"]`);
      input?.focus(); input?.select();
    }
  }

  async saveEditor() {
    const cleaned = this.draft.map((t) => ({ ...t, name: t.name.trim() || "Untitled" }));
    await saveTags(cleaned);
    if (!cleaned.some((t) => t.id === this.tagId)) this.tagId = null;
    this.closeEditor();
    this.renderTags();
    this.renderInfo();
  }

  closeEditor() { this.dlg.close(); }

  /* ---------- go ---------- */

  async print() {
    if (!this.seat || !this.tagId) return;
    const tag = tags.find((t) => t.id === this.tagId);
    await updateSettings({ lastTagId: this.tagId, lastDuration: this.trip.durationMin });
    this.onPrint({ ...this.trip, seat: this.seat.id, cls: this.seat.cls, tag: { ...tag } });
  }
}
