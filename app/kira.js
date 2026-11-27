/* ---------- Kira, the receipt friend (1.71.0) ----------
   A cartoon receipt with a face. The approved drawing and motion are in
   docs/plans/kira-moods.html (the spec); split/index.html ships the same
   receipt. Kira turns up at small moments — an empty list, the first-run
   welcome, a spend just logged, a check-in, the phone's AI at work — and
   never sits on top of a balance, a debt, a tax figure or a form.

   kiraSvg(mood, opts) returns inline SVG markup (aria-hidden, decorative):
     happy     float + blink                    empty states, welcome (wave)
     proud     ^^ eyes, open smile, sparkle     a spend logged, a streak going
     sleepy    line eyes, floating z's          a no-spend check-in
     worried   raised brows, wavy mouth, drop   kind words when it's tight
     party     hat, arms up, confetti, dance    a big milestone
     counting  holds the sempoa, beads flick    ON-DEVICE AI ONLY
     listening eyes up, "o" mouth, sound arcs     the Voice sheet's mic is open
               pulse; nods per word (.is-hearing)  (1.80.0, voice.js) — not AI
   The sempoa means "your phone's AI is working" and nothing else, so
   "counting" draws only when the caller says so with { ai: true } — every
   other caller gets happy Kira. Its beads are the header badge's beads (same
   classes, same 2.2s count), so the two move together.

   opts: { idle } loops float/blink (empty states only), { moment } plays the
   mood once and rests, { wave } adds a waving arm (happy), { cls } extra
   classes. Every animation lives in styles.css ("Kira") behind
   prefers-reduced-motion: no-preference. Colours are tokens only. */

const KIRA_MOODS = ["happy", "proud", "sleepy", "worried", "party", "counting", "listening"];

const KIRA_BODY =
  '<path class="kira-body" d="M12 5h40a5 5 0 0 1 5 5v55l-5.6-3.6-5.6 3.6-5.6-3.6-5.6 3.6-5.6-3.6-5.6 3.6-5.6-3.6L7 65V10a5 5 0 0 1 5-5z"/>' +
  '<path class="kira-line" d="M17 16h22M17 23h14"/>' +
  '<circle class="kira-cheek" cx="19" cy="45" r="3"/><circle class="kira-cheek" cx="45" cy="45" r="3"/>';
const KIRA_EYES = '<g class="kira-eyes"><circle cx="24" cy="38" r="2.8"/><circle cx="40" cy="38" r="2.8"/></g>';
// The ^^ eyes sit in their own .kira-eyes group too, so they follow a tap
// and blink like the round ones. (Eyes follow taps by a transform on
// .kira-eyes; blinking scales the .kira-blink group around it, so the two
// compose instead of fighting.)
const KIRA_HAPPY_EYES = '<g class="kira-blink"><g class="kira-eyes"><path class="kira-stroke" d="M20.5 39q3.5-4 7 0M36.5 39q3.5-4 7 0"/></g></g>';

// The header badge's sempoa (20×20, two rods, a heaven bead and two earth
// beads on each), held in both hands. Same bead classes as the badge so the
// existing ai-sp-* keyframes count them in step.
const KIRA_SEMPOA =
  '<g class="sempoa kira-sempoa" transform="translate(13 41.8) scale(1.9)">' +
    '<rect class="kira-sp-back" x="2.2" y="2.2" width="15.6" height="15.6" rx="3.2"/>' +
    '<rect x="2.2" y="2.2" width="15.6" height="15.6" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.05" opacity="0.8"/>' +
    '<path d="M7 3v14M13 3v14" fill="none" stroke="currentColor" stroke-width="0.6" opacity="0.45"/>' +
    '<path d="M2.9 8h14.2" fill="none" stroke="currentColor" stroke-width="1"/>' +
    '<rect class="ai-bead sp-hl" x="4.7" y="3.4" width="4.6" height="2.3" rx="1.15" fill="currentColor"/>' +
    '<rect class="ai-bead sp-hr" x="10.7" y="3.4" width="4.6" height="2.3" rx="1.15" fill="currentColor"/>' +
    '<rect class="ai-bead sp-el1" x="4.7" y="11.95" width="4.6" height="2.3" rx="1.15" fill="currentColor"/>' +
    '<rect class="ai-bead sp-el2" x="4.7" y="14.4" width="4.6" height="2.3" rx="1.15" fill="currentColor"/>' +
    '<rect class="ai-bead sp-er1" x="10.7" y="11.95" width="4.6" height="2.3" rx="1.15" fill="currentColor"/>' +
    '<rect class="ai-bead sp-er2" x="10.7" y="14.4" width="4.6" height="2.3" rx="1.15" fill="currentColor"/>' +
  '</g>';

