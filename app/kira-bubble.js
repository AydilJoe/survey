/* Duitful 2.0 (stage A): the middle Jelly Bubble, its 4-bubble radial,
   hold-to-pop bubbling audio/haptics, Money out 3-tab modal, Income modal,
   Unified Kira/Docs hub sheet, Settings toggles, and the ☰ menu.

   - The Jelly Bubble sits in the middle of the bottom bar (first item of the
     side rail / sidebar on wider screens, FoldLab.navFor). Its face is Kira
     when kiraTier() is not "free" (AI+, lifetime Pro, Pro trial), else a big +
     in a dark Jelly capsule. Kira is proud and idle, wears the season's outfit
     (kiraSvg), listens while the Voice sheet's mic is open and counts on the
     sempoa only while on-device AI is working (syncAiThinkingUi in script.js
     calls kiraBubbleSync).
   - A tap plays a soft bloop + light haptic + squish and fans out the 4 Jelly
     bubbles (#radial-dialog): Scan, Money out, Income, Kira (Paid/Pro/Trial) /
     Docs (Free).
   - A hold (BUBBLE_HOLD_MS = 480ms, both Free and Paid) plays initial bloop →
     rising liquid bubbling blips synced with escalating vibration/haptics
     (cancelling immediately on early release / move / cancel) → POP! + 14
     droplets and opens #voice-dialog already listening hands-free.
   - Money out (#add-dialog, openAddEntry) is a 3-tab modal (Spend / Split /
     Pay debt) reusing #form-daily with every id kept.
   - Income (#income-dialog, openIncomeModal) shares state.income save logic
     with #form-income.
   - Kira / Docs hub (#kira-hub-dialog, openKiraHub) shows a compact Kira meter
     (when server quota is known) or "Get Kira" card (Free), accessible voice
     entry (#btn-voice), and the 4 doc import flows below.
   - ☰ (#btn-menu) opens #menu-dialog: Search, Kira & Docs, Settings, All
     entries, Reports, Tax, Wallets, Help & tour, What's new. */

const BUBBLE_HOLD_MS = 480;
const BUBBLE_HOLD_SLOP = 12;
const MENU_HINT_KEY = "duitful.menuHint";
const SOUND_OFF_KEY = "duitful.soundOff";
const HAPTICS_OFF_KEY = "duitful.hapticsOff";
const BUBBLE_PLUS = '<svg class="bubble-plus" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

/* ---------- Sound & Haptics preferences (device-only, ON by default) ---------- */

function kiraSoundEnabled() {
  try { return localStorage.getItem(SOUND_OFF_KEY) !== "1"; } catch { return true; }
}

function kiraHapticsEnabled() {
  try { return localStorage.getItem(HAPTICS_OFF_KEY) !== "1"; } catch { return true; }
}

function setKiraSoundEnabled(on) {
  try {
    if (on) localStorage.removeItem(SOUND_OFF_KEY);
    else localStorage.setItem(SOUND_OFF_KEY, "1");
  } catch {}
  const el = bubbleEl("pref-bubble-sound");
  if (el && el.checked !== !!on) el.checked = !!on;
}

function setKiraHapticsEnabled(on) {
  try {
    if (on) localStorage.removeItem(HAPTICS_OFF_KEY);
    else localStorage.setItem(HAPTICS_OFF_KEY, "1");
  } catch {}
  const el = bubbleEl("pref-haptics");
  if (el && el.checked !== !!on) el.checked = !!on;
}

function initBubblePrefs() {
  const soundEl = bubbleEl("pref-bubble-sound");
  if (soundEl) {
    soundEl.checked = kiraSoundEnabled();
    soundEl.addEventListener("change", () => {
      setKiraSoundEnabled(soundEl.checked);
      if (soundEl.checked) playBloop();
    });
  }
  const hapticsEl = bubbleEl("pref-haptics");
  if (hapticsEl) {
    hapticsEl.checked = kiraHapticsEnabled();
    hapticsEl.addEventListener("change", () => {
      setKiraHapticsEnabled(hapticsEl.checked);
      if (hapticsEl.checked) kiraHaptic(12, "LIGHT");
    });
  }
}

