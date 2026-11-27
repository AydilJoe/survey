/* Duitful 2.0 (stage A): the middle bubble, its radial actions, the Add entry
   sheet and the ☰ menu.

   - The bubble sits in the middle of the bottom bar (first item of the side
     rail / sidebar on wider screens, FoldLab.navFor). Its face is Kira when
     the person's Kira tier is not "free" (kiraTier: AI+, lifetime Pro, the
     Pro trial), else a big +. Kira there is proud and idle, wears the
     season's outfit (kiraSvg), listens while the Voice sheet's mic is open
     and counts on the sempoa only while on-device AI is working
     (syncAiThinkingUi in script.js calls kiraBubbleSync).
   - A tap opens the radial actions (#radial-dialog): Scan receipt, Pay debt,
     Save, Spend, Split a bill, No spend today, Talk. A hold (BUBBLE_HOLD_MS)
     opens Talk already listening; letting go stops (voice.js).
   - Spend / Pay debt / Save open the Add entry sheet (#add-dialog,
     openAddEntry): the old Home form, moved, with every id kept.
   - ☰ (#btn-menu) opens #menu-dialog: Search, Settings, All entries,
     Reports, Tax, Wallets, Help & tour, What's new. Once after the update,
     people who already had data get "Settings moved here" beside it. */

const BUBBLE_HOLD_MS = 350;
const BUBBLE_HOLD_SLOP = 12;
const MENU_HINT_KEY = "duitful.menuHint";
const BUBBLE_PLUS = '<svg class="bubble-plus" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

/* Which Kira this person has. The server's quota (op=status) comes later from
   the AI+ work; until then the tier is worked out here from what the vault
   already knows. AI+ beats Pro, Pro beats the trial. */
function kiraTier() {
  if (typeof state === "undefined" || !state) return "free";
  if (typeof aiSubIsActive === "function" && aiSubIsActive(state.aiSub)) return "aiplus";
  if (state.pro) return "pro_taste";
  if (typeof isTrialActive === "function" && isTrialActive()) return "trial";
  return "free";
}

/* What's left this month, only when the vault holds a real figure from the
   server (AI+ status). Unknown means no meter at all, never a guess. */
function kiraQuota() {
  if (kiraTier() !== "aiplus") return null;
  const s = state.aiSub || {};
  const limit = Number(s.textLimit) || 0;
  if (!s.periodKey || !limit) return null;
  const used = Math.max(0, Number(s.textUsed) || 0);
  return { left: Math.max(0, limit - used), limit };
}

function bubbleEl(id) { return document.getElementById(id); }

function aiThinkingNow() {
  // aiThinkTokens / aiBatch live in script.js (withAiThinking).
  try {
    return (typeof aiThinkTokens !== "undefined" && aiThinkTokens.size > 0)
      || (typeof aiBatch !== "undefined" && !!aiBatch);
  } catch { return false; }
}

function kiraBubbleMood() {
  if (kiraTier() === "free") return "";
  const voice = bubbleEl("voice-dialog");
  if (voice && voice.open && voice.classList.contains("is-listening")) return "listening";
  if (aiThinkingNow()) return "ai";
  return "proud";
}

/* Redraws the face only when it changes, so the idle loop keeps running. */
function kiraBubbleSync() {
  const btn = bubbleEl("kira-bubble");
  const face = bubbleEl("kira-bubble-face");
  if (!btn || !face) return;
  const mood = kiraBubbleMood();
  if (face.dataset.mood !== mood) {
    face.dataset.mood = mood;
    if (!mood) face.innerHTML = BUBBLE_PLUS;
    // The sempoa means on-device AI and nothing else: only while
    // withAiThinking has a call in flight (aiThinkingNow).
    else if (mood === "ai") face.innerHTML = kiraSvg("counting", { ai: true, idle: true });
    else face.innerHTML = kiraSvg(mood, { idle: true });
  }
  const kira = !!mood;
  btn.classList.toggle("is-kira", kira);
  document.body.classList.toggle("bubble-kira", kira);
  const label = kira ? tr("Kira: add or ask") : tr("Add");
  if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
}

/* ---------- Add entry sheet ---------- */

function addEntryFresh() {
  if (typeof state === "undefined" || !state) return false;
  return !((state.income?.length || 0) + (state.expenses?.length || 0) + (state.dailyExpenses?.length || 0)
    + (state.debts?.length || 0) + (state.savings?.length || 0));
}

