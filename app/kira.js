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
   The sempoa means "your phone's AI is working" and nothing else, so
   "counting" draws only when the caller says so with { ai: true } — every
   other caller gets happy Kira. Its beads are the header badge's beads (same
   classes, same 2.2s count), so the two move together.

   opts: { idle } loops float/blink (empty states only), { moment } plays the
   mood once and rests, { wave } adds a waving arm (happy), { cls } extra
   classes. Every animation lives in styles.css ("Kira") behind
   prefers-reduced-motion: no-preference. Colours are tokens only. */

const KIRA_MOODS = ["happy", "proud", "sleepy", "worried", "party", "counting"];

const KIRA_BODY =
  '<path class="kira-body" d="M12 5h40a5 5 0 0 1 5 5v55l-5.6-3.6-5.6 3.6-5.6-3.6-5.6 3.6-5.6-3.6-5.6 3.6-5.6-3.6L7 65V10a5 5 0 0 1 5-5z"/>' +
  '<path class="kira-line" d="M17 16h22M17 23h14"/>' +
  '<circle class="kira-cheek" cx="19" cy="45" r="3"/><circle class="kira-cheek" cx="45" cy="45" r="3"/>';
const KIRA_EYES = '<g class="kira-eyes"><circle cx="24" cy="38" r="2.8"/><circle cx="40" cy="38" r="2.8"/></g>';
const KIRA_HAPPY_EYES = '<path class="kira-stroke" d="M20.5 39q3.5-4 7 0M36.5 39q3.5-4 7 0"/>';

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
    body: `<g class="kira-shake">${KIRA_BODY}<path class="kira-stroke" d="M20 33.5l7-3M44 33.5l-7-3"/>${KIRA_EYES}<path class="kira-stroke" d="M26 47q3-3 6 0t6 0"/></g>` +
      '<path class="kira-drop" d="M50 22q3 4 0 6q-3-2 0-6z"/>',
  }),
  party: () => ({
    vb: "0 -14 64 96",
    body: `<g class="kira-dance">${KIRA_BODY}<path class="kira-hat" d="M24 6l8-18 8 18z"/><circle class="kira-pom" cx="32" cy="-12" r="2.6"/>` +
      `${KIRA_HAPPY_EYES}<path class="kira-mouth" d="M26 44q6 9 12 0z"/><path class="kira-arm" d="M7 32l-6-9M57 32l6-9"/></g>` +
      '<g class="kira-confetti"><rect class="kc-a" x="2" y="0" width="4" height="6"/><circle class="kc-b" cx="60" cy="4" r="2.4"/>' +
      '<rect class="kc-c" x="54" y="-6" width="4" height="6"/><circle class="kc-c" cx="8" cy="-8" r="2.4"/></g>',
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
  const d = KIRA_DRAW[m](o);
  const cls = ["kira", `kira--${m}`];
  if (o.idle) cls.push("is-idle");
  if (o.moment) cls.push("is-moment");
  if (o.wave && m === "happy") cls.push("is-waving");
  if (o.cls) cls.push(o.cls);
  return `<svg class="${cls.join(" ")}" viewBox="${d.vb}" aria-hidden="true" focusable="false">${d.body}</svg>`;
}

const kiraReducedMotion = () => {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
};

/* The logging hop: a small proud Kira hops on the confirmation toast while a
   coin drops in beside it. Once, ~650ms, then gone. Nothing at all under
   reduced motion (the toast already says it). */
let kiraHopEl = null;
let kiraHopTimer = null;
function kiraHop() {
  if (kiraReducedMotion()) return;
  const toastEl = document.getElementById("toast");
  if (!toastEl || !toastEl.classList.contains("show")) return;
  if (kiraHopEl) kiraHopEl.remove();
  clearTimeout(kiraHopTimer);
  const el = document.createElement("div");
  el.className = "kira-hop";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = kiraSvg("proud") +
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
  el.style.top = `${Math.round(restTop - 34)}px`;
  kiraHopEl = el;
  kiraHopTimer = setTimeout(() => { el.remove(); if (kiraHopEl === el) kiraHopEl = null; }, 900);
}

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
  const mood = !show ? "" : sleepy ? "sleepy" : "happy";
  if (slot.dataset.mood === mood) return;
  slot.dataset.mood = mood;
  slot.innerHTML = mood ? kiraSvg(mood, { moment: true }) : "";
}