/* ---------- Web Audio & Haptics primitives ---------- */

let bubbleAudioCtx = null;
let bubblingTimer = 0;

function ensureBubbleAudio() {
  if (!kiraSoundEnabled()) return null;
  try {
    if (!bubbleAudioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) bubbleAudioCtx = new AC();
    }
    if (bubbleAudioCtx && bubbleAudioCtx.state === "suspended") {
      bubbleAudioCtx.resume().catch(() => {});
    }
    return bubbleAudioCtx;
  } catch { return null; }
}

function playBloop() {
  const ctx = ensureBubbleAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(540, now + 0.11);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  } catch {}
}

function playBubbleBlip(step) {
  const ctx = ensureBubbleAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const base = 240 + step * 55 + (Math.random() * 65 - 25);
    const peak = base * (1.75 + Math.random() * 0.35);
    const dur = 0.055 + Math.random() * 0.025;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(peak, now + dur);
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(peak * 0.9, now);
    filter.Q.value = 3.2;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.14 + Math.min(step * 0.018, 0.09), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  } catch {}
}

function playPop() {
  const ctx = ensureBubbleAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(980, now + 0.045);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.095);
    g1.gain.setValueAtTime(0.001, now);
    g1.gain.linearRampToValueAtTime(0.28, now + 0.01);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(g1).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.11);

    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.25));
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1400;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.22, now);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    noise.connect(filter).connect(g2).connect(ctx.destination);
    noise.start(now);
  } catch {}
}

function kiraHaptic(pattern, style) {
  if (!kiraHapticsEnabled()) return;
  try {
    if (pattern === 0) {
      if (navigator.vibrate) navigator.vibrate(0);
      return;
    }
    const capHaptics = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (capHaptics && typeof capHaptics.impact === "function") {
      capHaptics.impact({ style: style || "LIGHT" }).catch(() => {});
      return;
    }
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {}
}

function startBubbling() {
  stopBubbling();
  let step = 0;
  const tick = () => {
    playBubbleBlip(step);
    kiraHaptic(Math.min(10 + step * 4, 30), step < 3 ? "LIGHT" : "MEDIUM");
    step++;
    const nextDelay = Math.max(48, 82 - step * 6) + Math.floor(Math.random() * 14);
    bubblingTimer = setTimeout(tick, nextDelay);
  };
  bubblingTimer = setTimeout(tick, 65);
}

function stopBubbling() {
  if (bubblingTimer) {
    clearTimeout(bubblingTimer);
    bubblingTimer = 0;
  }
}

function kiraPlaySaveFeedback() {
  playBloop();
  kiraHaptic([12, 40, 18], "MEDIUM");
}

function bubbleReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch { return false; }
}

function squishBubble(btn) {
  if (!btn || bubbleReducedMotion()) return;
  btn.classList.remove("is-squish");
  void btn.offsetWidth;
  btn.classList.add("is-squish");
  setTimeout(() => btn.classList.remove("is-squish"), 560);
}

function spawnPopDroplets(btn) {
  if (!btn || bubbleReducedMotion()) return;
  const r = btn.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  for (let i = 0; i < 14; i++) {
    const dot = document.createElement("span");
    dot.className = "pop-particle";
    const ang = (Math.PI * 2 * i) / 14 + (Math.random() * 0.3 - 0.15);
    const dist = 42 + Math.random() * 58;
    dot.style.left = `${cx}px`;
    dot.style.top = `${cy}px`;
    dot.style.setProperty("--dx", `${Math.round(Math.cos(ang) * dist)}px`);
    dot.style.setProperty("--dy", `${Math.round(Math.sin(ang) * dist - 18)}px`);
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 620);
  }
}

/* ---------- Tier, quota & bubble face ---------- */

