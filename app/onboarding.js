/* ---------- first-time welcome tour ---------- */

function isStandalonePWA() {
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true
  );
}

function detectInstallPlatform() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isChrome = /Chrome|CriOS/.test(ua) && !/Edg|OPR|Firefox/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|OPR|Firefox/.test(ua);
  if (isIOS && isSafari) return "ios-safari";
  if (isIOS && isChrome) return "ios-chrome";
  if (isIOS) return "ios-other";
  if (isAndroid) return "android";
  return "desktop";
}

function installInstructionsBody() {
  if (isStandalonePWA()) {
    return `<p>${tr("You're already using Duitful as an installed app — nice.")}</p>
      <p class="hint">${tr("Everything works offline from here on. Tap Next to continue the tour.")}</p>`;
  }
  const platform = detectInstallPlatform();
  const shareIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline-ico"><path d="M12 16V4M8 8l4-4 4 4"/><rect x="4" y="10" width="16" height="11" rx="2"/></svg>`;
  const menuIcon = `<svg viewBox="0 0 24 24" fill="currentColor" class="inline-ico"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`;
  const plusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="inline-ico"><path d="M12 5v14M5 12h14"/></svg>`;

  if (platform === "ios-safari") {
    return `<p>${tr("Install Duitful on your home screen — it opens fullscreen, runs offline, and feels like a native app.")}</p>
      <ol class="guide-steps">
        <li>${tr("Tap the <strong>Share</strong> button {icon} at the bottom of Safari.", { icon: shareIcon })}</li>
        <li>${tr("Scroll down and tap <strong>Add to Home Screen</strong>.")}</li>
        <li>${tr("Tap <strong>Add</strong> in the top-right.")}</li>
      </ol>
      <p class="hint">${tr("The Duitful wallet icon will appear on your home screen. Tap it to open.")}</p>`;
  }
  if (platform === "ios-chrome" || platform === "ios-other") {
    return `<p>${tr("iPhone installs need Safari. Open Duitful in Safari first, then follow the steps below.")}</p>
      <ol class="guide-steps">
        <li>${tr("Copy this URL: <strong>duitful.app</strong>")}</li>
        <li>${tr("Open <strong>Safari</strong> and paste the URL.")}</li>
        <li>${tr("Tap the <strong>Share</strong> button {icon} → <strong>Add to Home Screen</strong> → <strong>Add</strong>.", { icon: shareIcon })}</li>
      </ol>
      <p class="hint">${tr("iOS only lets Safari install web apps — other browsers can't.")}</p>`;
  }
  if (platform === "android") {
    return `<p>${tr("Install Duitful on your home screen — it opens fullscreen, runs offline, and feels like a native app.")}</p>
      <ol class="guide-steps">
        <li>${tr("Tap the <strong>menu</strong> {icon} in the top-right of Chrome.", { icon: menuIcon })}</li>
        <li>${tr("Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).")}</li>
        <li>${tr("Tap <strong>Install</strong> to confirm.")}</li>
      </ol>
      <p class="hint">${tr("If you see an <strong>Install</strong> button in the address bar, you can tap that directly.")}</p>`;
  }
  return `<p>${tr("Install Duitful as a desktop app — runs in its own window, works offline.")}</p>
    <ol class="guide-steps">
      <li>${tr("Look for the <strong>install</strong> icon {icon} in the address bar.", { icon: plusIcon })}</li>
      <li>${tr("Click <strong>Install</strong>.")}</li>
    </ol>
    <p class="hint">${tr("Not seeing it? Use the browser menu → <strong>Install Duitful</strong> / <strong>Apps → Install this site</strong>.")}</p>`;
}

const GUIDE_STEPS = [
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    title: "Welcome to Duitful",
    sub: "A quick tour so you know where everything lives.",
    body: `<p>Duitful is a private money &amp; debt tracker. Everything stays on this device, encrypted with your passcode — there's no account and no server.</p>
      <p>This tour takes about a minute. You'll learn the difference between income, recurring bills, debts, and daily spending — then you're set.</p>`,
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h16M4 19h10"/></svg>`,
    title: "How Duitful sees your money",
    sub: "Five buckets. Each one has its own tab.",
    body: `<p>Everything you track falls into one of these:</p>
      <ul>
        <li><strong>Income</strong> — money coming in. <em>Salary</em> (every month) or a <em>bonus</em> (one-off).</li>
        <li><strong>Recurring bills</strong> — fixed monthly costs that repeat. <em>Netflix, rent, internet.</em></li>
        <li><strong>Debts</strong> — money you owe that pays down and <em>ends</em>. <em>Car loan, PTPTN, credit card.</em></li>
        <li><strong>Daily spending</strong> — variable day-to-day. <em>Mamak, Grab, groceries.</em></li>
        <li><strong>Savings</strong> — goals you put money toward. <em>Emergency fund, Umrah.</em></li>
      </ul>
      <p>The key difference: a <strong>bill repeats forever</strong> (Netflix), a <strong>debt has an end</strong> (the car loan finishes once it's paid).</p>`,
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
    title: "Add your income",
    sub: "Salary repeats; a bonus doesn't.",
    body: `<p>Enter what comes in each month. The <strong>Repeat next month</strong> tick decides the type:</p>
      <ul>
        <li><strong>Salary</strong> → leave <em>Repeat next month</em> ticked, so it carries forward automatically.</li>
        <li><strong>Bonus / gift</strong> → untick it — it only counts this month.</li>
      </ul>`,
    tab: "flow",
    target: "#form-income",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-4h16l1 4M4 9h16v10a1 1 0 01-1 1H5a1 1 0 01-1-1V9zM9 13h6"/></svg>`,
    title: "Add recurring bills",
    sub: "The fixed costs that come every month.",
    body: `<p>Rent, internet, phone, Netflix, insurance — anything with a fixed monthly amount.</p>
      <p>Keep <strong>Repeat next month</strong> ticked so they reappear automatically. These never \"end\" — that's what makes them a bill and not a debt.</p>`,
    tab: "flow",
    target: "#form-expense",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/></svg>`,
    title: "Add your debts",
    sub: "A debt has a balance — and an end.",
    body: `<p>Unlike a bill, a debt has a <strong>balance that shrinks</strong> as you pay it down. Car loan, PTPTN, credit card, BNPL.</p>
      <ul>
        <li><strong>Standard</strong> — credit cards, personal/car loans (balance + APR + minimum).</li>
        <li><strong>Installment</strong> — Atome, SPayLater (fixed monthly, set number of months).</li>
      </ul>
      <p>Duitful pays the <strong>highest-APR debt first</strong> (the avalanche method) and shows your debt-free date.</p>`,
    tab: "debts",
    target: "#form-debt",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a2 2 0 01-2 2h-4v-6H9v6H5a2 2 0 01-2-2v-9z"/></svg>`,
    title: "Log daily spending",
    sub: "Spend, pay a debt, or save — in one tap.",
    body: `<p>This is your day-to-day: mamak, Grab, groceries. Pick the type, type the amount, hit Save.</p>
      <ul>
        <li><strong>Spend</strong> — a normal expense (food, transport, shopping).</li>
        <li><strong>Pay debt</strong> — a payment toward a debt you added.</li>
        <li><strong>Save</strong> — a deposit into a savings goal.</li>
      </ul>`,
    tab: "dashboard",
    target: ".quick-add .type-pills",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 011-1h3l1.5-2h5L16 4h3a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V7z"/><circle cx="12" cy="13" r="4"/></svg>`,
    title: "Scan a receipt",
    sub: "Snap it, we read the amount.",
    body: () => `<p>Tap <strong>Scan receipt</strong> to take a photo (or pick one from your gallery). Duitful reads the total on-device — the image never leaves your phone.</p>
      <p>Free includes 5 scans a month; Pro scans without a limit, and so does the optional ${TRIAL_DAYS}-day trial.</p>`,
    tab: "dashboard",
    target: "#btn-scan",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`,
    title: "Set a savings goal",
    sub: "Emergency fund, Umrah, a new phone.",
    body: `<p>Set a target, then log deposits from Home with <strong>Save</strong>.</p>`,
    tab: "savings",
    target: "#form-saving",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a2 2 0 01-2 2h-4v-6H9v6H5a2 2 0 01-2-2v-9z"/></svg>`,
    title: "Your balance at a glance",
    sub: "Back on Home — the number that matters.",
    body: `<p>The hero card shows <strong>balance left this month</strong>: income minus recurring bills, minimum debt payments, and daily spending.</p>
      <p>Below it, the per-day line tells you roughly how much you can spend to stay on track.</p>`,
    tab: "dashboard",
    target: ".hero-card",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14M5 10l7 7 7-7M4 21h16"/></svg>`,
    title: "Settings — you own the data",
    sub: "Theme, backup, reminders, passcode.",
    body: `<p>Here you can switch <strong>Light / Dark</strong> theme, export a CSV backup, set reminders, change your passcode, and manage Pro.</p>
      <p>Everything is encrypted on this device only. <strong>Losing your passcode means losing the data</strong>, so export a CSV somewhere safe.</p>`,
    tab: "data",
    target: "#btn-export",
  },
];