// kind: "expense" | "debt" | "saving" (or nothing: keep the current one).
function openAddEntry(kind, opts) {
  const o = opts || {};
  const dlg = bubbleEl("add-dialog");
  if (!dlg) return;
  radialClose();
  const menu = bubbleEl("menu-dialog");
  if (menu && menu.open) menu.close();
  if (kind) { try { setDailyType(kind); } catch {} }
  const title = bubbleEl("add-dialog-title");
  if (title) title.textContent = addEntryFresh() ? tr("Log your first spend") : tr("Add entry");
  if (!dlg.open && typeof dlg.showModal === "function") dlg.showModal();
  if (o.focus !== false) {
    const amount = document.querySelector("#form-daily input[name='amount']");
    setTimeout(() => { try { amount && amount.focus({ preventScroll: true }); } catch {} }, 30);
  }
}

function closeAddEntry() {
  const dlg = bubbleEl("add-dialog");
  if (dlg && dlg.open) dlg.close();
}

/* ---------- Radial actions ---------- */

function radialItems() {
  return [...document.querySelectorAll("#radial .radial-item")].filter((b) => !b.hidden);
}

function radialSide() {
  const nav = document.querySelector(".tabs");
  return !!nav && getComputedStyle(nav).flexDirection === "column";
}

/* n points spread evenly by length along the upper half of an ellipse
   (from 166° round to 14°): the items stay the same distance apart whether
   the arc runs up its sides or across its top. */
function radialArc(n, rx, ry) {
  const a0 = 166 * Math.PI / 180, a1 = 14 * Math.PI / 180, steps = 280;
  const pts = [];
  let len = 0, prev = null;
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps);
    const p = { x: rx * Math.cos(a), y: ry * Math.sin(a) };
    if (prev) len += Math.hypot(p.x - prev.x, p.y - prev.y);
    pts.push({ ...p, at: len });
    prev = p;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const want = n > 1 ? (len * i) / (n - 1) : len / 2;
    out.push(pts.find((p) => p.at >= want - 0.01) || pts[pts.length - 1]);
  }
  return out;
}

/* Lays the fan out from where the bubble is right now. Phones: an arc over
   the bubble, left to right. Rail and sidebar: a curved column opening
   sideways and down (two columns when the screen is short). */
function radialLayout() {
  const btn = bubbleEl("kira-bubble");
  const items = radialItems();
  if (!btn || !items.length) return;
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const side = radialSide();
  const dlg = bubbleEl("radial-dialog");
  if (dlg) dlg.classList.toggle("is-side", side);
  const n = items.length;
  const arc = side ? null : radialArc(n,
    Math.max(110, Math.min(170, cx - 44, vw - cx - 44)),
    Math.max(140, Math.min(300, cy - 80)));
  items.forEach((el, i) => {
    let x, y;
    if (!side) {
      const pt = arc[i];
      x = cx + pt.x;
      y = cy - pt.y;
    } else {
      const step = 60;
      const top = cy + r.height / 2 + 44;
      const perCol = Math.max(3, Math.min(n, Math.floor((vh - top - 24) / step) + 1));
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const inCol = Math.min(perCol, n - col * perCol);
      const bulge = inCol > 1 ? Math.sin(Math.PI * row / (inCol - 1)) * 26 : 0;
      x = cx + 34 + col * 200 + bulge;
      y = top + row * step;
    }
    // Keep the whole item (dot and label) on screen.
    if (!side && el.offsetWidth) x = Math.min(vw - el.offsetWidth / 2 - 6, Math.max(el.offsetWidth / 2 + 6, x));
    el.style.setProperty("--x", `${Math.round(x)}px`);
    el.style.setProperty("--y", `${Math.round(y)}px`);
    el.style.setProperty("--dx", `${Math.round(cx - x)}px`);
    el.style.setProperty("--dy", `${Math.round(cy - y)}px`);
    el.style.setProperty("--i", String(side ? i : Math.abs(i - (n - 1) / 2)));
  });
  const close = bubbleEl("radial-close");
  if (close) {
    close.style.setProperty("--x", `${Math.round(cx)}px`);
    close.style.setProperty("--y", `${Math.round(cy)}px`);
    close.style.setProperty("--s", `${Math.round(r.width)}px`);
  }
  const meter = bubbleEl("radial-meter");
  if (meter && !meter.hidden) {
    const topY = arc ? Math.min(...arc.map((p) => cy - p.y)) : r.top;
    meter.style.setProperty("--x", `${Math.round(side ? cx + 44 : cx)}px`);
    meter.style.setProperty("--y", `${Math.round(side ? Math.max(12, r.top) : Math.max(12, topY - 80))}px`);
  }
}