/* Which Kira this person has. The server's quota (op=status) comes from the
   AI+ work; until then the tier is worked out here from what the vault
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
  const now = new Date();
  const curPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  if (!s.periodKey || s.periodKey !== curPeriod || !limit) return null;
  const used = Math.max(0, Number(s.textUsed) || 0);
  const scansLimit = Number(s.scansLimit) || 0;
  const scansUsed = Math.max(0, Number(s.scansUsed) || 0);
  const out = { left: Math.max(0, limit - used), limit };
  if (scansLimit > 0) {
    out.scansLeft = Math.max(0, scansLimit - scansUsed);
    out.scansLimit = scansLimit;
  }
  if (s.resetsAt || s.expiresAt) out.resetsAt = s.resetsAt || s.expiresAt;
  return out;
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

  // Sync the 4th radial bubble: Kira (sparkle) on Paid/Pro/Trial, Docs (page) on Free.
  const hubLabel = bubbleEl("radial-kira-label");
  if (hubLabel) {
    const nextText = kira ? tr("Kira") : tr("Docs");
    if (hubLabel.textContent !== nextText) hubLabel.textContent = nextText;
  }
  const kiraIcon = bubbleEl("radial-kira-icon");
  const docsIcon = bubbleEl("radial-docs-icon");
  if (kiraIcon) kiraIcon.hidden = !kira;
  if (docsIcon) docsIcon.hidden = kira;
}

/* ---------- Money out 3-tab modal (#add-dialog) ---------- */

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
  if (title) {
    title.textContent = addEntryFresh()
      ? tr("Log your first spend")
      : (kind === "saving" ? tr("Save") : tr("Money out"));
  }
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

function openSplitFromOutflow() {
  const form = bubbleEl("form-daily");
  const total = form ? Number(form.querySelector('input[name="amount"]')?.value) || 0 : 0;
  const note = form ? (form.querySelector('input[name="note"]')?.value || "").trim() : "";
  const category = form ? (form.querySelector('input[name="category"]')?.value || "").trim() : "";
  const date = form ? (form.querySelector('input[name="date"]')?.value || "") : "";
  closeAddEntry();
  if (typeof splitOpenCompose === "function") {
    splitOpenCompose({
      mode: "split",
      title: note || category,
      total,
      date,
      category,
      fromForm: true,
    });
  } else {
    bubbleEl("btn-split-quick")?.click();
  }
}

/* ---------- Income modal (#income-dialog) ---------- */

function openIncomeModal(opts) {
  const o = opts || {};
  const dlg = bubbleEl("income-dialog");
  if (!dlg) return;
  radialClose();
  const menu = bubbleEl("menu-dialog");
  if (menu && menu.open) menu.close();
  const form = bubbleEl("form-income-quick");
  if (form) {
    const monthEl = form.querySelector('input[name="month"]');
    if (monthEl && !monthEl.value) {
      const m = (typeof selectedMonth !== "undefined" && selectedMonth)
        ? selectedMonth
        : (typeof currentMonthISO === "function" ? currentMonthISO() : "");
      if (m) monthEl.value = m;
    }
  }
  if (!dlg.open && typeof dlg.showModal === "function") dlg.showModal();
  if (o.focus !== false) {
    const amount = document.querySelector("#form-income-quick input[name='amount']");
    setTimeout(() => { try { amount && amount.focus({ preventScroll: true }); } catch {} }, 30);
  }
}

function closeIncomeModal() {
  const dlg = bubbleEl("income-dialog");
  if (dlg && dlg.open) dlg.close();
}

function initIncomeModal() {
  const dlg = bubbleEl("income-dialog");
  if (!dlg) return;
  bubbleEl("income-dialog-close")?.addEventListener("click", closeIncomeModal);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeIncomeModal(); });
  const moreBtn = bubbleEl("income-more-toggle");
  const moreWrap = bubbleEl("income-more");
  if (moreBtn && moreWrap) {
    moreBtn.addEventListener("click", () => {
      const next = moreWrap.hidden;
      moreWrap.hidden = !next;
      moreBtn.setAttribute("aria-expanded", next ? "true" : "false");
    });
  }
}

/* ---------- Unified Kira / Docs hub sheet (#kira-hub-dialog) ---------- */

