/* ---------- Daily check-in streaks (v1.66.0) ----------
   A calm, privacy-first daily habit tracker:
   - Any logged entry (daily spend, debt payment, saving deposit, income, bill,
     or confirmed bank alert) OR a one-tap "No spend today" check-in keeps the
     streak going.
   - 2 free automatic streak freezes per calendar month bridge missed days
     without wiping a long streak (never sold, never Pro-gated).
   - Stored inside the encrypted vault (`state.streak`), round-tripped in CSV,
     completely hideable in Settings, and never affected by hide-amounts mode. */

const STREAK_FREEZES_PER_MONTH = 2;
const STREAK_MILESTONES = [7, 14, 30, 60, 100, 365];
const STREAK_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Escalating evening check-in copy — 10 rotating lines per tier, rotated by
   calendar day. Calm for new streaks (0–6d), playful Malaysian nudges for
   established streaks (7–29d), and full Malaysian drama for long streaks (30+d).
   Never mentions money amounts or wallets. */
const STREAK_REMINDER_TIERS = {
  calm: [
    { emoji: "✨", title: "Quick check-in",          body: "Log a spend or tap No spend today." },
    { emoji: "🌙", title: "How was today?",          body: "Add anything you spent, or mark a no-spend day." },
    { emoji: "📝", title: "Evening money check",     body: "A few seconds to log today and keep your rhythm." },
    { emoji: "🌇", title: "Before the day wraps up", body: "Anything to jot down? Zero-spend days count too." },
    { emoji: "🔥", title: "Keep your streak warm",   body: "One quick entry or a No spend tap takes two seconds." },
    { emoji: "☕", title: "Quiet daily habit",       body: "Did you spend today, or was it a no-spend day?" },
    { emoji: "📒", title: "End-of-day note",         body: "Log today's spending while it's still fresh." },
    { emoji: "🌱", title: "Small step, big clarity", body: "Check in for today. Even a no-spend day counts." },
    { emoji: "✅", title: "Your daily check-in",     body: "Tap to log today or celebrate a no-spend day." },
    { emoji: "🌿", title: "Pause and check in",      body: "Wrap up today with a quick entry or No spend today." },
  ],
  warm: [
    { emoji: "🔥", title: "{n}-day streak on the line lah",              body: "Log a quick spend or tap No spend today before midnight." },
    { emoji: "👀", title: "Eh, {n} days already. Don't waste it",        body: "Two seconds to check in. No spend today counts too lah." },
    { emoji: "📱", title: "Your {n}-day streak is calling you",          body: "Before you scroll TikTok, log today or tap No spend." },
    { emoji: "😅", title: "Sayang lah {n} days...",                      body: "Quick check-in before the clock hits twelve." },
    { emoji: "👋", title: "Oi, {n}-day streak still waiting",            body: "Spent anything today? If not, tap No spend and done." },
    { emoji: "💪", title: "{n} days strong, keep it going lah",          body: "Don't let tonight break the momentum." },
    { emoji: "⏰", title: "Almost forgot your {n}-day streak?",          body: "Quick tap now, thank yourself tomorrow morning." },
    { emoji: "🫣", title: "Your {n} days nak hilang lah",                body: "Save it now. Log a spend or tap No spend today." },
    { emoji: "👏", title: "Wah {n} days! Confirm don't want to lose this", body: "Takes two seconds to lock in today." },
    { emoji: "⚡", title: "Steady lah {n} days, one more tap",           body: "Log today's spend or hit No spend today." },
  ],
  urgent: [
    { emoji: "😱", title: "ALAMAK! {n}-day streak about to vanish!",     body: "Don't play-play lah, log today or tap No spend right now!" },
    { emoji: "🤯", title: "Woi! {n} days?! Seriously want to lose it?",  body: "One quick tap saves your {n}-day legend status." },
    { emoji: "🚨", title: "EMERGENCY: {n}-day streak on life support!",  body: "Quick check-in before midnight. No spend counts too!" },
    { emoji: "😩", title: "Aiyo! {n} days down the drain if you sleep now!", body: "Open Duitful two seconds lah, then go sleep." },
    { emoji: "🥵", title: "Your {n}-day streak is literally sweating right now", body: "Save it before midnight. Spend or No spend, both jalan!" },
    { emoji: "🆘", title: "DON'T LET {n} DAYS DIE TONIGHT!",             body: "Tap No spend today or log a spend. Cepat!" },
    { emoji: "😤", title: "Bro/Sis, {n} days is not easy to build lah!", body: "Check in now before you regret tomorrow morning." },
    { emoji: "🔥", title: "{n} days?! Takkan nak hilang streak now!",    body: "Quick tap and your {n}-day run lives another day." },
    { emoji: "⏳", title: "Last call for your {n}-day streak!",          body: "Before midnight turns it into history, tap in now." },
    { emoji: "👻", title: "Hello?! {n}-day legend, where are you?!",     body: "Two seconds to check in. Don't ghost your streak lah!" },
  ],
};
const STREAK_REMINDER_COPY = STREAK_REMINDER_TIERS.calm;