let guideStep = 0;
// Set while renderGuideStep / closeGuide are programmatically closing
// the <dialog> so the listener below doesn't treat that as a user
// dismiss. Without this, transitioning from a modal step into a
// spotlight step would end the whole tour the moment we closed the
// dialog (because dialog.close() fires "close" unconditionally).
let _guideInternalClose = false;
// Was a first-run lockout: the tour auto-opened after passcode setup with
// Skip hidden and Esc disabled, so a new user had to click through all ten
// steps. That is gone — the tour no longer auto-opens at all, and is always
// escapable. The flag is kept because openGuide() takes it, but nothing
// sets it true any more.
let guideFirstRun = false;

function guideDialog() { return document.getElementById("guide-dialog"); }
// A tour step's HTML, whitespace collapsed, is its key.
function guideTr(html) { return html ? tr(String(html).replace(/\s+/g, " ").trim()) : ""; }

function renderGuideStep() {
  const step = GUIDE_STEPS[guideStep];
  if (!step) return;

  // Make sure the right tab is active before measuring spotlight targets.
  if (step.tab) {
    const tabBtn = document.querySelector(`.tab[data-tab="${step.tab}"]`);
    if (tabBtn) tabBtn.click();
  }

  // Resolve target if the step asked for one. Multiple selectors fall
  // back in order, so a step like ['#btn-scan', '.scan-row'] still
  // works if the primary id ever gets renamed.
  let targetEl = null;
  if (step.target) {
    const list = Array.isArray(step.target) ? step.target : [step.target];
    // Add forms start closed; the tour opens the one it's about to point at.
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el && el.classList.contains("add-form")) openAddForm(el, { focus: false });
    }
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { targetEl = el; break; }
    }
  }

  if (targetEl) {
    // Step is a spotlight one. Close the modal dialog if it was open
    // (entering spotlight mode), then position the spotlight after a
    // short layout-settle delay. _guideInternalClose tells the dialog's
    // "close" listener that this isn't a user dismiss — without it,
    // closing the dialog to switch into spotlight mode would end the
    // whole tour immediately.
    const dlg = guideDialog();
    if (dlg && dlg.open) {
      guideCloseDialogInternally(dlg);
    }
    showGuideSpotlight(targetEl, step);
  } else {
    // Step is a dialog one (intro / outro). Hide spotlight, render the
    // dialog with the same data the spotlight tooltip would have used,
    // and show it.
    hideGuideSpotlight();
    const mark = document.getElementById("guide-mark");
    const title = document.getElementById("guide-title");
    const sub = document.getElementById("guide-sub");
    const body = document.getElementById("guide-body");
    const dots = document.getElementById("guide-dots");
    const prev = document.getElementById("guide-prev");
    const next = document.getElementById("guide-next");
    const skip = document.getElementById("guide-skip");
    const lastStep = guideStep === GUIDE_STEPS.length - 1;
    // Kira in the mark (kira.js): happy, and party with a burst on the last step.
    if (mark && typeof kiraSvg === "function") {
      mark.classList.add("has-kira");
      if (lastStep && typeof kiraCelebrate === "function") kiraCelebrate(mark);
      else { mark.dataset.mood = "happy"; mark.innerHTML = kiraSvg("happy", { moment: true }); }
    } else if (mark) mark.innerHTML = step.icon;
    if (title) title.innerHTML = guideTr(step.title);
    if (sub) sub.textContent = guideTr(step.sub || "");
    if (body) body.innerHTML = step.install ? installInstructionsBody() : guideTr(typeof step.body === "function" ? step.body() : step.body);
    if (dots) {
      dots.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="${i === guideStep ? "active" : ""}" role="tab" aria-selected="${i === guideStep ? "true" : "false"}"></span>`).join("");
    }
    const isLast = guideStep === GUIDE_STEPS.length - 1;
    if (prev) prev.hidden = guideStep === 0;
    if (next) next.textContent = isLast ? tr("Got it") : tr("Next");
    if (skip) skip.hidden = isLast || guideFirstRun;
    const dlg = guideDialog();
    if (dlg && !dlg.open) {
      try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }
    }
  }
}

/* ---------- Spotlight overlay (guided tour mode) ---------- */
let _spotlightTargetEl = null;
let _spotlightStep = null;
let _spotlightRaf = null;

function showGuideSpotlight(targetEl, step) {
  const root = document.getElementById("guide-spotlight");
  if (!root) return;
  _spotlightTargetEl = targetEl;
  _spotlightStep = step;
  // Render content first so we can measure tooltip dimensions correctly.
  const title = document.getElementById("guide-tooltip-title");
  const body = document.getElementById("guide-tooltip-body");
  const dots = document.getElementById("guide-spot-dots");
  if (title) title.innerHTML = guideTr(step.title || "");
  if (body) body.innerHTML = guideTr((typeof step.body === "function" ? step.body() : step.body) || "");
  if (dots) {
    dots.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="${i === guideStep ? "active" : ""}"></span>`).join("");
  }
  // A tiny Kira peeks over the tooltip's edge (positionGuideSpotlight points
  // her eyes at the highlighted element): happy, and party with a burst on
  // the tour's last step.
  const peek = document.getElementById("guide-tooltip-kira");
  const peekMood = guideStep === GUIDE_STEPS.length - 1 ? "party" : "happy";
  if (peek && peek.dataset.mood !== peekMood && typeof kiraSvg === "function") {
    peek.dataset.mood = peekMood;
    peek.innerHTML = kiraSvg(peekMood, { moment: peekMood === "party" });
    if (peekMood === "party" && typeof kiraBurst === "function") kiraBurst(document.getElementById("guide-tooltip"));
  }
  // Skip/Back/Next labels mirror the dialog logic.
  const isLast = guideStep === GUIDE_STEPS.length - 1;
  const nextBtn = root.querySelector(".guide-action-next");
  const prevBtn = root.querySelector(".guide-action-prev");
  const skipBtn = root.querySelector(".guide-action-skip");
  if (nextBtn) nextBtn.textContent = isLast ? tr("Got it") : tr("Next");
  if (prevBtn) prevBtn.hidden = guideStep === 0;
  if (skipBtn) skipBtn.hidden = isLast || guideFirstRun;
  root.hidden = false;
  root.classList.remove("is-ready");
  // Scroll target into view if it's off-screen, then position next frame
  // so the scroll has actually applied. The 'is-ready' class fades the
  // tooltip in once layout is settled.
  scrollTargetIntoView(targetEl);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    positionGuideSpotlight();
    root.classList.add("is-ready");
  }));
  // Re-position on resize and on scroll (the target rect moves with
  // scroll because we use viewport-relative getBoundingClientRect).
  window.addEventListener("resize", scheduleSpotlightReposition, { passive: true });
  window.addEventListener("scroll", scheduleSpotlightReposition, { passive: true });
}

