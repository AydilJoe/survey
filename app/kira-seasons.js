/* ---------- Festive Kira: the seasons (1.76.0) ----------
   Pure: no DOM, no storage. Loaded before kira.js in the app, and on its own
   by split/index.html, the landing pages and scripts/build-kira-stickers.mjs.
   Spec: docs/plans/kira-festive.md (windows, overlap rules, greetings,
   respect). Dates: docs/plans/kira-holidays-2026-2028.json ("g" = gazetted,
   "e" = expected), copied into KIRA_HOLIDAYS below.

   KiraSeasons.seasonFor(date, { table }) → null on an ordinary day, else
     { id, look, calm, flag, strong, holiday, names, key, start, date }
       id      the season the greeting belongs to ("cny", "ramadan", …,
               "kongsi_raya", "deepa_raya", "shared")
       look    which props Kira wears (one of KiraSeasons.LOOKS)
       calm    Ramadan, or a quiet religious day (the Islamic holy days,
               Thaipusam, Wesak): no party mood, no confetti, no food props
       flag    null | "small" (Merdeka season beside another holiday) |
               "normal" | "big" (31 Aug and 16 Sep)
       strong  CNY days 0–1, Raya days 0–2, Merdeka / Malaysia Day itself
       names   season ids the greeting names, in order
       key     `${id}-${start}`: one greeting per season per device
   KiraSeasons.props(season) → { under, inner, front } SVG fragments in
     Kira's 64-unit drawing (kira.js puts `inner` inside the moving group, on
     top of the paper; `under` and `front` stand beside the feet). Props sit
     on the head, in the hand or beside Kira — never on the face or body.
   KiraSeasons.headOnly(season) → the hat alone (the AI's counting Kira may
     wear a hat and nothing else).

   Overlaps (the spec's five rules, in order):
     1. A season on one of its own holiday days beats another's lingering days.
     2. Ramadan and Merdeka season are backdrops: any other season inside them
        wins, with Ramadan making it calm (CNY lingering into Ramadan keeps its
        ang pao and a lantern, never the mandarin oranges or a party) and
        Merdeka season adding a small flag. Nuzul Al-Quran is the Ramadan look
        with an extra star, and belongs to Ramadan's greeting.
     3. Raya with CNY active is "Kongsi Raya"; Raya with Deepavali, "Deepa Raya".
     4. Kaamatan and Gawai (state) give way to a national holiday day. On the
        state festival's first day that is also a national holiday (Agong's
        Birthday on 1 Jun 2026 with Gawai) Kira wears the neutral festive look
        and the greeting names both; on its later days the national holiday
        wins (Wesak on 31 May 2026, Kaamatan's second day).
     5. Otherwise the season whose first day is nearest wins; a tie goes to
        the earlier one in ORDER.
   After the table (2029 on): Islamic days from Intl's islamic-umalqura
   calendar, CNY from Intl's chinese calendar, fixed days computed;
   Thaipusam, Wesak and Deepavali are skipped until the table is updated.
   tests/e2e.mjs fails a year before the table runs out. */