function emptyStreak() {
  return {
    enabled: true,
    reminder: true,
    noSpendDates: [],
    activityDates: [],
    freezes: [],
    best: 0,
    celebrated: [],
  };
}

function coerceStreakDates(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const raw of list) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (STREAK_ISO_RE.test(s)) seen.add(s);
  }
  return Array.from(seen).sort();
}

function coerceStreak(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const best = Number.isFinite(Number(s.best)) && Number(s.best) > 0
    ? Math.floor(Number(s.best))
    : 0;
  const celebrated = Array.isArray(s.celebrated)
    ? Array.from(new Set(
        s.celebrated
          .map((n) => Math.floor(Number(n)))
          .filter((n) => STREAK_MILESTONES.includes(n))
      )).sort((a, b) => a - b)
    : [];
  return {
    enabled: s.enabled !== false,
    reminder: s.reminder !== false,
    noSpendDates: coerceStreakDates(s.noSpendDates),
    activityDates: coerceStreakDates(s.activityDates),
    freezes: coerceStreakDates(s.freezes),
    best,
    celebrated,
  };
}

function streakTodayISO() {
  if (typeof todayISO === "function") return todayISO();
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function streakShiftDate(iso, deltaDays) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function streakWeekMonday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const offset = (dow + 6) % 7; // 0=Mon..6=Sun
  return streakShiftDate(iso, -offset);
}

/* Pure streak engine — never mutates inputs; returns computed state + any
   reconciled freezes/best so callers can persist cleanly when unlocked. */