function hideGuideSpotlight() {
  const root = document.getElementById("guide-spotlight");
  if (root) { root.hidden = true; root.classList.remove("is-ready"); }
  _spotlightTargetEl = null;
  _spotlightStep = null;
  window.removeEventListener("resize", scheduleSpotlightReposition);
  window.removeEventListener("scroll", scheduleSpotlightReposition);
  if (_spotlightRaf != null) { cancelAnimationFrame(_spotlightRaf); _spotlightRaf = null; }
}

function scheduleSpotlightReposition() {
  if (_spotlightRaf != null) return;
  _spotlightRaf = requestAnimationFrame(() => { _spotlightRaf = null; positionGuideSpotlight(); });
}

function scrollTargetIntoView(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  // If the target is more than half off-screen, scroll its container so
  // it sits in the upper third of the viewport (leaves room for the
  // tooltip to sit comfortably below).
  if (r.top < 0 || r.bottom > vh - 160) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function positionGuideSpotlight() {
  if (!_spotlightTargetEl) return;
  const root = document.getElementById("guide-spotlight");
  const tooltip = document.getElementById("guide-tooltip");
  const ring = document.getElementById("guide-spot-ring");
  if (!root || !tooltip || !ring) return;
  const r = _spotlightTargetEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PAD = 6;
  const x1 = Math.max(0, r.left - PAD);
  const y1 = Math.max(0, r.top - PAD);
  const x2 = Math.min(vw, r.right + PAD);
  const y2 = Math.min(vh, r.bottom + PAD);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  // Four dim rectangles framing the cutout.
  const top = root.querySelector(".guide-spot-dim-top");
  const right = root.querySelector(".guide-spot-dim-right");
  const bottom = root.querySelector(".guide-spot-dim-bottom");
  const left = root.querySelector(".guide-spot-dim-left");
  if (top) { top.style.cssText = `top:0;left:0;width:100%;height:${y1}px;`; }
  if (right) { right.style.cssText = `top:${y1}px;left:${x2}px;width:${Math.max(0, vw - x2)}px;height:${h}px;`; }
  if (bottom) { bottom.style.cssText = `top:${y2}px;left:0;width:100%;height:${Math.max(0, vh - y2)}px;`; }
  if (left) { left.style.cssText = `top:${y1}px;left:0;width:${x1}px;height:${h}px;`; }
  // Pulsing ring on top of the cutout.
  ring.style.cssText = `top:${y1}px;left:${x1}px;width:${w}px;height:${h}px;`;
  // Tooltip placement: below the target if there's room, otherwise above.
  const ttRect = tooltip.getBoundingClientRect();
  const ttW = ttRect.width || 320;
  const ttH = ttRect.height || 200;
  const margin = 14;
  const below = y2 + margin + ttH + 12 <= vh;
  const placeY = below ? y2 + margin : Math.max(12, y1 - margin - ttH);
  // Centre tooltip horizontally on the target, clamp to viewport edges.
  let placeX = r.left + r.width / 2 - ttW / 2;
  placeX = Math.max(12, Math.min(vw - ttW - 12, placeX));
  tooltip.style.top = `${placeY}px`;
  tooltip.style.left = `${placeX}px`;
  tooltip.classList.toggle("arrow-top", !below);
  tooltip.classList.toggle("arrow-bottom", below);
  // Arrow horizontal offset (points at the centre of the target).
  const arrow = document.getElementById("guide-tooltip-arrow");
  if (arrow) {
    const arrowX = Math.max(14, Math.min(ttW - 14, r.left + r.width / 2 - placeX));
    arrow.style.left = `${arrowX - 6}px`;
    // Kira peeks from the corner away from the arrow and looks at the ring.
    tooltip.classList.toggle("kira-peek-left", arrowX > ttW / 2);
  }
  // Kira peeks over the top edge only when that edge faces away from the
  // highlighted element (the tooltip sits above it) and there is room on
  // screen; otherwise she sits inside the tooltip's top corner, never over
  // the element being explained.
  tooltip.classList.toggle("kira-peek-inside", below || placeY < 32);
  guideKiraLook(r.left + r.width / 2, r.top + r.height / 2);
}

// The tooltip glides to its new place (0.32s), so look again once it lands.
let _guideKiraLookTimer = null;
function guideKiraLook(x, y) {
  const svg = document.querySelector("#guide-tooltip-kira svg.kira");
  if (!svg || typeof kiraLookAt !== "function") return;
  kiraLookAt(svg, x, y, true);
  clearTimeout(_guideKiraLookTimer);
  _guideKiraLookTimer = setTimeout(() => {
    if (_spotlightTargetEl && svg.isConnected) kiraLookAt(svg, x, y, true);
  }, 380);
}

function openGuide(opts) {
  guideFirstRun = !!(opts && opts.firstRun);
  guideStep = 0;
  // renderGuideStep dispatches between dialog and spotlight based on
  // whether the step has a `target` selector. Don't show the dialog
  // pre-emptively here, or the first spotlight step will flash a modal.
  renderGuideStep();
}

// Closes the welcome dialog WITHOUT ending the tour. dialog.close()
// queues its "close" event asynchronously (it's a queued element task,
// not a synchronous dispatch), so we set the guard flag and leave it
// set — the "close" listener resets it whenever the event fires. We
// guard on dlg.open so close() always dispatches exactly one event;
// the only path where no event fires is the ancient-browser catch
// fallback, which resets the flag inline. No timer — a setTimeout
// reset would race the queued close event (different task sources have
// no ordering guarantee) and could clear the flag first, re-breaking
// the guard.
function guideCloseDialogInternally(dlg) {
  if (!dlg || !dlg.open) return;
  _guideInternalClose = true;
  try {
    dlg.close();
  } catch {
    dlg.removeAttribute("open");
    _guideInternalClose = false;
  }
}

function closeGuide() {
  const dlg = guideDialog();
  if (dlg && dlg.open) guideCloseDialogInternally(dlg);
  hideGuideSpotlight();
}

function finishGuide() {
  // Same reasoning as closeOnboard(): the flag is free, only the write costs.
  if (!state.guideSeen) {
    state.guideSeen = true;
    if (aesKey) save();
  }
  guideFirstRun = false;
  closeGuide();
}

/* ---------- Day-3 reminders ask (phone app) ----------

   Android's permission prompt used to fire the instant a passcode was
   created, over the first-run setup, with no reason given. People say no to
   that, and on Android a second no is permanent. Now nothing asks on day
   one. On day 3, when there's something worth reminding about, a card on
   Home says what a reminder here is and asks; only a yes reaches the OS
   prompt. A yes then asks for due dates, because first-run records have
   none and a reminder with no date never fires. */

const REMINDER_ASK_AFTER_DAYS = 2; // calendar days after setup: day 3
let reminderAskPhase = "offer";    // offer | dates | blocked | closed
let reminderAskGranted = null;     // cached OS answer; null until checked

function reminderAskDue() {
  return isNative()
    && !!state
    && !state.reminderAskDone
    && !!state.firstRunAt
    && calendarDaysSince(state.firstRunAt) >= REMINDER_ASK_AFTER_DAYS
    && state.reminders?.enabled !== false
    && (state.debts.length > 0 || state.expenses.length > 0);
}

// Things that could remind but can't yet: no due day recorded. This month's
// bills only — older months' rows are history, not upcoming.
function reminderAskUndated() {
  const m = currentMonthISO();
  const rows = [];
  for (const d of state.debts) {
    if (!d.dueDay && (Number(d.balance) || 0) > 0) rows.push({ kind: "debt", id: d.id, name: d.name });
  }
  for (const e of state.expenses) {
    if (e.month === m && !e.day) rows.push({ kind: "expense", id: e.id, name: e.name });
  }
  return rows.slice(0, 6);
}

async function nativeNotificationsGranted() {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN || typeof LN.checkPermissions !== "function") return false;
  try { return (await LN.checkPermissions()).display === "granted"; } catch { return false; }
}