function radialSyncMeter() {
  const meter = bubbleEl("radial-meter");
  if (!meter) return;
  const q = kiraQuota();
  meter.hidden = !q;
  if (q) meter.textContent = tr("Kira this month: {n} of {m} left", { n: q.left, m: q.limit });
}

function radialFocus(i) {
  const items = radialItems();
  if (!items.length) return;
  const k = (i + items.length) % items.length;
  items.forEach((b, j) => b.setAttribute("tabindex", j === k ? "0" : "-1"));
  try { items[k].focus({ preventScroll: true }); } catch {}
}

function radialOpen() {
  const dlg = bubbleEl("radial-dialog");
  const btn = bubbleEl("kira-bubble");
  if (!dlg || dlg.open) return;
  radialSyncMeter();
  dlg.classList.remove("is-in");
  if (typeof dlg.showModal === "function") dlg.showModal();
  // Laid out once open, so each item's own width is known.
  radialLayout();
  if (btn) btn.setAttribute("aria-expanded", "true");
  // Next frame, so the items start at the bubble and spring out.
  requestAnimationFrame(() => requestAnimationFrame(() => dlg.classList.add("is-in")));
  const items = radialItems();
  const spend = items.findIndex((b) => b.dataset.radial === "spend");
  radialFocus(spend < 0 ? 0 : spend);
}

function radialClose() {
  const dlg = bubbleEl("radial-dialog");
  if (dlg && dlg.open) dlg.close();
}

function radialRun(kind) {
  switch (kind) {
    case "spend": openAddEntry("expense"); break;
    case "debt": openAddEntry("debt"); break;
    case "saving": openAddEntry("saving"); break;
    case "split": bubbleEl("btn-split-quick")?.click(); break;
    case "nospend": {
      const info = typeof computeStreak === "function" && state ? computeStreak(state) : null;
      if (info && info.enabled && !info.checkedInToday && !info.hasDailyEntryToday && typeof checkInNoSpendToday === "function") checkInNoSpendToday();
      else if (typeof openStreakDialog === "function") openStreakDialog();
      break;
    }
    // scan (#btn-scan, ocr.js) and talk (#btn-voice, voice.js) run their own handlers.
    default: break;
  }
}

/* ---------- Hold to talk ---------- */

let bubbleHold = null;
let bubbleHoldFiredAt = 0;

function bubbleHoldClear() {
  if (bubbleHold) clearTimeout(bubbleHold.timer);
  bubbleHold = null;
}

function initBubble() {
  const btn = bubbleEl("kira-bubble");
  const dlg = bubbleEl("radial-dialog");
  if (!btn || !dlg) return;

  btn.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    bubbleHoldClear();
    const h = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
    h.timer = setTimeout(() => {
      if (bubbleHold !== h) return;
      h.fired = true;
      bubbleHoldFiredAt = Date.now();
      radialClose();
      if (typeof openVoiceEntry === "function") openVoiceEntry("", { listen: true });
    }, BUBBLE_HOLD_MS);
    bubbleHold = h;
  }, { passive: true });
  document.addEventListener("pointermove", (e) => {
    const h = bubbleHold;
    if (!h || h.fired || e.pointerId !== h.id) return;
    if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > BUBBLE_HOLD_SLOP) bubbleHoldClear();
  }, { capture: true, passive: true });
  const release = (e) => {
    const h = bubbleHold;
    if (!h || e.pointerId !== h.id) return;
    bubbleHoldClear();
    if (h.fired && typeof voiceStopListening === "function") voiceStopListening();
  };
  document.addEventListener("pointerup", release, { capture: true, passive: true });
  document.addEventListener("pointercancel", release, { capture: true, passive: true });
  btn.addEventListener("contextmenu", (e) => e.preventDefault());

  btn.addEventListener("click", () => {
    // The click that ends a hold is not a tap.
    if (Date.now() - bubbleHoldFiredAt < 900) { bubbleHoldFiredAt = 0; return; }
    if (dlg.open) radialClose(); else radialOpen();
  });

  // Close first (capture), then the item's own handler opens its sheet, so
  // the next dialog never sits under this one.
  dlg.addEventListener("click", (e) => {
    const item = e.target instanceof Element ? e.target.closest(".radial-item") : null;
    if (item) { radialClose(); radialRun(item.dataset.radial); return; }
    if (e.target === dlg || (e.target instanceof Element && e.target.closest("#radial-close"))) radialClose();
    else if (e.target instanceof Element && e.target.id === "radial") radialClose();
  }, { capture: true });
  dlg.addEventListener("close", () => {
    dlg.classList.remove("is-in");
    btn.setAttribute("aria-expanded", "false");
  });
  dlg.addEventListener("keydown", (e) => {
    const items = radialItems();
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); radialFocus(at + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); radialFocus(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); radialFocus(0); }
    else if (e.key === "End") { e.preventDefault(); radialFocus(items.length - 1); }
  });
  window.addEventListener("resize", () => { if (dlg.open) radialLayout(); });

  const add = bubbleEl("add-dialog");
  bubbleEl("add-dialog-close")?.addEventListener("click", closeAddEntry);
  // A tap on the dimmed backdrop puts the sheet away (what's typed stays).
  add?.addEventListener("click", (e) => { if (e.target === add) closeAddEntry(); });

  kiraBubbleSync();
}