function computeStreak(src, todayOverride) {
  const today = (typeof todayOverride === "string" && STREAK_ISO_RE.test(todayOverride))
    ? todayOverride
    : streakTodayISO();
  const st = coerceStreak(src && src.streak);

  const entryDates = new Set();
  for (const e of (src && src.dailyExpenses) || []) {
    const d = typeof e?.date === "string" ? e.date.trim() : "";
    if (STREAK_ISO_RE.test(d) && d <= today) entryDates.add(d);
  }
  const noSpendSet = new Set(st.noSpendDates.filter((d) => d <= today));
  const activitySet = new Set(st.activityDates.filter((d) => d <= today));

  const loggedSet = new Set();
  for (const d of entryDates) loggedSet.add(d);
  for (const d of noSpendSet) loggedSet.add(d);
  for (const d of activitySet) loggedSet.add(d);

  let earliestLogged = null;
  for (const d of loggedSet) {
    if (!earliestLogged || d < earliestLogged) earliestLogged = d;
  }

  let todayKind = null;
  if (entryDates.has(today) || activitySet.has(today)) todayKind = "entry";
  else if (noSpendSet.has(today)) todayKind = "no-spend";
  const checkedInToday = todayKind !== null;

  // Saved freezes that are still valid: strictly in the past, not superseded
  // by a backfilled entry, and after the user's earliest logged day.
  const allFreezes = new Set();
  for (const f of st.freezes) {
    if (f < today && !loggedSet.has(f) && earliestLogged && f >= earliestLogged) {
      allFreezes.add(f);
    }
  }

  let current = 0;
  if (earliestLogged) {
    let cursor = checkedInToday ? today : streakShiftDate(today, -1);
    let pendingGap = [];
    const monthFreezeCount = (ym) => {
      let c = 0;
      for (const f of allFreezes) if (f.slice(0, 7) === ym) c++;
      for (const g of pendingGap) if (!allFreezes.has(g) && g.slice(0, 7) === ym) c++;
      return c;
    };
    while (cursor >= earliestLogged) {
      if (loggedSet.has(cursor)) {
        for (const g of pendingGap) allFreezes.add(g);
        pendingGap = [];
        current++;
        cursor = streakShiftDate(cursor, -1);
      } else {
        const ym = cursor.slice(0, 7);
        const alreadySaved = allFreezes.has(cursor);
        // Never bridge more than STREAK_FREEZES_PER_MONTH consecutive missed
        // days (even across a month boundary) or exceed 2 freezes per month.
        if (
          pendingGap.length < STREAK_FREEZES_PER_MONTH &&
          (alreadySaved || monthFreezeCount(ym) < STREAK_FREEZES_PER_MONTH)
        ) {
          pendingGap.push(cursor);
          cursor = streakShiftDate(cursor, -1);
        } else {
          break;
        }
      }
    }
  }

  const ymNow = today.slice(0, 7);
  let freezesUsedThisMonth = 0;
  for (const f of allFreezes) {
    if (f.slice(0, 7) === ymNow) freezesUsedThisMonth++;
  }
  freezesUsedThisMonth = Math.min(STREAK_FREEZES_PER_MONTH, freezesUsedThisMonth);
  const freezesLeftThisMonth = Math.max(0, STREAK_FREEZES_PER_MONTH - freezesUsedThisMonth);

  const mon = streakWeekMonday(today);
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekDays = dayNames.map((label, i) => {
    const iso = streakShiftDate(mon, i);
    let dayState;
    if (iso > today) dayState = "future";
    else if (loggedSet.has(iso)) dayState = (noSpendSet.has(iso) && !entryDates.has(iso) && !activitySet.has(iso)) ? "no-spend" : "done";
    else if (allFreezes.has(iso)) dayState = "frozen";
    else if (iso === today) dayState = "today";
    else dayState = "missed";
    return { iso, label, state: dayState, isToday: iso === today };
  });

  const best = Math.max(st.best, current);
  return {
    enabled: st.enabled,
    reminder: st.reminder,
    today,
    current,
    best,
    checkedInToday,
    todayKind,
    hasDailyEntryToday: entryDates.has(today),
    freezes: Array.from(allFreezes).sort(),
    freezesUsedThisMonth,
    freezesLeftThisMonth,
    weekDays,
  };
}

let _streakPrevCheckedToday = null;
let _streakSparkTimer = null;

/* Record an activity check-in for today (used when logging income or a
   recurring bill on Flow / accepting captured income, which don't write a
   dailyExpenses row). */
function streakTouchToday() {
  if (typeof state === "undefined" || !state) return;
  const st = coerceStreak(state.streak);
  const today = streakTodayISO();
  if (!st.activityDates.includes(today)) {
    st.activityDates.push(today);
    st.activityDates.sort();
  }
  state.streak = st;
}

function checkInNoSpendToday() {
  if (typeof state === "undefined" || !state) return;
  const st = coerceStreak(state.streak);
  const today = streakTodayISO();
  if (!st.noSpendDates.includes(today)) {
    st.noSpendDates.push(today);
    st.noSpendDates.sort();
  }
  state.streak = st;
  if (typeof save === "function") save();
  if (typeof renderAll === "function") renderAll();
  if (typeof toast === "function") toast(tr("Checked in — no spend today."));
}

function streakArraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function renderStreakPrefs(info) {
  const prefEnabled = document.getElementById("pref-streak-enabled");
  if (prefEnabled) prefEnabled.checked = info.enabled;
  const prefReminder = document.getElementById("pref-streak-reminder");
  if (prefReminder) prefReminder.checked = info.reminder;
  const dlgReminder = document.getElementById("streak-dialog-reminder");
  if (dlgReminder) dlgReminder.checked = info.reminder;
}