function reminderAskFinish() {
  reminderAskPhase = "closed";
  if (!state.reminderAskDone) { state.reminderAskDone = true; save(); }
  renderReminderAsk();
  renderTrialBanner();
}

function renderReminderAsk() {
  const card = document.getElementById("reminder-ask");
  if (!card) return;
  if (reminderAskPhase === "closed" || (reminderAskPhase === "offer" && !reminderAskDue())) {
    card.hidden = true;
    return;
  }
  if (reminderAskPhase === "offer" && reminderAskGranted === null) {
    // Someone who already allowed notifications (an older install, or via
    // Settings) has nothing to be asked. Check once, then render for real.
    card.hidden = true;
    nativeNotificationsGranted().then((granted) => {
      reminderAskGranted = granted;
      if (granted) reminderAskFinish();
      else renderReminderAsk();
    });
    return;
  }
  card.hidden = false;
  const trial = document.getElementById("trial-banner");
  if (trial) trial.hidden = true;
  document.getElementById("reminder-ask-offer").hidden = reminderAskPhase !== "offer";
  document.getElementById("reminder-ask-dates").hidden = reminderAskPhase !== "dates";
  document.getElementById("reminder-ask-blocked").hidden = reminderAskPhase !== "blocked";
  const title = document.getElementById("reminder-ask-title");
  if (title) {
    title.textContent = tr(reminderAskPhase === "dates"
      ? "Reminders are on. When is each one due?"
      : reminderAskPhase === "blocked"
        ? "Reminders can't reach you yet"
        : "Want a nudge on the day payments are due?");
  }
}

function reminderAskShowDates(rows) {
  const host = document.getElementById("reminder-ask-rows");
  if (!host) return;
  host.innerHTML = rows.map((r, i) => `
    <label class="reminder-ask-row">
      <span class="reminder-ask-name">${escapeHtml(r.name)}</span>
      <input type="number" min="1" max="31" step="1" inputmode="numeric" placeholder="${tr("Day")}"
        data-kind="${r.kind}" data-id="${escapeHtml(r.id)}" aria-label="${tr("Day of the month {name} is due", { name: escapeHtml(r.name) })}" />
    </label>`).join("");
  reminderAskPhase = "dates";
  renderReminderAsk();
  setTimeout(() => host.querySelector("input")?.focus(), 60);
}

document.getElementById("reminder-ask-yes")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const ok = await scheduleNativeReminders({ ask: true });
  btn.disabled = false;
  reminderAskGranted = ok;
  if (!ok) {
    reminderAskPhase = "blocked";
    state.reminderAskDone = true;
    save();
    renderReminderAsk();
    renderReminderPrefs();
    return;
  }
  renderReminderPrefs();
  const rows = reminderAskUndated();
  if (!rows.length) {
    reminderAskFinish();
    toast(tr("Reminders are on — 9am on each due date."));
    return;
  }
  reminderAskShowDates(rows);
});

document.getElementById("reminder-ask-no")?.addEventListener("click", () => {
  reminderAskFinish();
  toast(tr("No reminders. You can turn them on in Settings → Reminders."));
});
document.getElementById("reminder-ask-later")?.addEventListener("click", reminderAskFinish);
document.getElementById("reminder-ask-ok")?.addEventListener("click", reminderAskFinish);

document.getElementById("reminder-ask-dates")?.addEventListener("submit", (e) => {
  e.preventDefault();
  let set = 0;
  e.currentTarget.querySelectorAll("input[data-id]").forEach((input) => {
    const day = Math.round(Number(input.value));
    if (!Number.isFinite(day) || day < 1 || day > 31) return;
    const list = input.dataset.kind === "debt" ? state.debts : state.expenses;
    const row = list.find((x) => x.id === input.dataset.id);
    if (!row) return;
    if (input.dataset.kind === "debt") row.dueDay = day;
    else row.day = day;
    set += 1;
  });
  reminderAskFinish(); // saves, which reschedules with the new dates
  renderAll();
  toast(set
    ? trn(set, "{n} reminder set — 9am on the day.", "{n} reminders set — 9am on the day.")
    : tr("Reminders are on. Add a due day to a bill or debt any time."));
});

/* ---------- First run: three questions, then the answer ----------

   What used to happen here: a ten-step tour, auto-opened, with the Skip
   button hidden — a brand-new user had to click through every screen,
   including a Pro feature and a warning that losing their passcode destroys
   their data, before they had entered a single ringgit. Nine of ten people
   who installed the app never opened it twice.

   A tour explains features to someone who has not yet decided they care.
   This asks what comes in, what's already spoken for, and what's owed, and
   hands back the one number they came for. For someone carrying debt that is
   the month they're debt-free — the reason the app exists — with what's left
   to spend underneath. With no debts it is what's left this month. Split,
   investments, zakat and receipt scanning are still there, just not in
   anyone's face on day one.

   Always skippable, and "I don't owe anything" is one tap. The full tour is
   unchanged and still available on demand from Settings → About. */

let onboardBillRows = 1;
let onboardDebtRows = 0;
const ONBOARD_DEBT_MAX = 5;