(function (root) {
  "use strict";

  const KIRA_HOLIDAYS = {
    2026: {
      newyear: ["2026-01-01", 1, "g"], thaipusam: ["2026-02-01", 1, "g"], cny: ["2026-02-17", 2, "g"],
      ramadan: ["2026-02-19", 0, "g"], nuzul: ["2026-03-07", 1, "g"], raya: ["2026-03-21", 2, "g"],
      labour: ["2026-05-01", 1, "g"], haji: ["2026-05-27", 1, "g"], kaamatan: ["2026-05-30", 2, "g"],
      wesak: ["2026-05-31", 1, "g"], gawai: ["2026-06-01", 2, "g"], agong: ["2026-06-01", 1, "g"],
      muharram: ["2026-06-17", 1, "g"], maulid: ["2026-08-25", 1, "g"], merdeka: ["2026-08-31", 1, "g"],
      malaysia_day: ["2026-09-16", 1, "g"], deepavali: ["2026-11-08", 1, "g"], christmas: ["2026-12-25", 1, "g"],
    },
    2027: {
      newyear: ["2027-01-01", 1, "g"], thaipusam: ["2027-01-22", 1, "g"], cny: ["2027-02-06", 2, "g"],
      ramadan: ["2027-02-08", 0, "g"], nuzul: ["2027-02-24", 1, "g"], raya: ["2027-03-10", 2, "g"],
      labour: ["2027-05-01", 1, "g"], haji: ["2027-05-17", 1, "g"], wesak: ["2027-05-20", 1, "g"],
      kaamatan: ["2027-05-30", 2, "g"], gawai: ["2027-06-01", 2, "g"], muharram: ["2027-06-06", 1, "g"],
      agong: ["2027-06-07", 1, "g"], maulid: ["2027-08-15", 1, "g"], merdeka: ["2027-08-31", 1, "g"],
      malaysia_day: ["2027-09-16", 1, "g"], deepavali: ["2027-10-28", 1, "g"], christmas: ["2027-12-25", 1, "g"],
    },
    2028: {
      newyear: ["2028-01-01", 1, "e"], cny: ["2028-01-26", 2, "e"], ramadan: ["2028-01-28", 0, "e"],
      // Thaipusam 2028 is disputed (9 vs 13 Feb); the Pusam nakshatra date is used.
      thaipusam: ["2028-02-09", 1, "e"], nuzul: ["2028-02-13", 1, "e"], raya: ["2028-02-27", 2, "e"],
      labour: ["2028-05-01", 1, "e"], haji: ["2028-05-05", 1, "e"], wesak: ["2028-05-09", 1, "e"],
      muharram: ["2028-05-25", 1, "e"], kaamatan: ["2028-05-30", 2, "e"], gawai: ["2028-06-01", 2, "e"],
      agong: ["2028-06-05", 1, "e"], maulid: ["2028-08-03", 1, "e"], merdeka: ["2028-08-31", 1, "e"],
      malaysia_day: ["2028-09-16", 1, "e"], deepavali: ["2028-10-17", 1, "e"], christmas: ["2028-12-25", 1, "e"],
    },
  };

  // Spec order: breaks ties (rule 5).
  const ORDER = ["newyear", "thaipusam", "cny", "ramadan", "nuzul", "raya", "labour", "wesak", "kaamatan",
    "gawai", "agong", "haji", "muharram", "merdeka", "malaysia_day", "maulid", "deepavali", "christmas"];
  const STATE = new Set(["kaamatan", "gawai"]);
  const BACKDROP = new Set(["ramadan", "merdeka", "malaysia_day"]);
  // Quiet days of their own: no party mood, no confetti. The Islamic holy
  // days (spec), and Thaipusam and Wesak, which are religious observances too.
  const CALM_LOOKS = new Set(["ramadan", "nuzul", "haji", "muharram", "maulid", "thaipusam", "wesak"]);
  const LOOKS = ["newyear", "thaipusam", "cny", "ramadan", "nuzul", "raya", "labour", "wesak", "kaamatan", "gawai",
    "agong", "haji", "muharram", "merdeka", "maulid", "deepavali", "christmas", "kongsi_raya", "deepa_raya", "festive"];

  /* ---- dates as whole UTC days ---- */
  const DAY = 864e5;
  const dayOf = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  function toIso(date) {
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
    const d = date instanceof Date ? date : new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /* ---- after the table: Intl calendars ---- */
  const calCache = {};
  function calendarDays(cal, year) {
    const k = `${cal}:${year}`;
    if (calCache[k]) return calCache[k];
    const out = [];
    try {
      const f = new Intl.DateTimeFormat(`en-u-ca-${cal}`, { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
      if (f.resolvedOptions().calendar !== cal) return (calCache[k] = out);
      const first = Date.UTC(year, 0, 1) / DAY, last = Date.UTC(year, 11, 31) / DAY;
      for (let n = first; n <= last; n++) {
        const p = {};
        for (const part of f.formatToParts(new Date(n * DAY))) p[part.type] = part.value;
        out.push({ n, m: p.month, d: Number(p.day) });
      }
    } catch (_) { /* no Intl calendars: those seasons are skipped */ }
    return (calCache[k] = out);
  }
  function fallbackYear(year) {
    const h = {};
    const add = (id, n, days) => { (h[id] = h[id] || []).push([isoOf(n), days, "x"]); };
    const fixed = (id, m, d, days) => add(id, Date.UTC(year, m - 1, d) / DAY, days);
    fixed("newyear", 1, 1, 1); fixed("labour", 5, 1, 1); fixed("kaamatan", 5, 30, 2); fixed("gawai", 6, 1, 2);
    fixed("merdeka", 8, 31, 1); fixed("malaysia_day", 9, 16, 1); fixed("christmas", 12, 25, 1);
    // Agong's Birthday: the first Monday of June (the current convention).
    const jun1 = Date.UTC(year, 5, 1) / DAY;
    add("agong", jun1 + ((8 - new Date(jun1 * DAY).getUTCDay()) % 7), 1);
    const isl = { "9/1": ["ramadan", 0], "9/17": ["nuzul", 1], "10/1": ["raya", 2], "12/10": ["haji", 1], "1/1": ["muharram", 1], "3/12": ["maulid", 1] };
    for (const x of calendarDays("islamic-umalqura", year)) {
      const hit = isl[`${x.m}/${x.d}`];
      if (hit) add(hit[0], x.n, hit[1]);
    }
    for (const x of calendarDays("chinese", year)) if (x.m === "1" && x.d === 1) add("cny", x.n, 2);
    return h;
  }
  function holidaysOf(year, table) {
    const t = table || KIRA_HOLIDAYS;
    if (t[year]) {
      const h = {};
      for (const [id, row] of Object.entries(t[year])) h[id] = [row];
      return h;
    }
    return fallbackYear(year);
  }
  const lastTableYear = (table) => Math.max(...Object.keys(table || KIRA_HOLIDAYS).map(Number));

  /* ---- windows ---- */
  function windowsAround(year, table) {
    const list = [];
    const raw = [];
    for (const y of [year - 1, year, year + 1]) {
      const h = holidaysOf(y, table);
      for (const [id, rows] of Object.entries(h)) for (const r of rows) raw.push({ id, start: dayOf(r[0]), days: r[1], status: r[2] });
    }
    raw.sort((a, b) => a.start - b.start);
    for (const r of raw) {
      const s = r.start;
      const w = { id: r.id, start: s, hFrom: s, hTo: s + Math.max(1, r.days) - 1, from: s, to: s + Math.max(1, r.days) - 1, status: r.status };
      switch (r.id) {
        case "newyear": w.from = s - 1; w.to = s + 1; break;
        case "thaipusam": case "wesak": w.from = s - 1; w.to = s + 1; break;
        case "cny": w.from = s - 3; w.to = s + 14; w.strongTo = s + 1; break;
        case "raya": w.from = s - 1; w.to = s + 14; w.strongTo = s + 2; break;
        case "haji": w.from = s - 1; w.to = s + 3; break;
        case "deepavali": w.from = s - 3; w.to = s + 3; break;
        case "christmas": w.from = s - 5; w.to = s + 1; break;
        case "ramadan": {
          // 1 Ramadan to the day before Raya; it is no holiday day of its own.
          const raya = raw.find((x) => x.id === "raya" && x.start > s);
          w.to = raya ? raya.start - 1 : s + 28;
          w.hFrom = 1; w.hTo = 0;
          break;
        }
        case "merdeka": { // Bulan Kebangsaan: 1 Aug to 31 Aug
          const [yy] = isoOf(s).split("-");
          w.from = dayOf(`${yy}-08-01`); w.to = s; w.strongTo = s; w.strongFrom = s;
          break;
        }
        case "malaysia_day": // 1 Sep to 16 Sep
          w.from = s - 15; w.to = s; w.strongFrom = s; w.strongTo = s;
          break;
        default: break;
      }
      list.push(w);
    }
    return list;
  }

  function seasonFor(date, opts) {
    const o = opts || {};
    const iso = toIso(date);
    const d = dayOf(iso);
    const year = Number(iso.slice(0, 4));
    const all = windowsAround(year, o.table).filter((w) => d >= w.from && d <= w.to);
    if (!all.length) return null;
    const isHol = (w) => d >= w.hFrom && d <= w.hTo;
    const ramadan = all.find((w) => w.id === "ramadan");
    const flagSeason = all.find((w) => w.id === "merdeka" || w.id === "malaysia_day");
    let cands = all.filter((w) => !BACKDROP.has(w.id));
    // Merdeka / Malaysia Day on the day itself competes like any holiday day.
    if (flagSeason && isHol(flagSeason)) cands.push(flagSeason);

    // Rule 4: national beats state.
    let shared = null;
    const nationalToday = cands.filter((w) => !STATE.has(w.id) && isHol(w));
    if (nationalToday.length) {
      const stateFirst = cands.find((w) => STATE.has(w.id) && d === w.hFrom);
      if (stateFirst) shared = [pick(nationalToday, d), stateFirst];
      cands = cands.filter((w) => !STATE.has(w.id));
    }

    let win = shared ? shared[0] : pick(cands, d);
    let id, look, names, start;
    if (shared) {
      id = "shared"; look = "festive"; names = [shared[0].id, shared[1].id]; start = d;
    } else if (win) {
      id = win.id; look = win.id === "malaysia_day" ? "merdeka" : win.id; names = [win.id]; start = win.start;
      // Rule 3: combined seasons.
      const other = (x) => cands.find((w) => w.id === x);
      if ((win.id === "raya" && other("cny")) || (win.id === "cny" && other("raya"))) {
        const r = other("raya"); id = "kongsi_raya"; look = "kongsi_raya"; names = ["raya", "cny"]; start = r.start;
      } else if ((win.id === "raya" && other("deepavali")) || (win.id === "deepavali" && other("raya"))) {
        const r = other("raya"); id = "deepa_raya"; look = "deepa_raya"; names = ["raya", "deepavali"]; start = r.start;
      }
      // Nuzul Al-Quran is part of Ramadan: Ramadan's greeting, an extra star.
      if (win.id === "nuzul" && ramadan) { id = "ramadan"; names = ["ramadan"]; start = ramadan.start; }
    } else if (ramadan) {
      win = ramadan; id = "ramadan"; look = "ramadan"; names = ["ramadan"]; start = ramadan.start;
    } else if (flagSeason) {
      win = flagSeason; id = flagSeason.id; look = "merdeka"; names = [flagSeason.id]; start = flagSeason.start;
    } else {
      return null;
    }

    // Rule 2: Ramadan calms whatever is on; the greeting may name both.
    const calm = !!ramadan || CALM_LOOKS.has(look);
    // (Raya's eve is still Ramadan: calm, but the greeting is Raya's alone.)
    if (ramadan && id !== "ramadan" && !names.includes("raya")) names = names.concat("ramadan");
    let flag = null;
    if (look === "merdeka") flag = isHol(win) ? "big" : "normal";
    else if (flagSeason) flag = "small";
    const strong = !!win && ((win.strongTo != null && d >= (win.strongFrom != null ? win.strongFrom : win.start) && d <= win.strongTo));
    return {
      id, look, calm, flag, strong,
      holiday: !!win && isHol(win),
      names,
      key: `${id}-${isoOf(start)}`,
      start: isoOf(start),
      date: iso,
      expected: !!win && win.status !== "g",
    };
  }

  // Rule 1 then rule 5: holiday days first, then the nearest first day, then ORDER.
  function pick(list, d) {
    if (!list.length) return null;
    return list.slice().sort((a, b) => {
      const ha = d >= a.hFrom && d <= a.hTo ? 0 : 1, hb = d >= b.hFrom && d <= b.hTo ? 0 : 1;
      if (ha !== hb) return ha - hb;
      const da = Math.abs(d - a.start), db = Math.abs(d - b.start);
      if (da !== db) return da - db;
      return ORDER.indexOf(a.id) - ORDER.indexOf(b.id);
    })[0];
  }

  /* ---------- Props ----------
     Kira's drawing is 64 units wide; the paper is x 7–57, y 5–65. Slots:
       head    on top of the paper's top edge (y −10…8), centred
       topL    beside the head, top left (x 0–17, y −9…5)
       hand    leaning on the right edge, low (x 54–64, y 46–66)
       ground  beside the feet, left (x 0–12, y 64–82); groundR on the right
       under   under the feet (y 69–81), behind nothing
     Colours are classes (kf-*) set in styles.css ("Kira festive"). */
  const f2 = (n) => Math.round(n * 100) / 100;
  function starPath(cx, cy, R, r, n) {
    let p = "";
    for (let i = 0; i < n * 2; i++) {
      const rad = (i % 2 ? r : R), a = -Math.PI / 2 + (i * Math.PI) / n;
      p += `${i ? "L" : "M"}${f2(cx + rad * Math.cos(a))} ${f2(cy + rad * Math.sin(a))}`;
    }
    return p + "z";
  }
  // A crescent opening to the right: circle (cx, cy, R) less a circle
  // shifted right by 0.35R with radius 0.82R.
  function crescentPath(cx, cy, R) {
    const dd = 0.35 * R, r = 0.82 * R;
    const x = (dd * dd + R * R - r * r) / (2 * dd), y = Math.sqrt(R * R - x * x);
    return `M${f2(cx + x)} ${f2(cy - y)}A${f2(R)} ${f2(R)} 0 1 0 ${f2(cx + x)} ${f2(cy + y)}A${f2(r)} ${f2(r)} 0 1 1 ${f2(cx + x)} ${f2(cy - y)}z`;
  }
  // The Jalur Gemilang: 14 red and white stripes, a blue canton over the top
  // eight, a yellow crescent and 14-point star. Hoist (pole) on the left.
  function flagSvg(x, y, w, pole) {
    const h = w / 2, s = h / 14;
    let o = `<g class="kf-flag">`;
    if (pole) o += `<path class="kf-pole" d="M${f2(x)} ${f2(y - 1)}V${f2(y + pole)}"/>`;
    o += `<rect class="kf-flag-red" x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}"/>`;
    let wp = "";
    for (let i = 1; i < 14; i += 2) wp += `M${f2(x)} ${f2(y + i * s)}h${f2(w)}v${f2(s)}h${f2(-w)}z`;
    o += `<path class="kf-flag-white" d="${wp}"/>`;
    const cw = w / 2, ch = s * 8;
    o += `<rect class="kf-flag-blue" x="${f2(x)}" y="${f2(y)}" width="${f2(cw)}" height="${f2(ch)}"/>`;
    const cy = y + ch / 2;
    o += `<path class="kf-flag-yellow" d="${crescentPath(x + cw * 0.36, cy, ch * 0.36)}"/>`;
    o += `<path class="kf-flag-yellow" d="${starPath(x + cw * 0.7, cy, ch * 0.3, ch * 0.13, 14)}"/>`;
    return o + "</g>";
  }
  const P = {
    partyHat: '<g class="kf-hat"><path class="kf-gold" d="M25 6.5L32-8.5l7 15z"/><path class="kf-red-line" d="M27.2 2l8.6-3.4M29.6-3.2l4.6-1.8"/><circle class="kf-red" cx="32" cy="-9" r="2.3"/></g>',
    songkok: '<g class="kf-hat"><path class="kf-songkok" d="M18.6 7.6L20-2.6Q32-5.4 44-2.6l1.4 10.2Q32 5.3 18.6 7.6z"/><path class="kf-songkok-hi" d="M21.2-0.6Q32-2.9 42.8-0.6"/></g>',
    santa: '<g class="kf-hat"><path class="kf-santa" d="M18.5 6Q19-8 35-8.6q12-.4 19.4 9.4-5.6-3.4-10.6-2.6Q47 2 46.5 6z"/>' +
      '<rect class="kf-fur" x="15.6" y="2.4" width="33" height="6.2" rx="3.1"/><circle class="kf-fur" cx="54.6" cy="1.6" r="3.1"/></g>',
    hardHat: '<g class="kf-hat"><path class="kf-hardhat" d="M18.6 5.4Q18.6-7.4 32-7.4t13.4 12.8z"/><rect class="kf-hardhat" x="13.8" y="3.4" width="36.4" height="4.4" rx="2.2"/>' +
      '<path class="kf-hardhat-ridge" d="M32-7.2V4.6M25.6-5l1.4 9.6M38.4-5L37 4.6"/></g>',
    crown: '<g class="kf-hat"><path class="kf-gold" d="M21.6 6.6V-3.4l5.2 4.6L32-6.4l5.2 7.6 5.2-4.6v10z"/><path class="kf-gold-line" d="M21.8 3.6h20.4"/>' +
      '<circle class="kf-jewel" cx="32" cy="1.6" r="1.5"/><circle class="kf-white" cx="26.4" cy="2.8" r="0.9"/><circle class="kf-white" cx="37.6" cy="2.8" r="0.9"/></g>',
    crescent: (cls) => `<g class="kf-moon"><path class="${cls}" d="${crescentPath(7.4, -2, 5.4)}"/><path class="${cls}" d="${starPath(14.2, -2.6, 2.7, 1.15, 5)}"/></g>`,
    nuzulStar: `<path class="kf-gold kf-twinkle" d="${starPath(3.4, 7.2, 1.8, 0.8, 5)}"/>`,
    angPao: '<g class="kf-hand" transform="rotate(-8 59 52)"><rect class="kf-red" x="54.6" y="46.6" width="8.6" height="11.6" rx="1.2"/>' +
      '<path class="kf-gold-line" d="M54.9 49.2l4 2.6 4-2.6"/><circle class="kf-gold" cx="58.9" cy="54.4" r="1.4"/></g>',
    duitRaya: '<g class="kf-hand" transform="rotate(-10 59 52)"><rect class="kf-green" x="54" y="47.6" width="10" height="7.2" rx="1"/>' +
      '<path class="kf-gold-line" d="M54.3 48l4.7 3.4 4.7-3.4"/><path class="kf-gold" d="M59 51.8l1.2 1.2-1.2 1.2-1.2-1.2z"/></g>',
    lantern: '<g class="kf-hand"><path class="kf-string" d="M59.6 45.6v3"/><rect class="kf-gold" x="57" y="48.2" width="5.2" height="1.6" rx="0.6"/>' +
      '<ellipse class="kf-red" cx="59.6" cy="54.2" rx="4.4" ry="4.8"/><path class="kf-gold-line" d="M59.6 49.6v9.2M56.3 51.2q-1.3 3 0 6M62.9 51.2q1.3 3 0 6"/>' +
      '<rect class="kf-gold" x="57" y="58.6" width="5.2" height="1.6" rx="0.6"/><path class="kf-tassel" d="M59.6 60.2v4"/></g>',
    garland: (cols) => {
      // Flowers or beads on a string, hanging from the hand.
      const pts = [[58.6, 47.4], [60.4, 50.6], [61.4, 54.2], [61, 57.8], [59.6, 61], [57.6, 63.6]];
      let s = '<g class="kf-hand"><path class="kf-string" d="M58.6 47.4Q62.6 54 57.6 63.6"/>';
      pts.forEach(([x, y], i) => { s += `<circle class="${cols[i % cols.length]}" cx="${x}" cy="${y}" r="${i % 2 ? 1.75 : 2.1}"/>`; });
      return s + "</g>";
    },
    mandarin: (x) => `<g class="kf-ground"><circle class="kf-orange" cx="${x}" cy="77" r="4.4"/><path class="kf-leaf" d="M${x} 72.8q2.4-3.2 5.2-1.8-2 2.8-5.2 1.8z"/><circle class="kf-orange-hi" cx="${x - 1.4}" cy="75.6" r="1"/></g>`,
    ketupat: (x) => `<g class="kf-ground"><path class="kf-leaf-line" d="M${x} 70.4q-.8-3-3-4.2M${x} 70.4q1.6-2.8 4.4-3.2"/>` +
      `<path class="kf-ketupat" d="M${x} 70.4l5.2 5.2-5.2 5.2-5.2-5.2z"/><path class="kf-ketupat-line" d="M${x - 2.6} 73l5.2 5.2M${x + 2.6} 73l-5.2 5.2M${x - 1.3} 71.7l4 4M${x + 1.3} 79.5l-4-4"/></g>`,
    pelita: (x) => `<g class="kf-ground"><path class="kf-flame kf-flicker" d="M${x} 65.2q2.6 3.4 0 6.6q-2.6-3.2 0-6.6z"/><path class="kf-wick" d="M${x} 71.6v1.4"/>` +
      `<rect class="kf-pelita" x="${x - 3}" y="73" width="6" height="8.4" rx="1.3"/><path class="kf-pelita-ring" d="M${x - 3} 76.2h6"/></g>`,
    diya: (x) => `<g class="kf-ground"><path class="kf-flame kf-flicker" d="M${x + 1.6} 66.4q2.7 3.6 0 7.2q-2.7-3.4 0-7.2z"/>` +
      `<path class="kf-diya" d="M${x - 5.2} 74h11.6l1.6-1.4q-1 7.6-7.2 7.6t-6-6.2z"/><path class="kf-diya-hi" d="M${x - 3.4} 76.4q3.4 1.6 6.8 0"/></g>`,
    lotus: (x) => `<g class="kf-ground"><ellipse class="kf-leaf" cx="${x}" cy="80" rx="5.8" ry="1.6"/>` +
      `<path class="kf-lotus-2" d="M${x} 79q-6-.6-5.6-6.2 3.6 1 5.6 6.2zM${x} 79q6-.6 5.6-6.2-3.6 1-5.6 6.2z"/>` +
      `<path class="kf-lotus" d="M${x} 79q-3.2-4.4 0-9.6 3.2 5.2 0 9.6z"/></g>`,
    kolam: () => {
      let s = '<g class="kf-under">';
      const rows = [[72, [32]], [75.2, [25.6, 32, 38.4]], [78.4, [19.2, 25.6, 32, 38.4, 44.8]]];
      rows.forEach(([y, xs], ri) => xs.forEach((x, i) => { s += `<circle class="${(ri + i) % 2 ? "kf-kolam-2" : "kf-kolam"}" cx="${x}" cy="${y}" r="1.05"/>`; }));
      s += '<path class="kf-kolam-line" d="M17 78.4q15-12 30 0M22 79.6q10-6.4 20 0"/>';
      return s + "</g>";
    },
    bunting: () => {
      let s = '<g class="kf-hat kf-bunting"><path class="kf-string" d="M4-4.6Q32 3.4 60-4.6"/>';
      const xs = [9, 17.6, 26.4, 35.2, 44, 52.6];
      const cls = ["kf-b1", "kf-b2", "kf-b3", "kf-b4", "kf-b1", "kf-b2"];
      xs.forEach((x, i) => {
        const yy = -4.6 + 8 * (1 - Math.pow((x - 32) / 28, 2)) * 0.98;
        s += `<path class="${cls[i]}" d="M${f2(x - 3)} ${f2(yy - 0.6)}h6l-3 5.2z"/>`;
      });
      return s + "</g>";
    },
  };
  const KAVADI = ["kf-saffron", "kf-marigold", "kf-teal", "kf-magenta"];
  const BEADS_K = ["kf-bead-r", "kf-bead-y", "kf-bead-k", "kf-bead-w"];
  const BEADS_G = ["kf-bead-y", "kf-bead-r", "kf-bead-w", "kf-bead-k"];

  // { head, topL, hand, ground, groundR, under } for a look, calm or not.
  function parts(look, calm, strong) {
    switch (look) {
      case "newyear": return calm ? { topL: `<path class="kf-gold" d="${starPath(8, -2, 4.2, 1.8, 5)}"/>` } : { head: P.partyHat };
      case "thaipusam": return { hand: P.garland(KAVADI) };
      case "cny": return calm ? { hand: P.lantern } : { hand: P.angPao, ground: P.mandarin(5.6), groundR: strong ? P.mandarin(59) : "" };
      case "ramadan": return { topL: P.crescent("kf-gold"), ground: P.pelita(5.4) };
      case "nuzul": return { topL: P.crescent("kf-gold") + P.nuzulStar, ground: P.pelita(5.4) };
      case "raya": return calm ? { head: P.songkok, hand: P.duitRaya, ground: P.pelita(5.4) }
        : { head: P.songkok, hand: P.duitRaya, ground: P.ketupat(5.6), groundR: strong ? P.ketupat(58.6) : "" };
      case "kongsi_raya": return calm ? { head: P.songkok, hand: P.angPao, ground: P.pelita(5.4) }
        : { head: P.songkok, hand: P.angPao, ground: P.ketupat(5.6), groundR: P.mandarin(59) };
      case "deepa_raya": return calm ? { head: P.songkok, ground: P.diya(6), under: P.kolam() }
        : { head: P.songkok, ground: P.ketupat(5.6), groundR: P.diya(58), under: P.kolam() };
      case "labour": return { head: P.hardHat };
      case "wesak": return { ground: P.lotus(6) };
      case "kaamatan": return { hand: P.garland(BEADS_K) };
      case "gawai": return { hand: P.garland(BEADS_G) };
      case "festive": return calm ? { hand: P.garland(BEADS_K) } : { head: P.bunting(), hand: P.garland(BEADS_G) };
      case "agong": return { head: P.crown };
      case "haji": case "muharram": return { topL: P.crescent("kf-gold") };
      case "maulid": return { topL: P.crescent("kf-green") };
      case "merdeka": return {};
      case "deepavali": return { ground: P.diya(6), under: P.kolam() };
      case "christmas": return { head: P.santa };
      default: return {};
    }
  }

  function props(season) {
    if (!season || !season.look) return { under: "", inner: "", front: "", head: false };
    const p = parts(season.look, !!season.calm, !!season.strong);
    let topL = p.topL || "", ground = p.ground || "", groundR = p.groundR || "";
    let flag = "";
    if (season.flag === "normal" || season.flag === "big") {
      // Held up beside Kira, top left: the pole runs down past the paper's edge.
      flag = season.flag === "big" ? flagSvg(2.6, -10, 24, 70) : flagSvg(2.6, -8, 20, 66);
    } else if (season.flag === "small") {
      // A table flag planted beside the feet; whatever stood there moves right.
      flag = flagSvg(1.6, 66.4, 12, 14.6);
      if (ground) { groundR = groundR || shiftX(ground, 52.8); ground = ""; }
    }
    return {
      under: p.under || "",
      inner: (p.head || "") + topL + (season.flag === "small" ? "" : flag) + (p.hand || ""),
      front: ground + groundR + (season.flag === "small" ? flag : ""),
      head: !!p.head,
    };
  }
  // Move a ground prop (drawn around x≈5.5) to the right of the feet.
  function shiftX(svg, dx) { return `<g transform="translate(${dx} 0)">${svg}</g>`; }

  function headOnly(season) {
    if (!season || !season.look) return "";
    const p = parts(season.look, !!season.calm, !!season.strong);
    return p.head || "";
  }

  root.KiraSeasons = {
    seasonFor, props, headOnly, LOOKS, ORDER, TABLE: KIRA_HOLIDAYS, CALM_LOOKS: [...CALM_LOOKS],
    lastTableYear, toIso, flagSvg, holidaysOf,
  };
})(typeof window !== "undefined" ? window : globalThis);