function renderStreakDialog(info) {
  const dlg = document.getElementById("streak-dialog");
  if (!dlg) return;

  const hero = document.getElementById("streak-hero");
  if (hero) hero.classList.toggle("is-lit", info.checkedInToday);

  const countEl = document.getElementById("streak-dialog-count");
  if (countEl) {
    countEl.textContent = trn(info.current, "{n} day", "{n} days");
  }

  const subEl = document.getElementById("streak-dialog-sub");
  if (subEl) {
    if (info.todayKind === "no-spend") subEl.textContent = tr("Checked in today (no spend).");
    else if (info.checkedInToday) subEl.textContent = tr("Checked in today.");
    else if (info.current > 0) subEl.textContent = tr("Log an entry or tap No spend today to keep it going.");
    else subEl.textContent = tr("Log an entry or tap No spend today to start.");
  }

  const strip = document.getElementById("streak-week");
  if (strip) {
    const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
    const freezeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>';
    strip.innerHTML = info.weekDays.map((d) => {
      const stateClass = d.state === "no-spend" ? "done" : d.state;
      let glyph = "";
      let statusLabel = "";
      if (d.state === "done") { glyph = checkSvg; statusLabel = tr("Checked in"); }
      else if (d.state === "no-spend") { glyph = checkSvg; statusLabel = tr("No spend day"); }
      else if (d.state === "frozen") { glyph = freezeSvg; statusLabel = tr("Streak freeze"); }
      else if (d.state === "today") { statusLabel = tr("Today"); }
      else if (d.state === "missed") { statusLabel = tr("Missed"); }
      else { statusLabel = tr("Upcoming"); }
      const lbl = escapeHtml(tr(d.label));
      return `<div class="streak-day is-${stateClass}${d.isToday ? " is-current" : ""}" aria-label="${lbl}: ${escapeHtml(statusLabel)}">
        <span class="streak-day-dot" aria-hidden="true">${glyph}</span>
        <span class="streak-day-lbl">${lbl}</span>
      </div>`;
    }).join("");
  }

  const bestEl = document.getElementById("streak-dialog-best");
  if (bestEl) bestEl.textContent = trn(info.best, "{n} day", "{n} days");

  const freezesEl = document.getElementById("streak-dialog-freezes");
  if (freezesEl) {
    freezesEl.textContent = tr("{left} of {max} left", {
      left: info.freezesLeftThisMonth,
      max: STREAK_FREEZES_PER_MONTH,
    });
  }

  const noSpendBtn = document.getElementById("streak-dialog-nospend");
  if (noSpendBtn) noSpendBtn.hidden = info.checkedInToday;
}

function renderStreak() {
  if (typeof state === "undefined" || !state) return;
  const info = computeStreak(state);

  // Sync reconciled freezes & best back to vault state without noisy saves.
  if (typeof aesKey !== "undefined" && aesKey) {
    const cur = coerceStreak(state.streak);
    const changed = cur.best !== info.best || !streakArraysEqual(cur.freezes, info.freezes);
    if (changed) {
      cur.best = info.best;
      cur.freezes = info.freezes;
      state.streak = cur;
      if (typeof save === "function") save();
    }
  }

  renderStreakPrefs(info);

  const pill = document.getElementById("streak-pill");
  const countEl = document.getElementById("streak-pill-count");
  const noSpendRow = document.getElementById("today-nospend-row");
  const noSpendDone = document.getElementById("today-nospend-done");
  const todayEmpty = document.getElementById("today-empty");

  const hydrated = typeof _isHydrated !== "undefined" && _isHydrated;
  const justCheckedIn = hydrated && _streakPrevCheckedToday === false && info.checkedInToday;
  _streakPrevCheckedToday = info.checkedInToday;

  if (pill) {
    pill.hidden = !info.enabled;
    pill.classList.toggle("is-lit", info.checkedInToday);
    if (countEl) {
      countEl.textContent = tr("{n}d", { n: info.current });
    }
    pill.setAttribute(
      "aria-label",
      info.checkedInToday
        ? tr("Daily check-in streak: {n} days, checked in today", { n: info.current })
        : tr("Daily check-in streak: {n} days", { n: info.current })
    );
    if (justCheckedIn && info.enabled) {
      pill.classList.remove("is-spark");
      void pill.offsetWidth;
      pill.classList.add("is-spark");
      if (_streakSparkTimer) clearTimeout(_streakSparkTimer);
      _streakSparkTimer = setTimeout(() => {
        pill.classList.remove("is-spark");
        _streakSparkTimer = null;
      }, 650);
    }
  }

  // Home → Today card: one-tap "No spend today" only when streaks are enabled
  // and nothing has been checked in yet today.
  if (noSpendRow) {
    noSpendRow.hidden = !info.enabled || info.checkedInToday || info.hasDailyEntryToday;
  }
  const showNoSpendDone = info.enabled && info.todayKind === "no-spend" && !info.hasDailyEntryToday;
  if (noSpendDone) {
    noSpendDone.hidden = !showNoSpendDone;
    noSpendDone.textContent = showNoSpendDone ? tr("No spend day logged.") : "";
  }
  if (todayEmpty && showNoSpendDone) todayEmpty.hidden = true;

  renderStreakDialog(info);
}