function syncKiraHub() {
  const tier = kiraTier();
  const isPaid = tier !== "free";
  const aiOn = typeof aiCloudAllowed === "function" && aiCloudAllowed();

  const title = bubbleEl("kira-hub-title");
  if (title) title.textContent = isPaid ? tr("Kira") : tr("Import Docs");

  const badge = bubbleEl("kira-hub-badge");
  if (badge) {
    badge.classList.toggle("is-local", !isPaid);
    if (tier === "aiplus") badge.textContent = tr("AI+ Active");
    else if (tier === "pro_taste") badge.textContent = tr("Pro");
    else if (tier === "trial") badge.textContent = tr("Trial");
    else badge.textContent = tr("On-device");
  }

  const meter = bubbleEl("kira-hub-meter");
  const meterText = bubbleEl("kira-hub-meter-text");
  const meterSub = bubbleEl("kira-hub-meter-sub");
  const q = isPaid ? kiraQuota() : null;
  if (meter) {
    meter.hidden = !q;
    if (q && meterText) {
      meterText.textContent = tr("Kira this month: {n} of {m} left", { n: q.left, m: q.limit });
    }
    if (meterSub) {
      if (q && q.resetsAt) {
        const dt = new Date(q.resetsAt);
        const dateStr = Number.isNaN(dt.getTime()) ? String(q.resetsAt) : dt.toLocaleDateString(typeof dateLocale === "function" ? dateLocale() : undefined, { day: "numeric", month: "short" });
        meterSub.textContent = tr("Resets {date}", { date: dateStr });
        meterSub.hidden = false;
      } else {
        meterSub.hidden = true;
      }
    }
  }

  const upsell = bubbleEl("kira-hub-upsell");
  const priceEl = bubbleEl("kira-hub-price");
  if (upsell) {
    upsell.hidden = isPaid;
    if (!isPaid && priceEl) {
      const price = typeof aiPriceLabel === "function" ? aiPriceLabel("monthly") : "";
      priceEl.textContent = price ? tr("From {price}", { price }) : "";
    }
  }

  const pills = document.querySelectorAll("#kira-hub-dialog [data-hub-pill]");
  pills.forEach((pill) => {
    const key = pill.dataset.hubPill;
    const isAi = key === "loan" ? true : aiOn;
    pill.textContent = isAi ? tr("AI+") : tr("Local");
    pill.classList.toggle("is-local", !isAi);
  });
}

function openKiraHub() {
  const dlg = bubbleEl("kira-hub-dialog");
  if (!dlg) return;
  radialClose();
  const menu = bubbleEl("menu-dialog");
  if (menu && menu.open) menu.close();
  syncKiraHub();
  if (!dlg.open && typeof dlg.showModal === "function") dlg.showModal();
}

function closeKiraHub() {
  const dlg = bubbleEl("kira-hub-dialog");
  if (dlg && dlg.open) dlg.close();
}

function initKiraHub() {
  const dlg = bubbleEl("kira-hub-dialog");
  if (!dlg) return;
  bubbleEl("kira-hub-close")?.addEventListener("click", closeKiraHub);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeKiraHub(); });
  // Close hub before #btn-voice's own handler (voice.js) opens #voice-dialog.
  dlg.addEventListener("click", (e) => {
    const voiceBtn = e.target instanceof Element ? e.target.closest("#btn-voice") : null;
    if (voiceBtn) closeKiraHub();
  }, { capture: true });

  bubbleEl("kira-hub-get-ai")?.addEventListener("click", () => {
    closeKiraHub();
    if (typeof aiPlusFlagOn === "function" && !aiPlusFlagOn()) {
      if (typeof openPaywall === "function") openPaywall();
    } else if (typeof openAiPaywall === "function") {
      openAiPaywall();
    } else if (typeof openPaywall === "function") {
      openPaywall();
    }
  });

  bubbleEl("hub-doc-statement")?.addEventListener("click", () => {
    closeKiraHub();
    if (typeof openStatementImport === "function") openStatementImport();
  });

  bubbleEl("hub-doc-ea")?.addEventListener("click", () => {
    closeKiraHub();
    if (typeof taxOpenEa === "function") taxOpenEa();
  });

  bubbleEl("hub-doc-loan")?.addEventListener("click", () => {
    closeKiraHub();
    if (typeof aiCloudAllowed === "function" && aiCloudAllowed()) {
      if (typeof switchTab === "function") switchTab("debts");
      const formDebt = bubbleEl("form-debt");
      if (formDebt && formDebt.hidden) {
        document.querySelector('[data-add-toggle="form-debt"]')?.click();
      }
      setTimeout(() => { bubbleEl("debt-letter-file")?.click(); }, 40);
    } else if (typeof openAiPaywall === "function") {
      openAiPaywall();
    }
  });

  bubbleEl("hub-doc-split")?.addEventListener("click", () => {
    closeKiraHub();
    if (typeof splitOpenCompose === "function") {
      splitOpenCompose({ mode: "split", method: "item" });
    }
  });
}

