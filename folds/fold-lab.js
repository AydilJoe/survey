/* Fold lab: device profiles and Duitful's planned layout rules for folding
   phones, shared by the /folds/ page (which draws them in 3D) and by
   tests/e2e.mjs (which checks the geometry).

   Every size is in CSS pixels and APPROXIMATE. Apple has not published
   iPhone Duo point sizes, and the Samsung figures are converted from panel
   pixels. Replace them with values measured in the Xcode iPhone Duo
   simulator / Android Studio foldable emulator when we have them; the
   layout rules below never key on a device, only on the space available.

   A posture says which display is in use, whether a hinge is bent, and
   whether the fold divides the content (Apple: the folding region exists
   only while the device is partly open; flat, it is one continuous
   display). */
(function (root) {
  "use strict";

  const DEVICES = [
    {
      id: "phone",
      name: "Phone",
      note: "A typical 6.3-inch phone, for comparison.",
      railEdge: "left",
      displays: {
        portrait: { w: 402, h: 874, radius: 54, insets: { t: 62, r: 0, b: 34, l: 0 }, island: "top" },
        landscape: { w: 874, h: 402, radius: 54, insets: { t: 0, r: 62, b: 21, l: 62 }, island: "left" },
      },
      postures: [
        { id: "portrait", label: "Portrait", display: "portrait" },
        { id: "landscape", label: "Landscape", display: "landscape" },
      ],
    },
    {
      id: "iphone-duo",
      name: "iPhone Duo",
      note: "Outer display is wider and shorter than other iPhones; the status bar and camera sit on the side.",
      railEdge: "right",
      displays: {
        outer: { w: 476, h: 676, radius: 44, insets: { t: 12, r: 52, b: 12, l: 0 }, island: "right" },
        inner: {
          w: 952, h: 676, radius: 36, insets: { t: 12, r: 52, b: 12, l: 0 }, island: "right",
          fold: { orientation: "vertical", at: 476, width: 28 },
        },
      },
      postures: [
        { id: "closed", label: "Closed", display: "outer" },
        { id: "open", label: "Open flat", display: "inner", hinge: "vertical", angle: 180 },
        { id: "book", label: "Book", display: "inner", hinge: "vertical", angle: 118, separating: true },
      ],
    },
    {
      id: "galaxy-fold",
      name: "Galaxy Z Fold",
      note: "Tall cover screen, nearly square inner screen with a vertical fold.",
      railEdge: "left",
      displays: {
        outer: { w: 412, h: 940, radius: 30, insets: { t: 32, r: 0, b: 24, l: 0 }, island: "top" },
        inner: {
          w: 832, h: 748, radius: 22, insets: { t: 28, r: 0, b: 20, l: 0 }, island: "top",
          fold: { orientation: "vertical", at: 416, width: 24 },
        },
      },
      postures: [
        { id: "closed", label: "Cover", display: "outer" },
        { id: "open", label: "Open flat", display: "inner", hinge: "vertical", angle: 180 },
        { id: "book", label: "Book", display: "inner", hinge: "vertical", angle: 112, separating: true },
      ],
    },
    {
      id: "galaxy-flip",
      name: "Galaxy Z Flip",
      note: "Tall screen that folds across the middle; half-open it stands on a table.",
      railEdge: "left",
      displays: {
        inner: {
          w: 412, h: 960, radius: 30, insets: { t: 32, r: 0, b: 24, l: 0 }, island: "top",
          fold: { orientation: "horizontal", at: 480, width: 24 },
        },
      },
      postures: [
        { id: "open", label: "Open flat", display: "inner", hinge: "horizontal", angle: 180 },
        { id: "tabletop", label: "Tabletop", display: "inner", hinge: "horizontal", angle: 100, separating: true },
      ],
    },
  ];

  const SCREENS = [
    { id: "home", label: "Home" },
    { id: "entries", label: "All entries" },
    { id: "debts", label: "Debts" },
    { id: "savings", label: "Savings" },
    { id: "tax", label: "Tax" },
    { id: "settings", label: "Settings" },
  ];

  // Sample content in Duitful's own terms. Plain strings; the page escapes.
  const CONTENT = {
    home: {
      title: "Home",
      cards: [
        { t: "Left to spend", v: "RM 1,284", s: "of RM 4,200 this month", big: true },
        { t: "Debt-free", v: "Mar 2029", s: "4 months sooner than last month" },
        { t: "Today", v: "RM 46.30", s: "Grab, Mydin, Tealive" },
        { t: "Next due", v: "Atome · 12 Nov", s: "RM 89.90 instalment" },
        { t: "Emergency fund", v: "62%", s: "RM 6,200 of RM 10,000" },
        { t: "Tax relief", v: "RM 3,140", s: "found in your spending" },
        { t: "Budget", v: "71% used", s: "Food is close to its limit" },
        { t: "Zakat", v: "RM 412", s: "estimate for this haul" },
      ],
    },
    entries: {
      title: "All entries", detailTitle: "Mydin Subang",
      rows: [
        ["Mydin Subang", "Groceries · today", "−RM 86.40"],
        ["Grab", "Transport · today", "−RM 14.00"],
        ["Tealive", "Food · today", "−RM 9.90"],
        ["Salary", "Income · 25 Oct", "+RM 4,200.00"],
        ["TNB", "Bills · 24 Oct", "−RM 132.55"],
        ["Unifi", "Bills · 22 Oct", "−RM 129.00"],
        ["Shopee", "Shopping · 21 Oct", "−RM 58.20"],
        ["Petronas", "Fuel · 20 Oct", "−RM 60.00"],
        ["Watsons", "Health · 19 Oct", "−RM 31.80"],
        ["Touch 'n Go reload", "Transfer · 18 Oct", "−RM 50.00"],
      ],
      detail: [["Amount", "RM 86.40"], ["Category", "Groceries"], ["Date", "30 Oct 2026"], ["Paid with", "Maybank debit"], ["Receipt", "Scanned · 94% sure"]],
    },
    debts: {
      title: "Debts", detailTitle: "Maybank Visa",
      rows: [
        ["Maybank Visa", "18% APR · pay first", "RM 4,820"],
        ["Atome", "Pay-later · 3 of 6 left", "RM 269.70"],
        ["Car (AITAB)", "3.1% profit rate", "RM 38,400"],
        ["PTPTN", "1% ujrah", "RM 21,950"],
      ],
      detail: [["Balance", "RM 4,820"], ["Minimum", "RM 241 / month"], ["With your extra RM 300", "cleared Aug 2027"], ["Interest saved", "RM 1,106"]],
      chart: true,
    },
    savings: {
      title: "Savings", detailTitle: "Emergency fund",
      rows: [
        ["Emergency fund", "62% · RM 6,200", "RM 10,000"],
        ["Hajj (Tabung Haji)", "31% · RM 9,300", "RM 30,000"],
        ["New laptop", "80% · RM 3,200", "RM 4,000"],
        ["Wedding", "12% · RM 2,400", "RM 20,000"],
        ["ASB", "Holding · 4.25%", "RM 15,000"],
      ],
      detail: [["Saved", "RM 6,200"], ["Target", "RM 10,000"], ["At RM 400 a month", "reached Jun 2027"]],
      chart: true,
    },
    tax: {
      title: "Tax", detailTitle: "Lifestyle",
      tiles: [
        ["Lifestyle", "RM 1,840 of 2,500"], ["Medical", "RM 620 of 10,000"], ["Education", "RM 0 of 7,000"],
        ["Sports", "RM 410 of 1,000"], ["EPF", "RM 4,000 of 4,000"], ["Insurance", "RM 1,200 of 3,000"],
        ["Childcare", "RM 0 of 3,000"], ["SSPN", "RM 500 of 8,000"],
      ],
      detail: [["Claimed", "RM 1,840"], ["Limit", "RM 2,500"], ["Receipts", "6 of 9 attached"], ["Add receipts by", "15 Apr 2027"]],
    },
    settings: {
      title: "Settings", detailTitle: "Security",
      rows: [
        ["Security", "Passcode and Face ID", ""], ["Backup", "iCloud · last 2 min ago", ""], ["Reminders", "On due dates, 9am", ""],
        ["Currency", "MYR", ""], ["Appearance", "Follow system", ""], ["Data", "Export CSV, import", ""],
        ["Duitful Pro", "Unlocked", ""],
      ],
      detail: [["Passcode", "On"], ["Face ID", "On"], ["Lock after", "1 minute"], ["Change passcode", ""]],
    },
  };

  const NAV = ["Home", "Monthly", "Debts", "Savings", "Settings"];

  // Layout constants, in CSS px.
  const SIDEBAR_MIN_W = 1000; // tablets and desktop; every folding phone stays below it
  const RAIL_MIN_W = 600;     // Material "medium" width and up: a side rail
  const RAIL_MAX_H = 720;     // shorter than this and a bottom bar costs too much height
  const SIDEBAR_W = 208, RAIL_W = 76, BAR_H = 64, PANE_HEAD = 48, PAD = 16, GAP = 10;
  const SPLIT_MIN_W = 600;    // content this wide shows two panes even without a fold

  function device(id) { return DEVICES.find((d) => d.id === id) || DEVICES[0]; }
  function posture(dev, id) { return dev.postures.find((p) => p.id === id) || dev.postures[0]; }

  function foldRect(display, pos) {
    const f = display.fold;
    if (!f || !pos.separating) return null;
    return f.orientation === "vertical"
      ? { x: f.at - f.width / 2, y: 0, w: f.width, h: display.h, orientation: "vertical" }
      : { x: 0, y: f.at - f.width / 2, w: display.w, h: f.width, orientation: "horizontal" };
  }

  // Even column count for a pane: a fold or a centre line never cuts a card.
  function columnsFor(w) { return w < 340 ? 1 : w < 720 ? 2 : 4; }

  function layout(deviceId, postureId, screenId, opts) {
    opts = opts || {};
    const dev = device(deviceId);
    // opts.separating overrides the posture, so a hinge slider can make the
    // fold appear part-way, the way the folding region does on a real device.
    const pos = { ...posture(dev, postureId) };
    if (typeof opts.separating === "boolean") pos.separating = opts.separating && !!pos.hinge;
    const disp = dev.displays[pos.display];
    const W = disp.w, H = disp.h, ins = disp.insets;
    const safe = { x: ins.l, y: ins.t, w: W - ins.l - ins.r, h: H - ins.t - ins.b };
    const fold = foldRect(disp, pos);
    const screen = CONTENT[screenId] ? screenId : "home";
    const c = CONTENT[screen];
    const boxes = [];
    const add = (b) => { boxes.push(b); return b; };

    // 1. Navigation: sidebar when wide, side rail when short, bottom bar otherwise.
    let nav, content = { ...safe };
    if (W >= SIDEBAR_MIN_W) {
      nav = "sidebar";
      add({ kind: "nav", role: "sidebar", x: safe.x, y: safe.y, w: SIDEBAR_W, h: safe.h });
      content = { x: safe.x + SIDEBAR_W, y: safe.y, w: safe.w - SIDEBAR_W, h: safe.h };
    } else if (W >= RAIL_MIN_W || H < RAIL_MAX_H) {
      nav = "rail";
      const rx = dev.railEdge === "right" ? safe.x + safe.w - RAIL_W : safe.x;
      add({ kind: "nav", role: "rail", x: rx, y: safe.y, w: RAIL_W, h: safe.h });
      content = { x: dev.railEdge === "right" ? safe.x : safe.x + RAIL_W, y: safe.y, w: safe.w - RAIL_W, h: safe.h };
    } else {
      nav = "bottom";
      add({ kind: "nav", role: "bottom", x: 0, y: H - ins.b - BAR_H, w: W, h: BAR_H + ins.b, padB: ins.b });
      content = { x: safe.x, y: safe.y, w: safe.w, h: safe.h - BAR_H };
    }
    const navBox = boxes[0];
    NAV.forEach((label, i) => {
      const n = NAV.length;
      let b;
      if (nav === "sidebar") b = { x: navBox.x + 12, y: navBox.y + 64 + i * 46, w: navBox.w - 24, h: 40 };
      else if (nav === "rail") {
        const step = Math.min(64, (navBox.h - 32) / n);
        b = { x: navBox.x + 8, y: navBox.y + 16 + i * step, w: navBox.w - 16, h: step - 6 };
      } else {
        const iw = navBox.w / n;
        b = { x: navBox.x + i * iw + 4, y: navBox.y + 6, w: iw - 8, h: BAR_H - 12 };
      }
      add({ kind: "navitem", label, active: i === navIndex(screen), ...b });
    });

    // 2. Panes: one per fold segment; otherwise two when there is room.
    let panes = [];
    if (fold && fold.orientation === "vertical") {
      const left = { x: content.x, y: content.y, w: fold.x - content.x, h: content.h };
      const rx = fold.x + fold.w;
      const right = { x: rx, y: content.y, w: content.x + content.w - rx, h: content.h };
      panes = [left, right].filter((p) => p.w > 120);
    } else if (fold && fold.orientation === "horizontal") {
      const top = { x: content.x, y: content.y, w: content.w, h: fold.y - content.y };
      const by = fold.y + fold.h;
      const bottom = { x: content.x, y: by, w: content.w, h: content.y + content.h - by };
      panes = [top, bottom].filter((p) => p.h > 120);
    } else if (content.w >= SPLIT_MIN_W) {
      const pw = Math.round(Math.min(380, Math.max(280, content.w * 0.4)));
      panes = [
        { x: content.x, y: content.y, w: pw, h: content.h },
        { x: content.x + pw, y: content.y, w: content.w - pw, h: content.h },
      ];
    } else {
      panes = [{ ...content }];
    }
    const twoPanes = panes.length === 2;
    // Tabletop: the top half is for looking (the detail, a chart), the
    // bottom half for touching (the list), so they swap roles.
    const tabletop = fold && fold.orientation === "horizontal";
    const roles = twoPanes ? (tabletop ? ["secondary", "primary"] : ["primary", "secondary"]) : ["primary"];

    panes.forEach((p, i) => {
      const role = roles[i];
      add({ kind: "pane", role, ...p });
      const inner = { x: p.x + PAD, y: p.y + PANE_HEAD, w: p.w - PAD * 2, h: p.h - PANE_HEAD - PAD };
      add({ kind: "header", role, text: role === "secondary" && c.detailTitle ? c.detailTitle : c.title, x: p.x + PAD, y: p.y + 8, w: p.w - PAD * 2, h: 36 });
      if (screen === "home") {
        // Home has no list and detail: one even grid flowing across the panes.
        const per = twoPanes ? Math.ceil(c.cards.length / 2) : c.cards.length;
        const cards = c.cards.slice(i * per, i * per + per);
        flowCards(cards, inner, add);
      } else if (role === "primary") {
        if (screen === "tax") flowTiles(c.tiles, inner, add);
        else flowRows(c.rows, inner, add, twoPanes);
      } else {
        flowDetail(c, inner, add);
      }
    });

    // 3. A dialog sits inside one segment, never across the fold.
    if (opts.dialog) {
      let seg = content;
      if (fold) seg = tabletop ? panes[0] : panes[panes.length - 1];
      const dw = Math.min(360, seg.w - 32), dh = Math.min(272, seg.h - 32);
      add({ kind: "dialog", x: Math.round(seg.x + (seg.w - dw) / 2), y: Math.round(seg.y + (seg.h - dh) / 2), w: dw, h: dh });
    }

    return {
      device: dev, posture: pos, screen, display: disp, W, H, safe, fold, nav, panes: panes.length,
      boxes,
      summary: summary(dev, pos, nav, panes.length, fold, screen),
    };
  }

  function navIndex(screen) {
    return { home: 0, entries: 1, debts: 2, savings: 3, tax: 0, settings: 4 }[screen] ?? 0;
  }

  function flowRows(rows, r, add, withSelection) {
    const rh = 58;
    let y = r.y;
    rows.forEach((row, i) => {
      if (y + rh > r.y + r.h) return;
      add({ kind: "row", text: row[0], sub: row[1], value: row[2], selected: withSelection && i === 0, x: r.x, y, w: r.w, h: rh });
      y += rh + 6;
    });
  }

  function flowCards(cards, r, add) {
    const cols = columnsFor(r.w);
    const cw = (r.w - GAP * (cols - 1)) / cols;
    const ch = 112;
    cards.forEach((card, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const y = r.y + row * (ch + GAP);
      if (y + ch > r.y + r.h) return;
      add({ kind: "card", text: card.t, value: card.v, sub: card.s, big: !!card.big, cols, x: r.x + col * (cw + GAP), y, w: cw, h: ch });
    });
  }

  function flowTiles(tiles, r, add) {
    const cols = columnsFor(r.w) === 1 ? 2 : columnsFor(r.w);
    const cw = (r.w - GAP * (cols - 1)) / cols;
    const ch = 84;
    tiles.forEach((t, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const y = r.y + row * (ch + GAP);
      if (y + ch > r.y + r.h) return;
      add({ kind: "tile", text: t[0], sub: t[1], cols, x: r.x + col * (cw + GAP), y, w: cw, h: ch });
    });
  }

  function flowDetail(c, r, add) {
    let y = r.y;
    if (c.chart && r.h > 320) {
      add({ kind: "chart", x: r.x, y, w: r.w, h: 132 });
      y += 132 + GAP;
    }
    (c.detail || []).forEach((d) => {
      if (y + 48 > r.y + r.h) return;
      add({ kind: "field", text: d[0], value: d[1], x: r.x, y, w: r.w, h: 48 });
      y += 48 + 6;
    });
    if (y + 44 <= r.y + r.h) add({ kind: "button", text: "Edit", x: r.x, y: y + 6, w: Math.min(r.w, 200), h: 44 });
  }

  function summary(dev, pos, nav, panes, fold, screen) {
    const navText = {
      sidebar: "Navigation moves to a sidebar.",
      rail: `The tab bar becomes a side rail on the ${dev.railEdge} edge, so the short screen keeps its height for content.`,
      bottom: "The tab bar stays at the bottom, in thumb reach.",
    }[nav];
    let paneText;
    if (screen === "home") paneText = panes === 2 ? "Home's cards flow across both halves in an even grid." : "Home's cards sit in an even grid.";
    else if (fold && fold.orientation === "horizontal") paneText = "The top half shows the detail; the bottom half holds the list you touch.";
    else if (fold) paneText = "The list sits on the left half and the detail on the right, each clear of the fold.";
    else if (panes === 2) paneText = "There is room for the list and the detail side by side.";
    else paneText = "One pane; tapping an item opens its detail.";
    return `${navText} ${paneText}`;
  }

  // Generic geometry checks, usable on this layout or on rects measured from
  // the real app: nothing you tap may sit on a dividing fold, every box
  // must stay inside the display, and touch targets must stay inside the
  // safe area.
  const TAPPABLE = new Set(["navitem", "row", "card", "tile", "button", "field", "dialog", "chart", "header"]);
  function intersects(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function problems(result) {
    const out = [];
    const { boxes, fold, safe, W, H } = result;
    const eps = 0.5;
    for (const b of boxes) {
      if (b.x < -eps || b.y < -eps || b.x + b.w > W + eps || b.y + b.h > H + eps) out.push({ box: b, problem: "outside the display" });
      if (fold && TAPPABLE.has(b.kind) && intersects(b, fold)) out.push({ box: b, problem: "on the fold" });
      if (TAPPABLE.has(b.kind) && (b.x < safe.x - eps || b.y < safe.y - eps || b.x + b.w > safe.x + safe.w + eps || b.y + b.h > safe.y + safe.h + eps)) {
        out.push({ box: b, problem: "outside the safe area" });
      }
      if ((b.kind === "card" || b.kind === "tile") && b.cols > 1 && b.cols % 2) out.push({ box: b, problem: "odd column count" });
    }
    return out;
  }

  // Every device × posture × screen, with and without a dialog.
  function allCases() {
    const cases = [];
    for (const d of DEVICES) for (const p of d.postures) for (const s of SCREENS) for (const dialog of [false, true]) {
      cases.push({ device: d.id, posture: p.id, screen: s.id, dialog });
    }
    return cases;
  }

  root.FoldLab = { DEVICES, SCREENS, CONTENT, layout, problems, allCases, device, posture, foldRect };
})(typeof window !== "undefined" ? window : globalThis);