function openStreakDialog() {
  if (typeof state === "undefined" || !state) return;
  const info = computeStreak(state);
  renderStreakDialog(info);
  const dlg = document.getElementById("streak-dialog");
  if (dlg && typeof dlg.showModal === "function" && !dlg.open) dlg.showModal();
}

function streakReminderTier(streakCount) {
  const n = Math.max(0, Math.floor(Number(streakCount) || 0));
  if (n >= 30) return "urgent";
  if (n >= 7) return "warm";
  return "calm";
}

function streakReminderForDate(dt, streakCount = 0) {
  const n = Math.max(0, Math.floor(Number(streakCount) || 0));
  const tier = streakReminderTier(n);
  const list = STREAK_REMINDER_TIERS[tier];
  const dayNum = Math.floor(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) / 86400000);
  const idx = ((dayNum % list.length) + list.length) % list.length;
  const msg = list[idx];
  const fmt = (s) => (typeof tr === "function" ? tr(s, { n }) : s.replace(/\{n\}/g, String(n)));
  return {
    tier,
    title: msg.emoji ? `${msg.emoji} ${fmt(msg.title)}` : fmt(msg.title),
    body: fmt(msg.body),
  };
}

/* Evening check-in reminder (8:30pm). On by default (toggleable off in
   Settings or the streak sheet), escalates in Malaysian style as your streak
   grows (0–6d calm, 7–29d playful, 30+d urgent), never shows money amounts,
   and skips today if today is already checked in. */
function streakNativeReminders(src, nowOverride) {
  const s = src || (typeof state !== "undefined" ? state : null);
  if (!s) return [];
  const info = computeStreak(s);
  if (!info.enabled || !info.reminder) return [];

  const now = nowOverride instanceof Date ? nowOverride : new Date();
  const out = [];
  const makeEvening = (dayOffset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 20, 30, 0, 0);

  if (!info.checkedInToday) {
    const tonight = makeEvening(0);
    if (tonight.getTime() > now.getTime() + 60_000) {
      const msg = streakReminderForDate(tonight, info.current);
      out.push({ title: msg.title, body: msg.body, at: tonight });
    }
  }
  const tomorrow = makeEvening(1);
  const nextMsg = streakReminderForDate(tomorrow, info.current);
  out.push({ title: nextMsg.title, body: nextMsg.body, at: tomorrow });
  return out;
}

function setStreakEnabled(enabled) {
  if (typeof state === "undefined" || !state) return;
  const st = coerceStreak(state.streak);
  st.enabled = !!enabled;
  state.streak = st;
  if (typeof save === "function") save();
  if (typeof renderAll === "function") renderAll();
  if (typeof scheduleNativeReminders === "function") scheduleNativeReminders();
}

function setStreakReminder(enabled) {
  if (typeof state === "undefined" || !state) return;
  const st = coerceStreak(state.streak);
  st.reminder = !!enabled;
  state.streak = st;
  if (typeof save === "function") save();
  renderStreak();
  if (typeof scheduleNativeReminders === "function") scheduleNativeReminders();
}

function bindStreakControls() {
  document.getElementById("streak-pill")?.addEventListener("click", openStreakDialog);
  document.getElementById("btn-no-spend-today")?.addEventListener("click", checkInNoSpendToday);
  document.getElementById("streak-dialog-nospend")?.addEventListener("click", checkInNoSpendToday);
  document.getElementById("pref-streak-enabled")?.addEventListener("change", (e) => {
    setStreakEnabled(!!e.target.checked);
  });
  document.getElementById("pref-streak-reminder")?.addEventListener("change", (e) => {
    setStreakReminder(!!e.target.checked);
  });
  document.getElementById("streak-dialog-reminder")?.addEventListener("change", (e) => {
    setStreakReminder(!!e.target.checked);
  });
}

bindStreakControls();