// Two numbers per debt instead of the Debts tab's seven. Everything else
// comes from the type, modelled the way the contract actually works:
//   - cards, personal loans and PTPTN are balances that accrue on what's left,
//     at the same typical rates the Debts form's "Not sure of your rate?"
//     picker offers (card at the 18% cap, so the first date is never rosier
//     than the truth);
//   - BNPL and car hire purchase are fixed instalments with the charge already
//     inside them (BNPL is 0%; Malaysian HP interest is flat and baked into
//     the instalment), so what's left to pay is simply instalments × months.
const ONBOARD_DEBTS = {
  card:     { name: "Credit card",   kind: "standard",    apr: 18,  owe: "Statement balance", note: "18% assumed" },
  bnpl:     { name: "BNPL",          kind: "installment", apr: 0,   owe: "Left to pay",       note: "0% instalments" },
  ptptn:    { name: "PTPTN",         kind: "standard",    apr: 1,   owe: "Still owe",         note: "1% ujrah assumed" },
  car:      { name: "Car loan",      kind: "installment", apr: 0,   owe: "Left to pay",       note: "Fixed instalments" },
  personal: { name: "Personal loan", kind: "standard",    apr: 10,  owe: "Still owe",         note: "10% assumed" },
};

function onboardDialog() { return document.getElementById("onboard-dialog"); }

function onboardShowStep(n) {
  document.querySelectorAll("#onboard-dialog .onboard-step").forEach((el) => {
    el.hidden = Number(el.dataset.onboardStep) !== n;
  });
  document.querySelectorAll("#onboard-dialog .onboard-tick").forEach((el, i) => {
    el.classList.toggle("is-on", i < n);
  });
  if (n === 1) setTimeout(() => document.getElementById("onboard-income")?.focus(), 60);
  if (n === 3) onboardSyncDebtStep();
  onboardKira(n);
}

/* Kira beside each question (kira.js): waving hello on what comes in, proud
   on the bills, happy on what's owed — owing money is never a worried face.
   The answer gets party Kira and a burst when there's a debt-free month,
   proud otherwise. Drawn as each step shows, so each moment plays once. */
function onboardKira(n) {
  if (typeof kiraSvg !== "function") return;
  const slot = document.querySelector(`#onboard-dialog [data-onboard-step="${n}"] .onboard-kira`);
  if (!slot) return;
  if (n === 4) {
    const free = document.getElementById("onboard-free");
    const party = !!free && !free.hidden && !free.classList.contains("is-stuck");
    if (party && typeof kiraCelebrate === "function") { kiraCelebrate(slot); return; }
    slot.dataset.mood = "proud";
    slot.innerHTML = kiraSvg("proud", { moment: true });
    return;
  }
  const mood = n === 2 ? "proud" : "happy";
  slot.dataset.mood = mood;
  slot.innerHTML = kiraSvg(mood, { moment: true, wave: n === 1 });
}

function onboardAddBillRow(focus) {
  const wrap = document.getElementById("onboard-bill-rows");
  if (!wrap) return;
  const i = onboardBillRows++;
  const row = document.createElement("div");
  row.className = "onboard-row";
  // aria-label rather than a visible one: these are repeating rows in a
  // two-column layout where a printed label above each field would treble the
  // height. The placeholder is an example ("Rent, Astro…"), not the field's
  // name, and it disappears the moment anything is typed — so on its own it
  // leaves the field anonymous to a screen reader and to anyone who looks
  // away mid-entry.
  row.innerHTML = `
    <input type="text" class="onboard-bill-name" aria-label="${escapeHtml(tr("Bill name"))}" placeholder="${escapeHtml(tr("Rent, Astro, TNB…"))}" autocomplete="off" />
    <label class="onboard-field onboard-field-sm">
      <span class="onboard-cur">RM</span>
      <input type="number" class="onboard-bill-amount" aria-label="${escapeHtml(tr("Monthly amount"))}" inputmode="decimal" step="0.01" min="0" placeholder="0.00" autocomplete="off" />
    </label>`;
  wrap.appendChild(row);
  if (focus) setTimeout(() => row.querySelector(".onboard-bill-name")?.focus(), 60);
  // Three is plenty to make the number feel real; more is a data-entry chore
  // and the Monthly tab does it better.
  const add = document.querySelector('[data-onboard="add-bill"]');
  if (add) add.hidden = onboardBillRows >= 3;
}

function onboardAddDebtRow(type) {
  const spec = ONBOARD_DEBTS[type];
  const wrap = document.getElementById("onboard-debt-rows");
  if (!spec || !wrap) return;
  if (wrap.children.length >= ONBOARD_DEBT_MAX) return;
  const n = ++onboardDebtRows;
  const row = document.createElement("div");
  row.className = "onboard-debt";
  row.dataset.type = type;
  // Visible labels here, unlike the bill rows: two amounts side by side are
  // easy to swap, and swapping them is the difference between a 3-year and a
  // 30-year answer.
  row.innerHTML = `
    <div class="onboard-debt-head">
      <input type="text" class="onboard-debt-name" aria-label="Debt name" value="${escapeHtml(tr(spec.name))}" autocomplete="off" />
      <span class="onboard-debt-rate">${escapeHtml(spec.note)}</span>
      <button type="button" class="onboard-debt-remove" data-onboard="remove-debt" aria-label="${tr("Remove {name}", { name: escapeHtml(tr(spec.name)) })}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="onboard-debt-fields">
      <label class="onboard-debt-field">
        <span class="onboard-debt-label" id="od-owe-${n}">${escapeHtml(spec.owe)}</span>
        <span class="onboard-field onboard-field-sm">
          <span class="onboard-cur">RM</span>
          <input type="number" class="onboard-debt-balance" aria-labelledby="od-owe-${n}" inputmode="decimal" step="0.01" min="0" placeholder="0.00" autocomplete="off" />
        </span>
      </label>
      <label class="onboard-debt-field">
        <span class="onboard-debt-label" id="od-pay-${n}">Pay monthly</span>
        <span class="onboard-field onboard-field-sm">
          <span class="onboard-cur">RM</span>
          <input type="number" class="onboard-debt-monthly" aria-labelledby="od-pay-${n}" inputmode="decimal" step="0.01" min="0" placeholder="0.00" autocomplete="off" />
        </span>
      </label>
    </div>`;
  I18N.translate(row);
  wrap.appendChild(row);
  setTimeout(() => row.querySelector(".onboard-debt-balance")?.focus(), 60);
  onboardSyncDebtStep();
}

// The primary button says what it will do. With nothing added it is the
// one-tap way past the step; once a debt is in, it promises the answer.
function onboardSyncDebtStep() {
  const wrap = document.getElementById("onboard-debt-rows");
  const count = wrap ? wrap.children.length : 0;
  const next = document.getElementById("onboard-debt-next");
  if (next) next.textContent = count ? tr("Show my debt-free date") : tr("I don't owe anything");
  const note = document.getElementById("onboard-debt-note");
  if (note) note.hidden = !wrap || !wrap.querySelector('[data-type="card"], [data-type="ptptn"], [data-type="personal"]');
  const full = count >= ONBOARD_DEBT_MAX;
  document.querySelectorAll("#onboard-dialog [data-onboard-debt]").forEach((b) => { b.disabled = full; });
}