/* ---------- ☰ menu ---------- */

function menuOpen() {
  const dlg = bubbleEl("menu-dialog");
  if (!dlg || dlg.open) return;
  menuHintDone();
  if (typeof dlg.showModal === "function") dlg.showModal();
  bubbleEl("btn-menu")?.setAttribute("aria-expanded", "true");
}

function initMenu() {
  const btn = bubbleEl("btn-menu");
  const dlg = bubbleEl("menu-dialog");
  if (!btn || !dlg) return;
  btn.addEventListener("click", menuOpen);
  dlg.addEventListener("close", () => btn.setAttribute("aria-expanded", "false"));
  // Close before the item acts: data-go-tab switches page underneath, Search
  // and the tour open their own dialogs.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) { dlg.close(); return; }
    const item = e.target instanceof Element ? e.target.closest(".menu-item") : null;
    if (item) dlg.close();
  }, { capture: true });
  bubbleEl("menu-tour")?.addEventListener("click", () => { if (typeof openGuide === "function") openGuide(); });
  bubbleEl("menu-whats-new")?.addEventListener("click", () => { if (typeof showWhatsNewNow === "function") showWhatsNewNow(); });
}

/* "Settings moved here": once per device, only for people who used Duitful
   before 2.0. A brand-new vault marks it done on its first look, so a new
   user never sees a hint about a move they didn't live through. */
function menuHintStore() { try { return localStorage.getItem(MENU_HINT_KEY) || ""; } catch { return "x"; } }
function menuHintDone() {
  try { localStorage.setItem(MENU_HINT_KEY, "x"); } catch {}
  const hint = bubbleEl("menu-hint");
  if (hint) hint.hidden = true;
}

function menuHintMaybe() {
  const hint = bubbleEl("menu-hint");
  if (!hint || !hint.hidden || menuHintStore()) return;
  if (typeof state === "undefined" || !state) return;
  if (addEntryFresh()) { menuHintDone(); return; }
  const lock = bubbleEl("lock");
  if ((lock && !lock.hidden) || document.querySelector("dialog[open]")) return;
  const btn = bubbleEl("btn-menu");
  if (!btn || !btn.getClientRects().length) return;
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  hint.style.setProperty("--top", `${Math.round(r.bottom + (window.scrollY || 0) + 10)}px`);
  hint.style.setProperty("--right", `${Math.max(12, Math.round(vw - r.right - 6))}px`);
  hint.style.setProperty("--arrow", `${Math.round(r.width / 2) + 6}px`);
  // One Kira per screen: when the bubble is already Kira, the hint is words only.
  const kira = bubbleEl("menu-hint-kira");
  if (kira) {
    const bubbleKira = document.body.classList.contains("bubble-kira");
    kira.hidden = bubbleKira;
    if (!bubbleKira && !kira.innerHTML) kira.innerHTML = kiraSvg("happy", { moment: true });
  }
  hint.hidden = false;
}

function initMenuHint() {
  bubbleEl("menu-hint-ok")?.addEventListener("click", menuHintDone);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !bubbleEl("menu-hint")?.hidden) menuHintDone();
  });
}

initBubble();
initMenu();
initMenuHint();

window.kiraTier = kiraTier;
window.kiraQuota = kiraQuota;
window.kiraBubbleSync = kiraBubbleSync;
window.openAddEntry = openAddEntry;
window.closeAddEntry = closeAddEntry;
window.radialOpen = radialOpen;
window.radialClose = radialClose;
window.menuOpen = menuOpen;
window.menuHintMaybe = menuHintMaybe;
