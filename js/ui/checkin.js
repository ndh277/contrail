// Check-in: pick a seat on a top-down cabin map (seat class = strictness) and a purpose tag.
import { settings, tags, saveTags, updateSettings, TAG_COLORS } from "../settings.js";
import { haptic } from "../haptics.js";
import { sfx } from "../audio.js";
import { Spring } from "../spring.js";
import { esc, hash, rng, toast } from "./common.js";

export const CLASSES = {
  first: {
    name: "First",
    rules: "No pause. Screen stays awake, goes fullscreen, and the ambience starts by itself. Leave the app for over 10 s and the flight diverts.",
  },
  business: {
    name: "Business",
    rules: "No pause. Leave the app for more than 10 seconds and the flight diverts — you still keep the miles flown.",
  },
  economy: {
    name: "Economy",
    rules: "Pause whenever you need to. The most relaxed seat on the plane.",
  },
};

const CABIN = [
  { cls: "first", rows: [1, 2], layout: ["A", null, "F"] },
  { cls: "business", rows: [3, 4, 5], layout: ["A", "C", null, "D", "F"] },
  { cls: "economy", rows: [10, 11, 12, 14, 15, 16, 17, 18], layout: ["A", "B", "C", null, "D", "E", "F"] },
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
    const html = CABIN.map((zone) => {
      const rows = zone.rows.map((row) => {
        const seats = zone.layout.map((letter) => {
          if (!letter) return `<span class="aisle" aria-hidden="true">${zone.cls === "economy" ? row : ""}</span>`;
          const taken = zone.cls === "first" ? false : r() < (zone.cls === "business" ? 0.3 : 0.28);
          const id = `${row}${letter}`;
          return `<button class="seat seat-${zone.cls}" data-seat="${id}" data-cls="${zone.cls}" ${taken ? "disabled aria-label=\"Seat " + id + " taken\"" : `aria-label="Seat ${id}, ${CLASSES[zone.cls].name}"`}>
            <span class="seat-back"></span><span class="seat-id">${id}</span></button>`;
        }).join("");
        return `<div class="seat-row">${seats}</div>`;
      }).join("");
      return `<section class="cabin-zone zone-${zone.cls}" aria-label="${CLASSES[zone.cls].name} class">
        <div class="zone-head"><span>${CLASSES[zone.cls].name}</span><i></i></div>${rows}</section>`;
    }).join(`<div class="galley" aria-hidden="true"></div>`);
    this.$("#cabin").innerHTML = html;
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
      info.innerHTML = `<p class="class-hint">Tap a free seat. Your cabin decides how strict the flight is.</p>`;
    } else {
      const c = CLASSES[this.seat.cls];
      info.innerHTML = `<div class="class-badge cls-${this.seat.cls}"><b>${this.seat.id}</b><span>${c.name}</span></div><p>${c.rules}</p>`;
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
      </button>`).join("");
    this.springs.clear();
    rail.querySelectorAll(".luggage-tag").forEach((el) => {
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

  openEditor() {
    this.draft = tags.map((t) => ({ ...t }));
    this.renderEditor();
    this.dlg.showModal();
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