// Reads the form and writes real records — no scratch format, no separate
// "onboarding state" to reconcile later. What you type here is an ordinary
// income row, ordinary recurring expenses and ordinary debts, editable on
// Monthly and Debts like any other. Returns what was committed so the result
// step can talk about it.
function onboardCommit() {
  const m = currentMonthISO();
  const income = Number(document.getElementById("onboard-income")?.value) || 0;
  if (income > 0 && !state.income.some((r) => r.month === m)) {
    state.income.push({ id: uid(), name: "Income", amount: splitRound2Safe(income), month: m, day: null });
  }
  let bills = 0;
  document.querySelectorAll("#onboard-bill-rows .onboard-row").forEach((row) => {
    const amount = Number(row.querySelector(".onboard-bill-amount")?.value) || 0;
    if (!(amount > 0)) return;
    const name = (row.querySelector(".onboard-bill-name")?.value || "").trim() || "Bill";
    state.expenses.push({ id: uid(), name, amount: splitRound2Safe(amount), month: m, day: null });
    bills += amount;
  });
  const debts = [];
  document.querySelectorAll("#onboard-debt-rows .onboard-debt").forEach((row) => {
    const spec = ONBOARD_DEBTS[row.dataset.type];
    if (!spec) return;
    const balance = splitRound2Safe(row.querySelector(".onboard-debt-balance")?.value);
    const monthly = splitRound2Safe(row.querySelector(".onboard-debt-monthly")?.value);
    if (!(balance > 0)) return;
    const name = (row.querySelector(".onboard-debt-name")?.value || "").trim() || spec.name;
    let debt;
    if (spec.kind === "installment" && monthly > 0) {
      const monthsLeft = Math.max(1, Math.ceil(balance / monthly));
      debt = {
        id: uid(), name, balance, apr: 0, minPayment: monthly, dueDay: null,
        kind: "installment", installment: monthly, monthsLeft, termMonths: monthsLeft,
      };
    } else {
      // An instalment plan with no instalment is not one; keep what was typed
      // as an ordinary balance so the payoff maths flags it rather than
      // inventing a payment.
      debt = { id: uid(), name, balance, apr: spec.apr, minPayment: monthly, dueDay: null, kind: "standard" };
    }
    // Same brand guess the Debts form makes from a typed name ("Atome",
    // "Maybank card"), so the row gets its logo tile like any other.
    try { Object.assign(debt, debtBrandFromForm({ get: () => "" }, name)); } catch {}
    state.debts.push(debt);
    debts.push(debt);
  });
  save();
  renderAll();
  return { income, bills, debts };
}

// Local rounding helper: split.js may not have loaded, and this must never
// be the thing that breaks someone's first thirty seconds.
function splitRound2Safe(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Counts today. The home screen uses the same helper, so the day rate on the
// result screen and the one on the hero card are the same number.
function daysRemainingInMonth() {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, last - now.getDate() + 1);
}

// A round, affordable nudge: about a tenth of what's left, in RM 50 steps,
// between RM 50 and RM 500. Enough to move the date visibly, small enough
// to be believable on a first day.
function onboardExtraSuggestion(left) {
  if (!(left >= 100)) return 0;
  return Math.min(500, Math.max(50, Math.round((left * 0.1) / 50) * 50));
}

let onboardResult = null;

function onboardDebtFreeLabel(months) {
  return formatMonthLabel(shiftMonth(currentMonthISO(), months - 1));
}

function onboardRenderResult() {
  const r = onboardResult;
  if (!r) return;
  const extra = r.extraOn ? r.extra : 0;
  const minSum = r.debts.reduce((s, d) => s + (Number(d.minPayment) || 0), 0);
  const left = Math.max(0, r.income - r.bills - minSum - extra);
  const daysLeft = daysRemainingInMonth();
  const perDay = left > 0 ? tr("about {a} a day", { a: fmtMoney(left / daysLeft) }) : "";

  const freeWrap = document.getElementById("onboard-free");
  const leftWrap = document.getElementById("onboard-left-wrap");
  const explainEl = document.getElementById("onboard-explain");
  const hasDebts = r.debts.length > 0;
  if (freeWrap) freeWrap.hidden = !hasDebts;
  if (leftWrap) leftWrap.hidden = hasDebts;

  if (hasDebts) {
    const sim = simulateAvalanche(r.debts, extra);
    const owed = r.debts.reduce((s, d) => s + (Number(d.balance) || 0), 0);
    const dateEl = document.getElementById("onboard-free-date");
    const metaEl = document.getElementById("onboard-free-meta");
    const lever = document.getElementById("onboard-lever");
    const leverText = document.getElementById("onboard-lever-text");
    const spendEl = document.getElementById("onboard-spend");
    const n = r.debts.length;
    const across = trn(n, "{a} across {n} debt", "{a} across {n} debts", { a: fmtMoney(owed) });
    if (sim.infeasible) {
      freeWrap.classList.add("is-stuck");
      if (dateEl) dateEl.textContent = tr("Not at these payments");
      if (metaEl) metaEl.textContent = `${across}. ${tr(minSum > 0 ? "The monthly payments don't outpace the interest. The Debts tab shows what it takes." : "The monthly payments don't outpace the balance — add what you pay each month. The Debts tab shows what it takes.")}`;
    } else {
      freeWrap.classList.remove("is-stuck");
      if (dateEl) dateEl.textContent = onboardDebtFreeLabel(sim.months);
      if (metaEl) {
        metaEl.textContent = `${tr("{t} from now.", { t: formatMonths(sim.months) })} ${across}${sim.totalInterest > 0.5 ? `, ${tr("plus {a} interest", { a: fmtMoney(sim.totalInterest) })}` : ""}.`;
      }
    }
    // The lever is the point of the screen: the date is not fixed, and here
    // is what moves it. It's a real setting (Debts → extra per month), not a
    // demo, and it's off until they choose it.
    if (lever && leverText) {
      const base = r.extraOn ? simulateAvalanche(r.debts, 0) : sim;
      const boosted = r.extraOn ? sim : simulateAvalanche(r.debts, r.extra);
      const saved = base.infeasible ? 0 : base.months - boosted.months;
      const show = r.extra > 0 && !boosted.infeasible && (base.infeasible || saved > 0);
      lever.hidden = !show;
      lever.setAttribute("aria-pressed", r.extraOn ? "true" : "false");
      if (show) {
        const when = onboardDebtFreeLabel(boosted.months);
        const gain = base.infeasible
          ? tr("and it clears")
          : `${trn(saved, "{n} month sooner", "{n} months sooner")}${base.totalInterest - boosted.totalInterest > 0.5 ? `, ${tr("{a} less interest", { a: fmtMoney(base.totalInterest - boosted.totalInterest) })}` : ""}`;
        leverText.innerHTML = r.extraOn
          ? `<strong>${tr("Paying {a} extra a month", { a: fmtMoney(r.extra) })}</strong><span>${tr("Moved from {from} — {gain}", { from: escapeHtml(base.infeasible ? tr("never") : onboardDebtFreeLabel(base.months)), gain: escapeHtml(gain) })}</span>`
          : `<strong>${tr("Pay {a} extra a month?", { a: fmtMoney(r.extra) })}</strong><span>${tr("Debt-free by {when} — {gain}", { when: escapeHtml(when), gain: escapeHtml(gain) })}</span>`;
      }
    }
    if (spendEl) {
      spendEl.innerHTML = r.income > 0
        ? `<span>${tr("Left to spend this month")}</span><strong>${escapeHtml(fmtMoney(left))}</strong>${perDay ? `<em>${escapeHtml(perDay)}</em>` : ""}`
        : "";
      spendEl.hidden = !(r.income > 0);
    }
    if (explainEl) {
      explainEl.textContent = tr(r.income > 0
        ? "Highest rate gets paid first."
        : "Add your income on the Monthly tab to see this.");
    }
  } else {
    const leftEl = document.getElementById("onboard-left");
    const perDayEl = document.getElementById("onboard-perday");
    if (leftEl) leftEl.textContent = fmtMoney(left);
    if (perDayEl) perDayEl.textContent = perDay ? tr("{perDay} for the rest of the month.", { perDay: perDay[0].toUpperCase() + perDay.slice(1) }) : "";
    if (explainEl) {
      explainEl.textContent = tr(r.income > 0
        ? "Every spend you log comes off this."
        : "Add your income on the Monthly tab to see this.");
    }
  }
}