const KIRA_DRAW = {
  happy: (o) => ({
    vb: "0 -8 64 90",
    body: `<g class="kira-float">${KIRA_BODY}<g class="kira-blink">${KIRA_EYES}</g><path class="kira-stroke" d="M27 45q5 5 10 0"/>` +
      (o.wave ? '<path class="kira-arm kira-wave" d="M57 30q6-6 4-12"/>' : "") + "</g>",
  }),
  proud: () => ({
    vb: "0 -8 64 90",
    body: `<g class="kira-float">${KIRA_BODY}${KIRA_HAPPY_EYES}<path class="kira-stroke kira-mouth" d="M26 44q6 7 12 0z"/><path class="kira-arm" d="M57 30l6-8"/></g>` +
      '<path class="kira-spark kira-twinkle" d="M58 6l2 5 5 1-5 2-2 5-2-5-5-2 5-1z"/>',
  }),
  sleepy: () => ({
    vb: "0 -8 64 90",
    body: `<g>${KIRA_BODY}<path class="kira-stroke" d="M20.5 38h7M36.5 38h7"/><path class="kira-stroke" d="M29 46h6"/></g>` +
      '<text class="kira-z kira-zz" x="52" y="10">z</text><text class="kira-z kira-z2 kira-zz2" x="58" y="2">z</text>',
  }),
  worried: () => ({
    vb: "0 -8 64 90",
    body: `<g class="kira-shake">${KIRA_BODY}<path class="kira-stroke" d="M20 33.5l7-3M44 33.5l-7-3"/><g class="kira-blink">${KIRA_EYES}</g><path class="kira-stroke" d="M26 47q3-3 6 0t6 0"/></g>` +
      '<path class="kira-drop" d="M50 22q3 4 0 6q-3-2 0-6z"/>',
  }),
  party: (o) => ({
    vb: "0 -14 64 96",
    // A festive hat (kira-seasons.js) takes the party hat's place.
    body: `<g class="kira-dance">${KIRA_BODY}` + (o.noHat ? "" : '<path class="kira-hat" d="M24 6l8-18 8 18z"/><circle class="kira-pom" cx="32" cy="-12" r="2.6"/>') +
      `${KIRA_HAPPY_EYES}<path class="kira-mouth" d="M26 44q6 9 12 0z"/><path class="kira-arm" d="M7 32l-6-9M57 32l6-9"/></g>` +
      '<g class="kira-confetti"><rect class="kc-a" x="2" y="0" width="4" height="6"/><circle class="kc-b" cx="60" cy="4" r="2.4"/>' +
      '<rect class="kc-c" x="54" y="-6" width="4" height="6"/><circle class="kc-c" cx="8" cy="-8" r="2.4"/></g>',
  }),
  // Talk to Kira (1.80.0): ears open. Eyes up, a small "o", sound arcs on
  // both sides pulsing outwards while the mic is open; the head nods once
  // per new word (voice.js adds .is-hearing). Nothing in the hands: the
  // sempoa is the on-device AI's alone.
  listening: () => ({
    vb: "-6 -8 76 90",
    body: `<g class="kira-listen-head">${KIRA_BODY}<g class="kira-blink"><g class="kira-eyes kira-eyes-up"><circle cx="24" cy="35.6" r="2.8"/><circle cx="40" cy="35.6" r="2.8"/></g></g>` +
      '<ellipse class="kira-mouth" cx="32" cy="46.5" rx="2.4" ry="2.9"/></g>' +
      '<g class="kira-ears"><path class="kira-ear ke-1" d="M60.5 31q3.5 5 0 10"/><path class="kira-ear ke-2" d="M64.5 27q6 9 0 18"/>' +
      '<path class="kira-ear ke-1" d="M3.5 31q-3.5 5 0 10"/><path class="kira-ear ke-2" d="M-0.5 27q-6 9 0 18"/></g>',
  }),
  counting: () => ({
    vb: "0 -8 64 90",
    body: `<g class="kira-nod">${KIRA_BODY}<path class="kira-stroke" d="M21 37.5a3 3 0 0 1 6 0M37 37.5a3 3 0 0 1 6 0"/><path class="kira-stroke" d="M29 44.5h6"/></g>` +
      KIRA_SEMPOA + '<path class="kira-arm" d="M7 40q4 10 11 13M57 40q-4 10-11 13"/>',
  }),
};