/* ---------- 4-Bubble Jelly Radial ---------- */

function radialItems() {
  return [...document.querySelectorAll("#radial .radial-item")].filter((b) => !b.hidden);
}

function radialSide() {
  const nav = document.querySelector(".tabs");
  return !!nav && getComputedStyle(nav).flexDirection === "column";
}

/* n points spread evenly by length along the upper half of an ellipse
   (from 160° round to 20°): the 4 Jelly bubbles sit evenly along the arc. */
function radialArc(n, rx, ry) {
  const a0 = 160 * Math.PI / 180, a1 = 20 * Math.PI / 180, steps = 280;
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
    Math.max(106, Math.min(132, cx - 48, vw - cx - 48)),
    Math.max(112, Math.min(138, cy - 84)));
  items.forEach((el, i) => {
    let x, y;
    if (!side) {
      const pt = arc[i];
      x = cx + pt.x;
      y = cy - pt.y;
    } else {
      const step = 64;
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
  kiraBubbleSync();
  radialSyncMeter();
  dlg.classList.remove("is-in");
  if (typeof dlg.showModal === "function") dlg.showModal();
  // Laid out once open, so each item's own width is known.
  radialLayout();
  if (btn) btn.setAttribute("aria-expanded", "true");
  // Next frame, so the items start at the bubble and spring out.
  requestAnimationFrame(() => requestAnimationFrame(() => dlg.classList.add("is-in")));
  const items = radialItems();
  const outflow = items.findIndex((b) => b.dataset.radial === "outflow");
  radialFocus(outflow < 0 ? 0 : outflow);
}

function radialClose() {
  const dlg = bubbleEl("radial-dialog");
  if (dlg && dlg.open) dlg.close();
}

function radialRun(kind) {
  switch (kind) {
    case "outflow": openAddEntry("expense"); break;
    case "income": openIncomeModal(); break;
    case "kira": openKiraHub(); break;
    // scan (#btn-scan, ocr.js) runs its own handler after capture radialClose().
    default: break;
  }
}

/* ---------- Tap vs Hold-to-Pop ---------- */

let bubbleHold = null;
let bubbleHoldFiredAt = 0;
let bubblePointerStarted = false;

function cancelHold(keepPointer) {
  const h = bubbleHold;
  if (h) clearTimeout(h.timer);
  stopBubbling();
  if (!h || !h.fired) kiraHaptic(0);
  const btn = bubbleEl("kira-bubble");
  if (btn) btn.classList.remove("is-charging");
  bubbleHold = null;
  if (!keepPointer) bubblePointerStarted = false;
}

function initBubble() {
  const btn = bubbleEl("kira-bubble");
  const dlg = bubbleEl("radial-dialog");
  if (!btn || !dlg) return;

  btn.addEventListener("pointerdown", (e) => {
    if (e.button || dlg.open) return;
    cancelHold();
    bubblePointerStarted = true;
    playBloop();
    kiraHaptic(12, "LIGHT");
    startBubbling();
    btn.classList.add("is-charging");
    const h = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
    h.timer = setTimeout(() => {
      if (bubbleHold !== h) return;
      h.fired = true;
      bubbleHoldFiredAt = Date.now();
      stopBubbling();
      btn.classList.remove("is-charging");
      btn.classList.add("is-popped");
      spawnPopDroplets(btn);
      playPop();
      kiraHaptic(38, "HEAVY");
      radialClose();
      if (typeof openVoiceEntry === "function") openVoiceEntry("", { listen: true });
      setTimeout(() => btn.classList.remove("is-popped"), 340);
    }, BUBBLE_HOLD_MS);
    bubbleHold = h;
  }, { passive: true });

  document.addEventListener("pointermove", (e) => {
    const h = bubbleHold;
    if (!h || h.fired || e.pointerId !== h.id) return;
    if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > BUBBLE_HOLD_SLOP) cancelHold();
  }, { capture: true, passive: true });

  btn.addEventListener("pointerleave", (e) => {
    const h = bubbleHold;
    if (!h || h.fired || e.pointerId !== h.id) return;
    cancelHold();
  }, { passive: true });

  const release = (e) => {
    const h = bubbleHold;
    if (!h || e.pointerId !== h.id) return;
    if (h.fired) bubbleHoldFiredAt = Date.now();
    // Do NOT call voiceStopListening() after POP so #voice-dialog stays listening hands-free.
    cancelHold(e.type === "pointerup");
  };
  document.addEventListener("pointerup", release, { capture: true, passive: true });
  document.addEventListener("pointercancel", release, { capture: true, passive: true });
  window.addEventListener("blur", () => cancelHold());
  btn.addEventListener("contextmenu", (e) => e.preventDefault());

  btn.addEventListener("click", (e) => {
    // The click that ends a hold-to-pop is not a tap.
    if (Date.now() - bubbleHoldFiredAt < 900) {
      bubbleHoldFiredAt = 0;
      bubblePointerStarted = false;
      return;
    }
    if (!bubblePointerStarted || e.detail === 0) {
      playBloop();
      kiraHaptic(10, "LIGHT");
    }
    bubblePointerStarted = false;
    squishBubble(btn);
    if (dlg.open) radialClose(); else radialOpen();
  });

  // Close first (capture), then the item's own handler opens its sheet, so
  // the next dialog never sits under this one.
  dlg.addEventListener("click", (e) => {
    const item = e.target instanceof Element ? e.target.closest(".radial-item") : null;
    if (item) {
      playBloop();
      kiraHaptic(10, "LIGHT");
      radialClose();
      radialRun(item.dataset.radial);
      return;
    }
    if (e.target === dlg || (e.target instanceof Element && (e.target.closest("#radial-close") || e.target.id === "radial"))) {
      playBloop();
      kiraHaptic(10, "LIGHT");
      radialClose();
      squishBubble(btn);
    }
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
  // Money out "Split" tab prefills from #form-daily and opens split compose.
  add?.querySelector('[data-outflow-tab="split"]')?.addEventListener("click", openSplitFromOutflow);

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
  bubbleEl("menu-kira-hub")?.addEventListener("click", openKiraHub);
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

initBubblePrefs();
initBubble();
initIncomeModal();
initKiraHub();
initMenu();
initMenuHint();

window.kiraTier = kiraTier;
window.kiraQuota = kiraQuota;
window.kiraBubbleSync = kiraBubbleSync;
window.kiraSoundEnabled = kiraSoundEnabled;
window.kiraHapticsEnabled = kiraHapticsEnabled;
window.kiraPlaySaveFeedback = kiraPlaySaveFeedback;
window.kiraHaptic = kiraHaptic;
window.kiraPlayBloop = playBloop;
window.openAddEntry = openAddEntry;
window.closeAddEntry = closeAddEntry;
window.openIncomeModal = openIncomeModal;
window.closeIncomeModal = closeIncomeModal;
window.openKiraHub = openKiraHub;
window.closeKiraHub = closeKiraHub;
window.radialOpen = radialOpen;
window.radialClose = radialClose;
window.menuOpen = menuOpen;
window.menuHintMaybe = menuHintMaybe;