function onboardShowResult() {
  const { income, bills, debts } = onboardCommit();
  const minSum = debts.reduce((s, d) => s + (Number(d.minPayment) || 0), 0);
  onboardResult = {
    income, bills, debts,
    extra: onboardExtraSuggestion(income - bills - minSum),
    extraOn: false,
  };
  onboardRenderResult();
  onboardShowStep(4);
}

function onboardToggleExtra() {
  const r = onboardResult;
  if (!r || !r.extra) return;
  r.extraOn = !r.extraOn;
  state.extraMonthly = r.extraOn ? r.extra : 0;
  save();
  renderAll();
  onboardRenderResult();
}

function openOnboard() {
  const dlg = onboardDialog();
  if (!dlg) { openGuide({ firstRun: false }); return; } // markup missing: fall back to the tour
  onboardBillRows = 0;
  onboardDebtRows = 0;
  onboardResult = null;
  const wrap = document.getElementById("onboard-bill-rows");
  if (wrap) wrap.innerHTML = "";
  const debtWrap = document.getElementById("onboard-debt-rows");
  if (debtWrap) debtWrap.innerHTML = "";
  onboardAddBillRow(false);
  onboardSyncDebtStep();
  const inc = document.getElementById("onboard-income");
  if (inc) inc.value = "";
  onboardShowStep(1);
  if (!dlg.open) dlg.showModal();
}

function closeOnboard() {
  const dlg = onboardDialog();
  if (dlg && dlg.open) dlg.close();
  // Mark it seen in memory whether or not we can persist. Gating the flag
  // itself on aesKey means that if the key is ever missing here, the user is
  // asked to set up again on every launch — an onboarding loop, which is far
  // worse than a flag that fails to survive one restart. Only the write needs
  // the key.
  if (!state.guideSeen) {
    state.guideSeen = true;
    if (aesKey) save();
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("[data-onboard], [data-onboard-debt], #onboard-lever") : null;
  if (!btn) return;
  if (btn.id === "onboard-lever") { onboardToggleExtra(); return; }
  if (btn.dataset.onboardDebt) { onboardAddDebtRow(btn.dataset.onboardDebt); return; }
  const action = btn.dataset.onboard;
  const step = Number(btn.closest(".onboard-step")?.dataset.onboardStep || 1);
  if (action === "skip") { closeOnboard(); return; }
  if (action === "done") { closeOnboard(); return; }
  if (action === "back") { onboardShowStep(step - 1); return; }
  if (action === "add-bill") { onboardAddBillRow(true); return; }
  if (action === "remove-debt") {
    const row = btn.closest(".onboard-debt");
    const wrap = row?.parentElement;
    row?.remove();
    onboardSyncDebtStep();
    (wrap?.querySelector(".onboard-debt:last-child .onboard-debt-balance")
      || document.querySelector("#onboard-dialog [data-onboard-debt]"))?.focus();
    return;
  }
  if (action === "next") {
    if (step < 3) onboardShowStep(step + 1);
    else onboardShowResult();
  }
});

// Fires only from the passcode-setup flow (first-run or legacy migration).
// Returning users never see it; the full tour replays from Settings → About.
function maybeOpenGuideAfterSetup() {
  // Checked again when the timer fires: a restore marks the tour seen
  // (someone bringing their data back knows the app) in the meantime.
  if (!state.guideSeen) {
    setTimeout(() => { if (!state.guideSeen) openOnboard(); }, 250);
  }
}

/* ---------- PWA install banner (one-tap on Android, iOS modal fallback) ---------- */

const INSTALL_DISMISS_KEY = "duit-tracker.install-dismissed-at";
const INSTALL_DISMISS_DAYS = 14;
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // If the user is already unlocked, surface the banner now.
  if (!document.getElementById("lock")?.hidden === false && aesKey) {
    maybeShowInstallBanner();
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  hideInstallBanner();
  localStorage.removeItem(INSTALL_DISMISS_KEY);
});

function installDismissedRecently() {
  const ts = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
  if (!ts) return false;
  return Date.now() - ts < INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function canOfferInstall() {
  if (isStandalonePWA()) return false;
  if (installDismissedRecently()) return false;
  const platform = detectInstallPlatform();
  return !!deferredInstallPrompt || platform === "ios-safari";
}

function showInstallBanner() {
  const el = document.getElementById("pwa-install-banner");
  if (el) el.hidden = false;
}

function hideInstallBanner() {
  const el = document.getElementById("pwa-install-banner");
  if (el) el.hidden = true;
}

function maybeShowInstallBanner() {
  if (canOfferInstall()) {
    // Wait a beat so it doesn't land on top of the welcome tour.
    setTimeout(() => {
      if (document.getElementById("guide-dialog")?.open) return;
      showInstallBanner();
    }, 600);
  }
}

async function triggerInstall() {
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch { /* user cancelled */ }
    deferredInstallPrompt = null;
    hideInstallBanner();
    return;
  }
  if (detectInstallPlatform() === "ios-safari") {
    const dlg = document.getElementById("pwa-install-ios");
    if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  }
}

document.getElementById("pwa-install-accept")?.addEventListener("click", () => { triggerInstall(); });
document.getElementById("pwa-install-dismiss")?.addEventListener("click", () => {
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  hideInstallBanner();
});
document.getElementById("pwa-ios-close")?.addEventListener("click", () => {
  const dlg = document.getElementById("pwa-install-ios");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  hideInstallBanner();
});

function guideAdvance() {
  if (guideStep >= GUIDE_STEPS.length - 1) { finishGuide(); return; }
  guideStep += 1;
  renderGuideStep();
}
function guideRewind() {
  if (guideStep === 0) return;
  guideStep -= 1;
  renderGuideStep();
}
// Modal-dialog buttons.
document.getElementById("guide-next")?.addEventListener("click", guideAdvance);
document.getElementById("guide-prev")?.addEventListener("click", guideRewind);
document.getElementById("guide-skip")?.addEventListener("click", () => { finishGuide(); });
// Spotlight-tooltip buttons (live inside #guide-spotlight, separate
// from the dialog so the tooltip can travel with the highlighted target).
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest(".guide-tooltip .guide-action-next")) guideAdvance();
  else if (t.closest(".guide-tooltip .guide-action-prev")) guideRewind();
  else if (t.closest(".guide-tooltip .guide-action-skip")) finishGuide();
});
document.getElementById("btn-show-guide")?.addEventListener("click", () => { openGuide(); });

// Only treat the close as a user dismiss when we didn't trigger it
// ourselves (transitioning into a spotlight step). The listener resets
// the flag itself — the dialog's "close" event can fire ASYNChronously,
// so the close call-site must NOT reset the flag synchronously or the
// guard would already be false by the time this runs.
guideDialog()?.addEventListener("close", () => {
  if (_guideInternalClose) { _guideInternalClose = false; return; }
  finishGuide();
});
// First-run users can't bail with Esc — the "cancel" event fires before
// "close", so preventing it keeps the modal open. They have to reach the
// end (Got it). Replay sessions (guideFirstRun false) keep Esc working.
guideDialog()?.addEventListener("cancel", (e) => {
  if (guideFirstRun) e.preventDefault();
});