function kiraSvg(mood, opts) {
  const o = opts || {};
  let m = KIRA_DRAW[mood] ? mood : "happy";
  // The sempoa is the on-device AI's sign. Anywhere else, Kira just smiles.
  if (m === "counting" && o.ai !== true) m = "happy";
  // Festive Kira (1.76.0): the season's outfit, unless the caller says
  // { season: false } (or passes a season of its own). Ramadan and the quiet
  // Islamic days are calm: no party mood, so no confetti.
  const season = o.season === undefined ? kiraSeasonNow() : (o.season || null);
  if (season && season.calm && m === "party") m = "proud";
  let fest = null;
  if (season && typeof KiraSeasons !== "undefined") {
    // Counting Kira keeps the sempoa: a hat at most, nothing in the hands.
    fest = m === "counting" ? { under: "", inner: KiraSeasons.headOnly(season), front: "", head: true }
      : KiraSeasons.props(season);
  }
  const d = KIRA_DRAW[m]({ ...o, noHat: !!(fest && fest.head && fest.inner) });
  let body = d.body;
  if (fest && (fest.inner || fest.under || fest.front)) {
    body = (fest.under || "") + body.replace(KIRA_BODY, KIRA_BODY + (fest.inner || "")) + (fest.front || "");
  }
  const cls = ["kira", `kira--${m}`];
  if (o.idle) cls.push("is-idle");
  if (o.moment) cls.push("is-moment");
  if (o.wave && m === "happy") cls.push("is-waving");
  if (fest && (fest.inner || fest.under || fest.front)) cls.push("kira--festive", `kira-look-${season.look}`);
  if (o.cls) cls.push(o.cls);
  // What it was asked for, so kiraRefreshAll can redraw it in place.
  const asked = [o.idle && "i", o.moment && "m", o.wave && "w", o.ai === true && "a"].filter(Boolean).join("");
  const seasonAttr = fest ? ` data-season="${season.key}"` : "";
  const keep = o.season === false ? ' data-kira-plain="1"' : "";
  return `<svg class="${cls.join(" ")}" viewBox="${d.vb}" aria-hidden="true" focusable="false" data-kira="${mood}" data-kira-o="${asked}"${seasonAttr}${keep}>${body}</svg>`;
}

/* ---------- Festive Kira (1.76.0) ----------
   kira-seasons.js says which season today is (docs/plans/kira-festive.md);
   every Kira drawn through kiraSvg wears its outfit. "Festive Kira" in
   Settings → Appearance turns it off on this device (localStorage, like the
   theme; default on): off means plain Kira and no greetings. */