/* ---------- "New" feature spotlight with motion (v1.65.0) ----------
   When a release adds a feature, returning users who updated past that
   version see a single calm "New" chip on Home. Tapping it switches to the
   relevant tab, smooth-scrolls to the target, and pulses a highlight ring
   (or jumps with a static ring when prefers-reduced-motion is set). Brand-new
   installs never see it (they have the tour); dismissed once seen or tapped. */
const NEW_FEATURES_SEEN_KEY = "duitful.newFeaturesSeen";
const NEW_FEATURES_FROM_KEY = "duitful.newFeaturesFrom";
const NEW_FEATURES = [
  { id: "daily-streaks", version: "1.66.0", tab: "dashboard", target: ["#streak-pill", "#today-card"], label: () => tr("Daily check-in streak") },
  { id: "pastel-theme", version: "1.62.0", tab: "data", target: [".theme-pills"], label: () => tr("Pastel theme") },
  { id: "wallets", version: "1.61.0", tab: "savings", target: ["#wallets-card"], label: () => tr("Wallets") },
  { id: "recurring-splits", version: "1.59.0", tab: "debts", target: ["#rs-card", "[data-action='rs-new']", ".split-start-card"], label: () => tr("Recurring splits") },
  { id: "statement-import", version: "1.57.0", tab: "data", target: ["#btn-stmt-import"], label: () => tr("Import bank statement") },
];

let _featureSpotTimer = null;
let _featureSpotEl = null;

function readNewFeaturesSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(NEW_FEATURES_SEEN_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}
function markNewFeatureSeen(id) {
  if (!id) return;
  const seen = readNewFeaturesSeen();
  seen[id] = true;
  try { localStorage.setItem(NEW_FEATURES_SEEN_KEY, JSON.stringify(seen)); } catch {}
}
function markAllNewFeaturesSeen() {
  const seen = readNewFeaturesSeen();
  for (const f of NEW_FEATURES) seen[f.id] = true;
  try { localStorage.setItem(NEW_FEATURES_SEEN_KEY, JSON.stringify(seen)); } catch {}
}
function initFeatureSpotlights() {
  if (typeof state === "undefined" || !state) return;
  const hasData =
    (state.income?.length || 0) +
    (state.expenses?.length || 0) +
    (state.dailyExpenses?.length || 0) +
    (state.debts?.length || 0) +
    (state.savings?.length || 0) +
    (state.investments?.length || 0);
  const prev = state.lastSeenVersion || "";
  if (!hasData && !prev) {
    // Brand-new install: never show "New" update chips (the tour handles them).
    markAllNewFeaturesSeen();
    try { localStorage.setItem(NEW_FEATURES_FROM_KEY, APP_VERSION); } catch {}
    renderFeatureSpotlight();
    return;
  }
  if (prev && versionCompare(prev, APP_VERSION) < 0) {
    let storedFrom = "";
    try { storedFrom = localStorage.getItem(NEW_FEATURES_FROM_KEY) || ""; } catch {}
    // Keep the older baseline if an earlier update spotlight is still pending.
    if (!storedFrom || versionCompare(prev, storedFrom) < 0 || !activeNewFeature()) {
      try { localStorage.setItem(NEW_FEATURES_FROM_KEY, prev); } catch {}
    }
  }
  renderFeatureSpotlight();
}
function activeNewFeature() {
  let fromVer = "";
  try { fromVer = localStorage.getItem(NEW_FEATURES_FROM_KEY) || ""; } catch {}
  if (!fromVer || versionCompare(fromVer, APP_VERSION) >= 0) return null;
  const seen = readNewFeaturesSeen();
  const eligible = NEW_FEATURES
    .filter((f) =>
      !seen[f.id] &&
      versionCompare(f.version, fromVer) > 0 &&
      versionCompare(f.version, APP_VERSION) <= 0)
    .sort((a, b) => versionCompare(b.version, a.version));
  return eligible[0] || null;
}
function clearFeatureSpotHighlight() {
  if (_featureSpotTimer) { clearTimeout(_featureSpotTimer); _featureSpotTimer = null; }
  if (_featureSpotEl) {
    _featureSpotEl.classList.remove("feature-spot-highlight");
    _featureSpotEl = null;
  }
}
function renderFeatureSpotlight() {
  const bar = document.getElementById("feature-spot-bar");
  const labelEl = document.getElementById("feature-spot-label");
  if (!bar || !labelEl) return;
  const lock = document.getElementById("lock");
  const guideSpot = document.getElementById("guide-spotlight");
  const openDialog = document.querySelector("dialog[open]");
  const feat = activeNewFeature();
  const blocked = !feat || (lock && !lock.hidden) || !!openDialog || (guideSpot && !guideSpot.hidden);
  if (blocked) {
    bar.hidden = true;
    bar.removeAttribute("data-feature-id");
    return;
  }
  labelEl.textContent = typeof feat.label === "function" ? feat.label() : tr(feat.label);
  bar.setAttribute("data-feature-id", feat.id);
  bar.hidden = false;
}
function triggerFeatureSpotlight(feat) {
  if (!feat) return;
  markNewFeatureSeen(feat.id);
  renderFeatureSpotlight();
  clearFeatureSpotHighlight();
  if (feat.tab) {
    const tabBtn = document.querySelector(`.tab[data-tab="${feat.tab}"]`);
    if (tabBtn && !tabBtn.classList.contains("active")) tabBtn.click();
  }
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    const list = Array.isArray(feat.target) ? feat.target : [feat.target];
    let el = null;
    for (const sel of list) {
      const cand = document.querySelector(sel);
      if (!cand) continue;
      const det = cand.closest("details");
      if (det && !det.open) det.open = true;
      if (cand.offsetParent !== null) { el = cand; break; }
    }
    if (!el) return;
    try { el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" }); } catch {}
    el.classList.add("feature-spot-highlight");
    _featureSpotEl = el;
    const clearOnce = () => { clearFeatureSpotHighlight(); };
    el.addEventListener("pointerdown", clearOnce, { once: true });
    _featureSpotTimer = setTimeout(clearFeatureSpotHighlight, 2800);
  });
}
function dismissFeatureSpotlight() {
  const feat = activeNewFeature();
  if (feat) markNewFeatureSeen(feat.id);
  renderFeatureSpotlight();
}

document.getElementById("btn-feature-spot")?.addEventListener("click", () => {
  const feat = activeNewFeature();
  if (feat) triggerFeatureSpotlight(feat);
});
document.getElementById("btn-feature-spot-dismiss")?.addEventListener("click", dismissFeatureSpotlight);
// Re-check whenever any dialog opens or closes so the chip never competes with a sheet.
document.querySelectorAll("dialog").forEach((d) => {
  d.addEventListener("close", () => { renderFeatureSpotlight(); });
});
if (typeof MutationObserver !== "undefined") {
  const _fsObs = new MutationObserver(() => { renderFeatureSpotlight(); });
  document.querySelectorAll("dialog").forEach((d) => {
    _fsObs.observe(d, { attributes: true, attributeFilter: ["open"] });
  });
}