const KIRA_FESTIVE_KEY = "duitful.festiveKira";
const KIRA_GREET_KEY = "duitful.kiraGreet";
function kiraFestiveOn() {
  try { return localStorage.getItem(KIRA_FESTIVE_KEY) !== "off"; } catch (_) { return true; }
}
// The e2e suite pins the date with window.DUITFUL_KIRA_DATE ("YYYY-MM-DD").
function kiraTodayIso() {
  const pinned = typeof window !== "undefined" ? window.DUITFUL_KIRA_DATE : "";
  if (typeof pinned === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
let kiraSeasonMemo = null;
function kiraSeasonNow() {
  if (typeof KiraSeasons === "undefined" || !kiraFestiveOn()) return null;
  const iso = kiraTodayIso();
  if (!kiraSeasonMemo || kiraSeasonMemo.iso !== iso) {
    let s = null;
    try { s = KiraSeasons.seasonFor(iso); } catch (_) { s = null; }
    kiraSeasonMemo = { iso, s };
  }
  return kiraSeasonMemo.s;
}
// Redraw every Kira on the page (the switch changed, or the day did).
function kiraRefreshAll() {
  kiraSeasonMemo = null;
  for (const svg of document.querySelectorAll("svg.kira[data-kira]")) {
    if (svg.dataset.kiraPlain) continue;
    const f = svg.dataset.kiraO || "";
    const html = kiraSvg(svg.dataset.kira, { idle: f.includes("i"), moment: f.includes("m"), wave: f.includes("w"), ai: f.includes("a") });
    svg.insertAdjacentHTML("afterend", html);
    svg.remove();
  }
  renderKiraGreet();
}

// The greeting rows (scripts/i18n/locales/*/kira.json). Some stay the same in
// every language because that is how Malaysians say them.
const KIRA_GREETINGS = {
  newyear: () => tr("Happy New Year"),
  thaipusam: () => tr("Happy Thaipusam"),
  cny: () => tr("Happy Chinese New Year"),
  ramadan: () => tr("Salam Ramadan"),
  raya: () => tr("Selamat Hari Raya Aidilfitri, Maaf Zahir Batin"),
  labour: () => tr("Happy Labour Day"),
  wesak: () => tr("Happy Wesak Day"),
  kaamatan: () => tr("Kotobian Tadau Tagazo do Kaamatan"),
  gawai: () => tr("Selamat Hari Gawai, Gayu Guru Gerai Nyamai"),
  agong: () => tr("Daulat Tuanku"),
  haji: () => tr("Selamat Hari Raya Aidiladha"),
  muharram: () => tr("Salam Maal Hijrah"),
  merdeka: () => tr("Happy Merdeka"),
  malaysia_day: () => tr("Happy Malaysia Day"),
  maulid: () => tr("Salam Maulidur Rasul"),
  deepavali: () => tr("Happy Deepavali"),
  christmas: () => tr("Merry Christmas"),
};
// Names for the "Happy holidays" line on a shared national + state day.
const KIRA_HOLIDAY_NAMES = {
  newyear: () => tr("New Year's Day"),
  thaipusam: () => tr("Thaipusam"),
  cny: () => tr("Chinese New Year"),
  nuzul: () => tr("Nuzul Al-Quran"),
  raya: () => tr("Hari Raya Aidilfitri"),
  labour: () => tr("Labour Day"),
  wesak: () => tr("Wesak Day"),
  kaamatan: () => tr("Kaamatan"),
  gawai: () => tr("Gawai"),
  agong: () => tr("Agong's Birthday"),
  haji: () => tr("Hari Raya Aidiladha"),
  muharram: () => tr("Awal Muharram"),
  merdeka: () => tr("Merdeka Day"),
  malaysia_day: () => tr("Malaysia Day"),
  maulid: () => tr("Maulidur Rasul"),
  deepavali: () => tr("Deepavali"),
  christmas: () => tr("Christmas"),
};
function kiraGreetText(season) {
  if (!season) return "";
  if (season.id === "shared") {
    const names = season.names.map((n) => (KIRA_HOLIDAY_NAMES[n] ? KIRA_HOLIDAY_NAMES[n]() : "")).filter(Boolean);
    return tr("Happy holidays: {names}", { names: names.join(" · ") });
  }
  return season.names.map((n) => (KIRA_GREETINGS[n] ? KIRA_GREETINGS[n]() : "")).filter(Boolean).join(" · ");
}

/* One greeting line on Home, once per season per device: shown the first
   day it comes up (and kept that day until dismissed), then never again for
   that season. Its own card above the others, never on the figures. */
function kiraGreetStore() {
  try { const v = JSON.parse(localStorage.getItem(KIRA_GREET_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (_) { return {}; }
}
function kiraGreetSave(v) {
  // Keep the last few seasons only.
  const keys = Object.keys(v);
  if (keys.length > 12) for (const k of keys.slice(0, keys.length - 12)) delete v[k];
  try { localStorage.setItem(KIRA_GREET_KEY, JSON.stringify(v)); } catch (_) { /* private mode: shown again next time */ }
}
function renderKiraGreet() {
  const card = document.getElementById("kira-greet");
  if (!card) return;
  const unlocked = typeof state !== "undefined" && !!state;
  const season = unlocked ? kiraSeasonNow() : null;
  const today = kiraTodayIso();
  let show = false;
  if (season) {
    const store = kiraGreetStore();
    const seen = store[season.key];
    show = !seen || seen === today;
    if (show && !seen) { store[season.key] = today; kiraGreetSave(store); }
  }
  card.hidden = !show;
  card.dataset.season = show ? season.key : "";
  if (!show) return;
  const text = document.getElementById("kira-greet-text");
  if (text) text.textContent = kiraGreetText(season);
  const slot = document.getElementById("kira-greet-kira");
  if (slot) {
    // One Kira on Home: beside the hero's kind note, the greeting keeps its words only.
    const heroNote = document.getElementById("hero-kira-note");
    const quiet = !!heroNote && !heroNote.hidden;
    const want = quiet ? "" : season.key;
    if (slot.dataset.season !== want) {
      slot.dataset.season = want;
      slot.innerHTML = want ? kiraSvg("happy", { moment: true, season }) : "";
    }
  }
}
function kiraGreetDismiss() {
  const card = document.getElementById("kira-greet");
  const key = card && card.dataset.season;
  if (key) { const store = kiraGreetStore(); store[key] = "x"; kiraGreetSave(store); }
  if (card) card.hidden = true;
  kiraSyncToday();
}
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target.closest("#kira-greet-close") : null;
  if (t) kiraGreetDismiss();
});

// Settings → Appearance → Festive Kira.
function renderFestiveSetting() {
  const box = document.getElementById("pref-festive-kira");
  if (box) box.checked = kiraFestiveOn();
}
document.addEventListener("change", (e) => {
  if (!(e.target instanceof Element) || e.target.id !== "pref-festive-kira") return;
  try { localStorage.setItem(KIRA_FESTIVE_KEY, e.target.checked ? "on" : "off"); } catch (_) { /* stays as it was */ }
  kiraRefreshAll();
  kiraSyncToday();
});

const kiraReducedMotion = () => {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
};

/* The logging hop: a small proud Kira hops on the confirmation toast while a
   coin drops in beside it. Once, ~650ms, then gone. Nothing at all under
   reduced motion (the toast already says it). kiraHop("party") is the
   toast-level celebration (a savings goal reached): party Kira pops up a
   little longer with a confetti burst instead of the coin. */
let kiraHopEl = null;
let kiraHopTimer = null;
function kiraHop(mood) {
  if (kiraReducedMotion()) return;
  const toastEl = document.getElementById("toast");
  if (!toastEl || !toastEl.classList.contains("show")) return;
  if (kiraHopEl) kiraHopEl.remove();
  clearTimeout(kiraHopTimer);
  const party = mood === "party";
  const el = document.createElement("div");
  el.className = party ? "kira-hop kira-hop--party" : "kira-hop";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = party ? kiraSvg("party", { moment: true }) : kiraSvg("proud") +
    '<svg class="kira-coin" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8.6"/><circle class="kira-coin-ring" cx="10" cy="10" r="5.4"/></svg>';
  // Same layer as the toast (a dialog's top layer when one is open).
  (toastEl.parentElement || document.body).appendChild(el);
  // The toast slides up from +16px; place Kira on where it lands, not where
  // it is this frame: its CSS bottom is the resting edge.
  const r = toastEl.getBoundingClientRect();
  const cs = getComputedStyle(toastEl);
  const bottom = parseFloat(cs.bottom);
  const restTop = Number.isFinite(bottom) ? innerHeight - bottom - r.height : r.top - 16;
  el.style.left = `${Math.round(r.left + 10)}px`;
  el.style.top = `${Math.round(restTop - (party ? 46 : 34))}px`;
  kiraHopEl = el;
  if (party) kiraBurst(el);
  kiraHopTimer = setTimeout(() => { el.remove(); if (kiraHopEl === el) kiraHopEl = null; }, party ? 1500 : 900);
}

/* A short confetti burst from Kira (the same idea as split/index.html's
   celebrate()): ~22 token-coloured pieces fly out from the middle of `host`
   for 1.1s, then the layer is removed. Nothing under reduced motion. */
function kiraBurstColours() {
  const cs = getComputedStyle(document.documentElement);
  return ["--brand", "--accent-3", "--accent", "--primary", "--accent-4"]
    .map((t) => cs.getPropertyValue(t).trim()).filter(Boolean);
}
function kiraBurst(host, count) {
  if (!host || kiraReducedMotion()) return;
  // No confetti in Ramadan or on a quiet Islamic day (Festive Kira).
  const season = kiraSeasonNow();
  if (season && season.calm) return;
  host.querySelectorAll(":scope > .kira-burst").forEach((n) => n.remove());
  const colours = kiraBurstColours();
  if (!colours.length) return;
  const layer = document.createElement("span");
  layer.className = "kira-burst";
  layer.setAttribute("aria-hidden", "true");
  const n = count || 22;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("i");
    const ang = -Math.PI * (0.1 + 0.8 * Math.random());
    const dist = 34 + Math.random() * 62;
    p.style.background = colours[i % colours.length];
    if (i % 4 === 0) p.className = "is-dot";
    p.style.setProperty("--dx", `${Math.round(Math.cos(ang) * dist)}px`);
    p.style.setProperty("--dy", `${Math.round(Math.sin(ang) * dist + 28)}px`);
    p.style.setProperty("--rot", `${Math.round(Math.random() * 720 - 360)}deg`);
    p.style.animationDelay = `${Math.round(Math.random() * 120)}ms`;
    layer.appendChild(p);
  }
  host.appendChild(layer);
  setTimeout(() => layer.remove(), 1400);
}

/* Celebration surfaces (the debt paid-off sheet, a milestone sheet, the
   first-run answer, the tour's last step): party Kira in `slot`, plus the
   burst. Called once per event by the code that opens the moment. Under
   reduced motion Kira still shows, standing still, without confetti. */
function kiraCelebrate(slot) {
  if (!slot || typeof kiraSvg !== "function") return;
  slot.dataset.mood = "party";
  slot.innerHTML = kiraSvg("party", { moment: true });
  kiraBurst(slot);
}

/* Kind words when it's tight: worried Kira beside one short line (Home's
   hero when the month is over, Budget Pools when a pool is). The line is
   its own element under the figures, never on top of them. */
function kiraSyncNote(note, show) {
  if (!note) return;
  note.hidden = !show;
  const slot = note.querySelector(".kira-note-mark");
  if (!slot) return;
  if (!show) { slot.innerHTML = ""; return; }
  if (!slot.firstChild) slot.innerHTML = kiraSvg("worried", { moment: true });
}

/* ---------- Eyes follow taps, and a tap on Kira (1.75.0) ----------
   One passive document listener. On a pointerdown it notes where, then —
   one frame later — shifts the pupils of every Kira on screen up to
   KIRA_LOOK_MAX SVG units toward that point; after KIRA_LOOK_IDLE_MS
   without a tap they ease back to centre. No tap, no work: nothing runs per
   frame, and a tap with no Kira on screen stops at one query. A tap on
   Kira's own paper squishes, blinks and sparkles once (~500ms). Kira stays
   decorative: aria-hidden, never focusable, and only the receipt's own shape
   takes the pointer (styles.css), so the buttons around it keep their taps.
   The AI sheet's counting Kira, the hop and the tour's peeking Kira are left
   alone. All of it is off under reduced motion. */
const KIRA_LOOK_MAX = 1.6;
const KIRA_LOOK_IDLE_MS = 1200;
const KIRA_TAP_MS = 520;
let kiraLookPt = null;
let kiraLookRaf = 0;
let kiraLookTimer = 0;

const kiraLeftAlone = (svg) => svg.classList.contains("kira--counting")
  || svg.classList.contains("kira--listening")
  || !!svg.closest(".ai-think-mark, .kira-hop, .guide-tooltip-kira");

function kiraOnScreen() {
  const out = [];
  for (const svg of document.querySelectorAll("svg.kira")) {
    if (kiraLeftAlone(svg)) continue;
    const r = svg.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) out.push(svg);
  }
  return out;
}

// Point one Kira's eyes at (x, y), in viewport pixels. `hold` keeps the
// gaze (the tour's tooltip Kira looks at the highlighted element).
function kiraLookAt(svg, x, y, hold) {
  const eyes = svg && svg.querySelector(".kira-eyes");
  if (!eyes) return;
  const box = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (!box.width || !vb || !vb.width) return;
  // The eyes sit at (32, 38) in Kira's drawing.
  const ex = box.left + ((32 - vb.x) / vb.width) * box.width;
  const ey = box.top + ((38 - vb.y) / vb.height) * box.height;
  const dx = x - ex;
  const dy = y - ey;
  const d = Math.hypot(dx, dy);
  const k = d < 1 ? 0 : KIRA_LOOK_MAX * Math.min(1, d / 48);
  const tx = d < 1 ? 0 : (dx / d) * k;
  const ty = d < 1 ? 0 : (dy / d) * k;
  eyes.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`;
  if (hold) eyes.dataset.hold = "1";
}

function kiraLookFrame() {
  kiraLookRaf = 0;
  const pt = kiraLookPt;
  if (!pt) return;
  const list = kiraOnScreen();
  if (!list.length) return;
  for (const svg of list) kiraLookAt(svg, pt.x, pt.y);
  clearTimeout(kiraLookTimer);
  kiraLookTimer = setTimeout(kiraLookRest, KIRA_LOOK_IDLE_MS);
}

function kiraLookRest() {
  for (const eyes of document.querySelectorAll("svg.kira .kira-eyes[style]")) {
    if (eyes.dataset.hold) continue;
    eyes.style.transform = "";
  }
}

function kiraTap(svg) {
  if (!svg || svg.classList.contains("is-tapped") || kiraLeftAlone(svg)) return;
  svg.classList.add("is-tapped");
  svg.insertAdjacentHTML("beforeend",
    '<g class="kira-hehe"><path class="kira-spark" d="M56 2l1.6 4 4 .8-4 1.6-1.6 4-1.6-4-4-1.6 4-.8z"/>' +
    '<path class="kira-spark" d="M6 10l1 2.6 2.6.5-2.6 1-1 2.6-1-2.6-2.6-1 2.6-.5z"/></g>');
  setTimeout(() => {
    svg.classList.remove("is-tapped");
    svg.querySelectorAll(".kira-hehe").forEach((n) => n.remove());
  }, KIRA_TAP_MS);
}

document.addEventListener("pointerdown", (e) => {
  if (kiraReducedMotion()) return;
  kiraLookPt = { x: e.clientX, y: e.clientY };
  const hit = e.target instanceof Element ? e.target.closest("svg.kira") : null;
  if (hit) kiraTap(hit);
  if (!kiraLookRaf) kiraLookRaf = requestAnimationFrame(kiraLookFrame);
}, { passive: true, capture: true });

/* Home → Today: happy Kira beside "Nothing logged today.", sleepy Kira
   beside a no-spend check-in, nobody once something is logged. Redrawn only
   when the mood changes, so the moment plays once rather than on every
   renderAll. Called by renderTodayCard (script.js) and renderStreak. */
function kiraSyncToday() {
  const row = document.getElementById("today-kira-row");
  const slot = document.getElementById("today-kira");
  if (!row || !slot) return;
  const empty = document.getElementById("today-empty");
  const done = document.getElementById("today-nospend-done");
  const sleepy = !!done && !done.hidden;
  const show = sleepy || (!!empty && !empty.hidden);
  row.hidden = !show;
  // One Kira on Home: while the hero's "a bit over" note has worried Kira,
  // the Today line keeps its words and leaves Kira out.
  const heroNote = document.getElementById("hero-kira-note");
  const greet = document.getElementById("kira-greet");
  // 2.0: the bubble counts too. While it shows Kira, Home's Today line keeps
  // its words and leaves Kira to the bubble.
  const bubble = document.body.classList.contains("bubble-kira");
  const quiet = bubble || (!!heroNote && !heroNote.hidden) || (!!greet && !greet.hidden);
  const mood = !show || quiet ? "" : sleepy ? "sleepy" : "happy";
  if (slot.dataset.mood === mood) return;
  slot.dataset.mood = mood;
  slot.innerHTML = mood ? kiraSvg(mood, { moment: true }) : "";
}

/* Purchase celebration: Kira dances around happily, bows with gratitude,
   bursts confetti, and says "Thank you! Terima kasih!". Used on successful
   Duitful AI+ purchases (and paired with Lifetime Pro's welcome sheet). */
function kiraWithBowMarkup(extraCls) {
  const base = kiraSvg("party", { cls: `kira-dance-bow${extraCls ? ` ${extraCls}` : ""}` });
  // Cute ribbon bow perched at the top-right corner of Kira's paper.
  const bow =
    '<g class="kira-ribbon-bow" transform="translate(46 4) rotate(16)">' +
      '<path d="M0 0c-5-4-9-2-9 2s4 5 9 1z" fill="var(--brand, #e07a5f)"/>' +
      '<path d="M0 0c5-4 9-2 9 2s-4 5-9 1z" fill="var(--brand, #e07a5f)"/>' +
      '<circle cx="0" cy="1.2" r="2.2" fill="var(--accent, #d46246)"/>' +
    '</g>';
  return base.replace("</svg>", `${bow}</svg>`);
}

function showKiraPurchaseThanks(opts) {
  if (typeof document === "undefined") return;
  const o = opts || {};
  const t = typeof tr === "function" ? tr : (s) => s;
  const esc = typeof escapeHtml === "function"
    ? escapeHtml
    : (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  const heading = o.title || t("Duitful AI+ is active.");
  const sub = o.subtitle || t("Duitful AI+ is ready to help.");
  const bubble = t("Thank you! Terima kasih!");
  const cta = t("Let's go");

  let dlg = document.getElementById("kira-thanks-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "kira-thanks-dialog";
    dlg.className = "edit-dialog kira-thanks-dialog";
    dlg.addEventListener("click", (e) => { if (e.target === dlg && dlg.open) dlg.close(); });
    document.body.appendChild(dlg);
  }
  dlg.innerHTML =
    '<div class="kira-thanks-body">' +
      `<div class="kira-thanks-bubble">${esc(bubble)}</div>` +
      `<div class="kira-thanks-stage" aria-hidden="true">${kiraWithBowMarkup()}</div>` +
      `<h2 class="kira-thanks-title">${esc(heading)}</h2>` +
      `<p class="kira-thanks-sub">${esc(sub)}</p>` +
      `<button type="button" class="primary kira-thanks-btn">${esc(cta)}</button>` +
    '</div>';
  const btn = dlg.querySelector(".kira-thanks-btn");
  if (btn) btn.addEventListener("click", () => { if (dlg.open) dlg.close(); });
  if (typeof dlg.showModal === "function") {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute("open", "");
  }
  const stage = dlg.querySelector(".kira-thanks-stage");
  kiraBurst(stage, 28);
  setTimeout(() => { if (dlg.open) kiraBurst(stage, 20); }, 1550);
}

function showKiraPurchaseLoading(statusText) {
  if (typeof document === "undefined") return;
  const t = typeof tr === "function" ? tr : (s) => s;
  const esc = typeof escapeHtml === "function"
    ? escapeHtml
    : (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

  let dlg = document.getElementById("kira-wait-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "kira-wait-dialog";
    dlg.className = "edit-dialog kira-wait-dialog";
    // Prevent accidental Escape dismiss while a store purchase is in flight.
    dlg.addEventListener("cancel", (e) => e.preventDefault());
    document.body.appendChild(dlg);
  }
  const quips = [
    t("Checking with the store…"),
    t("Almost there…"),
    t("Hehe! Still checking…"),
    t("Hang tight…"),
  ];
  let taps = 0;
  dlg.innerHTML =
    '<div class="kira-wait-body">' +
      `<div class="kira-thanks-bubble kira-wait-bubble">${esc(quips[0])}</div>` +
      `<button type="button" class="kira-wait-stage" aria-label="${esc(t("Tap Kira"))}">` +
        '<span class="kira-wait-ring" aria-hidden="true"></span>' +
        kiraSvg("happy", { idle: true, wave: true, cls: "kira-wait-svg" }) +
      '</button>' +
      `<p class="kira-wait-status" id="kira-wait-status">${esc(statusText || t("Completing purchase…"))}</p>` +
      `<p class="hint kira-wait-hint">${esc(t("Tap Kira while you wait"))}</p>` +
    '</div>';

  const stage = dlg.querySelector(".kira-wait-stage");
  const bubble = dlg.querySelector(".kira-wait-bubble");
  if (stage) {
    stage.addEventListener("click", () => {
      taps += 1;
      const svg = stage.querySelector("svg.kira");
      if (svg) kiraTap(svg);
      kiraBurst(stage, 10);
      if (bubble) bubble.textContent = quips[taps % quips.length];
    });
  }
  if (typeof dlg.showModal === "function") {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute("open", "");
  }
}

function updateKiraPurchaseLoading(statusText) {
  if (typeof document === "undefined" || !statusText) return;
  const el = document.getElementById("kira-wait-status");
  if (el) el.textContent = statusText;
}

function hideKiraPurchaseLoading() {
  if (typeof document === "undefined") return;
  const dlg = document.getElementById("kira-wait-dialog");
  if (dlg && dlg.open && typeof dlg.close === "function") dlg.close();
}

if (typeof window !== "undefined") {
  window.kiraWithBowMarkup = kiraWithBowMarkup;
  window.showKiraPurchaseThanks = showKiraPurchaseThanks;
  window.showKiraPurchaseLoading = showKiraPurchaseLoading;
  window.updateKiraPurchaseLoading = updateKiraPurchaseLoading;
  window.hideKiraPurchaseLoading = hideKiraPurchaseLoading;
}

