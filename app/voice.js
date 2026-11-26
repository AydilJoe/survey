/* Duitful — Assistant Update Phases 2 & 3: Natural Voice & Sentence Entry + Compound Log & Split.
 *
 * Works completely offline on Web, iPhone, and Android using a deterministic
 * EN / BM / Manglish / ZH parser, and automatically upgrades to Cloud Gemini
 * (`window.aiCloudRun("voice-compound", ...)`) when Duitful AI+ is active.
 *
 * Privacy & safety rules:
 *   - Nothing is ever saved without the user's 1-tap confirmation.
 *   - Split math is always computed locally (never trusting AI arithmetic).
 *   - Split messages are never sent silently in the background; tapping
 *     "Save & send" saves the linked spend + split and opens Duitful's
 *     existing WhatsApp / Share sheet ready to tap Send.
 */

(function () {
  "use strict";

  const VOICE_CAT_KEYWORDS = [
    ["Food", /\b(nasi|lemak|goreng|mamak|kopi|teh|makan|lunch|dinner|breakfast|supper|food|coffee|cafe|starbucks|zus|mcd|kfc|burger|pizza|sushi|ramen|roti|mee|laksa|cendol|boba|tea|drink|snack|bakery|restaurant|kedai\s*kopi|hawker|tapau|bungkus)\b|[饭面茶咖啡吃餐食粉鸡鸭鱼]/i],
    ["Groceries", /\b(grocer|groceries|jaya\s*grocer|village\s*grocer|mydin|lotus|aeon|giant|econsave|99\s*speedmart|speedmart|kk\s*mart|market|pasar|sayur|buah|supermarket|mart)\b|[菜超市水果杂货]/i],
    ["Transport", /\b(grab|petrol|fuel|ron95|ron97|shell|petronas|caltex|bhp|tol|toll|tng\s*rfid|rfid|parking|parkir|mrt|lrt|ktm|erl|monorail|bus|bas|taxi|teksi|uber|flight|train|servicing|tyre|car\s*wash)\b|[油打油停车车费搭车]/i],
    ["Bills", /\b(tnb|electric|elektrik|air\s*selangor|water|syabas|unifi|time\s*fibre|maxis|celcom|digi|umobile|yes|wifi|internet|broadband|astro|netflix|spotify|icloud|youtube|bill|bil|rent|sewa|indah\s*water|cukai|assessment)\b|[电水网费账单房租]/i],
    ["Health", /\b(clinic|klinik|hospital|doctor|doktor|dentist|dental|pharmacy|farmasi|watsons|guardian|caring|ubat|medicine|vitamin|checkup|mc|physio|optical|spectacles)\b|[医诊所药牙科]/i],
    ["Shopping", /\b(shopee|lazada|tiktok\s*shop|uniqlo|h&m|zara|ikea|mr\s*diy|daiso|decathlon|padini|nike|adidas|clothes|baju|kasut|shoes|bag|beg|gift|hadiah|gadget|phone|laptop|shopping|beli)\b|[买购物衣服鞋]/i],
  ];

  // Spoken word → integer maps for Malay & English numbers.
  const WORD_NUMS = {
    zero: 0, kosong: 0,
    one: 1, satu: 1, se: 1, a: 1,
    two: 2, dua: 2,
    three: 3, tiga: 3,
    four: 4, empat: 4,
    five: 5, lima: 5,
    six: 6, enam: 6,
    seven: 7, tujuh: 7,
    eight: 8, lapan: 8,
    nine: 9, sembilan: 9,
    ten: 10, sepuluh: 10,
    eleven: 11, sebelas: 11,
    twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };

  const ZH_DIGITS = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };

  function voiceRound2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function parseChineseNumber(str) {
    const m = String(str || "").match(/([零一二两三四五六七八九十百千]+)\s*(?:块|元|令吉|马币)(?:\s*([零一二两三四五六七八九])(?:毛|角)?)?/);
    if (!m) return null;
    const parseIntZh = (s) => {
      let total = 0, cur = 0;
      for (const ch of s) {
        if (ch in ZH_DIGITS) cur = ZH_DIGITS[ch];
        else if (ch === "十") { total += (cur || 1) * 10; cur = 0; }
        else if (ch === "百") { total += (cur || 1) * 100; cur = 0; }
        else if (ch === "千") { total += (cur || 1) * 1000; cur = 0; }
      }
      return total + cur;
    };
    const whole = parseIntZh(m[1]);
    const tenths = m[2] ? (ZH_DIGITS[m[2]] || 0) * 0.1 : 0;
    const val = voiceRound2(whole + tenths);
    return val > 0 ? { value: val, matched: m[0] } : null;
  }

  function parseWordChunk(tokens) {
    let total = 0, current = 0, used = 0;
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      if (w === "and" || w === "dan") { if (used) continue; else break; }
      if (w === "belas") {
        if (current >= 1 && current <= 9) { current += 10; used++; continue; }
        break;
      }
      if (w === "puluh") {
        current = (current || 1) * 10;
        used++;
        continue;
      }
      if (w === "ratus" || w === "hundred") {
        current = (current || 1) * 100;
        used++;
        continue;
      }
      if (w === "seratus") { current += 100; used++; continue; }
      if (w === "ribu" || w === "thousand") {
        total += (current || 1) * 1000;
        current = 0;
        used++;
        continue;
      }
      if (w === "seribu") { total += 1000; used++; continue; }
      if (w in WORD_NUMS) {
        current += WORD_NUMS[w];
        used++;
        continue;
      }
      break;
    }
    return used ? total + current : null;
  }

  function voiceParseSpokenNumber(text) {
    const raw = String(text || "");
    const zh = parseChineseNumber(raw);
    if (zh) return zh;

    const lower = raw.toLowerCase();
    const tokens = lower.match(/[a-z]+/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      const n = parseWordChunk(tokens.slice(i));
      if (n == null || n <= 0) continue;
      // Count how many tokens were consumed from index i.
      let j = i;
      while (j < tokens.length && (
        tokens[j] in WORD_NUMS || tokens[j] === "belas" || tokens[j] === "puluh"
        || tokens[j] === "ratus" || tokens[j] === "seratus" || tokens[j] === "hundred"
        || tokens[j] === "ribu" || tokens[j] === "seribu" || tokens[j] === "thousand"
        || (j > i && (tokens[j] === "and" || tokens[j] === "dan"))
      )) j++;
      const next = tokens[j] || "";
      let val = n;
      let endIdx = j;
      if (next === "ringgit" || next === "rm" || next === "myr" || next === "dollars" || next === "bucks") {
        endIdx = j + 1;
        // Optional cents: "... lima puluh sen" / "... fifty cents"
        const senVal = parseWordChunk(tokens.slice(endIdx));
        if (senVal != null && senVal > 0 && senVal < 100) {
          let k = endIdx;
          while (k < tokens.length && (tokens[k] in WORD_NUMS || tokens[k] === "belas" || tokens[k] === "puluh")) k++;
          if (tokens[k] === "sen" || tokens[k] === "cents" || tokens[k] === "cent") {
            val = voiceRound2(n + senVal / 100);
            endIdx = k + 1;
          }
        }
        return { value: val, matched: tokens.slice(i, endIdx).join(" ") };
      }
    }
    return null;
  }

  function voiceMatchContacts(names, knownContacts) {
    const known = Array.isArray(knownContacts) ? knownContacts.filter(Boolean) : [];
    const seen = new Set();
    const out = [];
    for (const raw of names) {
      const cleaned = String(raw || "")
        .replace(/^(?:from|with|to|dari|daripada|dengan|sama|向|和|跟)\s+/i, "")
        .replace(/[.,!?]+$/g, "")
        .trim();
      if (!cleaned || cleaned.length > 40) continue;
      if (/^(me|myself|saya|aku|half|separuh|equal|equally|duitful|it|them|him|her)$/i.test(cleaned)) continue;
      const hit = known.find((k) => k.toLowerCase() === cleaned.toLowerCase());
      const finalName = hit || (cleaned.charAt(0).toUpperCase() + cleaned.slice(1));
      const key = finalName.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(finalName);
      }
    }
    return out;
  }

  function parsePeopleList(chunk, knownContacts) {
    const parts = String(chunk || "")
      .replace(/\b(?:using|pakai|via|with|on|in|di)\s+.*$/i, "")
      .split(/\s*(?:,|&|\band\b|\bdan\b|\bsama\b|和|跟)\s*/i);
    return voiceMatchContacts(parts, knownContacts);
  }

  function voiceExtractSplit(text, totalAmount, knownContacts) {
    const raw = String(text || "");
    // 1. Explicit exact request: "request RM 20 from Ali" / "minta RM 20 dari Ali"
    const exactRe = /\b(?:request|ask|charge|minta|claim)\s+(?:rm|myr|\$)?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:ringgit|rm|myr)?\s+(?:from|dari|daripada)\s+([a-zA-Z\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff\s,&-]{0,60})/i;
    const exactM = raw.match(exactRe);
    if (exactM) {
      const amt = voiceRound2(Number(exactM[1].replace(",", "")));
      const people = parsePeopleList(exactM[2], knownContacts);
      if (amt > 0 && people.length) {
        const share = totalAmount > 0 ? Math.min(amt, totalAmount) : amt;
        return {
          mode: "exact",
          people: people.map((name) => ({ name, amount: share })),
          matched: exactM[0],
        };
      }
    }

    // 2. Half / fraction: "split half with Ali", "half of the amount request from Ali", "request half from Ali", "bahagi dua dengan Ali"
    const halfRe = /(?:(?:and|dan|,)\s*)?(?:(?:split|bahagi|kongsi)\s+(?:half|50%|dua|separuh)\s+(?:with|from|dengan|sama)|(?:half(?:\s+of\s+(?:the\s+)?(?:amount|it|bill))?|separuh)\s*(?:request|ask|minta|split|bahagi)?\s*(?:from|with|dari|daripada|dengan)|(?:request|ask|minta)\s+(?:half|separuh)\s+(?:from|dari|daripada))\s+([a-zA-Z\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff\s,&-]{0,60})/i;
    const halfM = raw.match(halfRe);
    if (halfM) {
      const people = parsePeopleList(halfM[1], knownContacts);
      if (people.length) {
        const share = totalAmount > 0 ? voiceRound2((totalAmount * 0.5) / people.length) : 0;
        return {
          mode: "fraction",
          fraction: 0.5,
          people: people.map((name) => ({ name, amount: share })),
          matched: halfM[0],
        };
      }
    }

    // 3. General equal split: "split with Ali and Siti", "bahagi dengan Ali"
    const equalRe = /(?:(?:and|dan|,)\s*)?(?:split(?:\s+(?:it|the\s+bill|equally))?|bahagi(?:\s+sama\s+rata)?|kongsi)\s+(?:with|dengan|sama)\s+([a-zA-Z\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff\s,&-]{0,60})/i;
    const equalM = raw.match(equalRe);
    if (equalM) {
      const people = parsePeopleList(equalM[1], knownContacts);
      if (people.length) {
        const share = totalAmount > 0 ? voiceRound2(totalAmount / (people.length + 1)) : 0;
        return {
          mode: "equal",
          people: people.map((name) => ({ name, amount: share })),
          matched: equalM[0],
        };
      }
    }

    return null;
  }

  function voiceMatchWallet(text, wallets) {
    const list = Array.isArray(wallets) ? wallets : [];
    if (!list.length) return null;
    const lower = String(text || "").toLowerCase();
    // Explicit cue first: "pakai MAE" / "using TNG" / "via GrabPay" / "用MAE"
    const cue = lower.match(/(?:\b(?:pakai|guna|using|with|via|by|on)\s+|用\s*)([a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff\s-]{0,24})/i);
    if (cue) {
      const candidate = cue[1].trim();
      for (const w of list) {
        const wn = String((w && w.name) || "").trim();
        if (!wn) continue;
        if (candidate === wn.toLowerCase() || candidate.startsWith(wn.toLowerCase() + " ")) {
          return { wallet: w, matched: cue[0].slice(0, cue[0].toLowerCase().indexOf(wn.toLowerCase()) + wn.length) };
        }
      }
    }
    // Fallback: whole-word match of any wallet name.
    for (const w of list) {
      const wn = String((w && w.name) || "").trim();
      if (!wn || wn.length < 2) continue;
      const esc = wn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\b)${esc}(?:\\b|$)`, "i");
      const m = String(text || "").match(re);
      if (m) return { wallet: w, matched: m[0] };
    }
    return null;
  }

  function voiceInferCategory(text) {
    const s = String(text || "");
    for (const [cat, re] of VOICE_CAT_KEYWORDS) {
      if (re.test(s)) return cat;
    }
    return "Others";
  }

  /**
   * Pure deterministic parser for EN / BM / Manglish / ZH voice sentences.
   * Returns { raw, amount, category, note, walletId, walletName, split, source }.
   */
  function parseVoiceSentence(rawText, opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const wallets = Array.isArray(o.wallets) ? o.wallets : (typeof state === "object" && state && Array.isArray(state.wallets) ? state.wallets : []);
    const contacts = Array.isArray(o.contacts) ? o.contacts : voiceKnownContacts();
    const raw = String(rawText || "").trim();
    if (!raw) {
      return { raw: "", amount: 0, category: "Others", note: "", walletId: "", walletName: "", split: null, source: "local" };
    }

    // 1. Extract split clause first so an explicit request amount ("request RM 20 from Ali")
    //    doesn't confuse the primary spend amount if written after it.
    let work = raw;
    let amount = 0;
    let amountMatch = "";

    // Numeric amount (supports RM 40, RM40.50, $12, 40 ringgit, 40块, or standalone number).
    const numRe = /(?:(?:rm|myr|\$)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?))|(?:(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:ringgit|rm|myr|bucks|dollars|块|元|令吉))/i;
    const numM = work.match(numRe);
    if (numM) {
      amount = voiceRound2(Number((numM[1] || numM[2]).replace(/,/g, "")));
      amountMatch = numM[0];
    } else {
      const spoken = voiceParseSpokenNumber(work);
      if (spoken) {
        amount = spoken.value;
        amountMatch = spoken.matched;
      } else {
        const bare = work.match(/\b(\d+(?:\.\d{1,2})?)\b/);
        if (bare) {
          amount = voiceRound2(Number(bare[1]));
          amountMatch = bare[0];
        }
      }
    }

    const split = voiceExtractSplit(work, amount, contacts);
    if (split && split.matched) {
      work = work.replace(split.matched, " ");
    }
    if (amountMatch) {
      work = work.replace(amountMatch, " ");
    }

    const wHit = voiceMatchWallet(work, wallets);
    if (wHit && wHit.matched) {
      work = work.replace(new RegExp(wHit.matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
    }

    const category = voiceInferCategory(work + " " + raw);

    // Strip leading command boilerplate ("log my", "add", "rekod", "belanja", "spent") to leave a clean note.
    let note = work
      .replace(/^\s*(?:please\s+)?(?:log|add|record|track|spent|spend|paid|pay|beli|belanja|rekod|tambah|记一笔|花了|买了)\b\s*/i, "")
      .replace(/^\s*(?:my|for|on|at|untuk|di|saya)\b\s*/i, "")
      .replace(/\b(?:spending|expense|expenses|in\s+duitful|dalam\s+duitful|and|dan)\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
      .trim();
    if (note) note = note.charAt(0).toUpperCase() + note.slice(1);
    else if (category !== "Others") note = category;

    return {
      raw,
      amount,
      category,
      note: note.slice(0, 80),
      walletId: wHit ? wHit.wallet.id : "",
      walletName: wHit ? wHit.wallet.name : "",
      split,
      source: "local",
    };
  }

  function voiceKnownContacts() {
    const names = new Set();
    try {
      if (typeof state === "object" && state && state.split) {
        for (const n of (state.split.people || [])) if (typeof n === "string" && n.trim()) names.add(n.trim());
        for (const r of (state.split.out || [])) {
          for (const p of (r && r.people || [])) if (p && p.name) names.add(String(p.name).trim());
        }
      }
    } catch {}
    return [...names];
  }

  /**
   * Optional Cloud AI+ upgrade (Duitful AI+ / Gemini 2.5 Flash-Lite).
   * Always verifies split math locally; falls back cleanly to parseVoiceSentence.
   */
  async function parseVoiceSmart(rawText) {
    const local = parseVoiceSentence(rawText);
    if (!rawText || typeof window.aiCloudRun !== "function") return local;
    try {
      const wallets = (state && Array.isArray(state.wallets) ? state.wallets : []).map((w) => w.name).filter(Boolean);
      const categories = typeof scanAllCategories === "function" ? scanAllCategories() : [];
      const res = await window.aiCloudRun("voice-entry", {
        sentence: String(rawText).slice(0, 200),
        categories: categories.slice(0, 60),
        wallets: wallets.slice(0, 40),
        people: voiceKnownContacts().slice(0, 30),
      });
      if (!res || typeof res !== "object") return local;
      const amt = Number(res.amount) > 0 ? voiceRound2(res.amount) : local.amount;
      if (!(amt > 0)) return local;
      const cat = typeof res.category === "string" && res.category.trim() ? res.category.trim() : local.category;
      const note = typeof res.note === "string" && res.note.trim() ? res.note.trim().slice(0, 80) : local.note;
      const wName = res.wallet || res.walletHint || "";
      const wHit = wName ? voiceMatchWallet("using " + wName, state && state.wallets) : null;
      let split = local.split;
      if (res.split && Array.isArray(res.split.people) && res.split.people.length) {
        const rawPeople = res.split.people.map((p) => (typeof p === "string" ? p : (p && p.name) || "")).filter(Boolean);
        const people = voiceMatchContacts(rawPeople, voiceKnownContacts());
        if (people.length) {
          // Local math verification: NEVER trust AI arithmetic.
          let share = 0;
          if (res.split.mode === "fraction" && Number(res.split.fraction) > 0 && Number(res.split.fraction) < 1) {
            share = voiceRound2((amt * Number(res.split.fraction)) / people.length);
          } else if (res.split.mode === "exact" && Number(res.split.amount) > 0) {
            share = Math.min(amt, voiceRound2(Number(res.split.amount)));
          } else {
            share = voiceRound2(amt / (people.length + 1));
          }
          split = {
            mode: res.split.mode || "equal",
            people: people.map((name) => ({ name, amount: share })),
            matched: "",
          };
        }
      }
      return {
        raw: rawText,
        amount: amt,
        category: cat,
        note,
        walletId: wHit ? wHit.wallet.id : local.walletId,
        walletName: wHit ? wHit.wallet.name : local.walletName,
        split,
        source: "cloud-ai",
      };
    } catch {
      return local;
    }
  }

  /* ---------- UI: #voice-dialog & Home mic button ---------- */

  let voiceCurrent = null;
  let voiceRec = null;

  function voiceSpeechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function voiceStopListening() {
    if (voiceRec) {
      try { voiceRec.stop(); } catch {}
      voiceRec = null;
    }
    const btn = document.getElementById("voice-mic-btn");
    if (btn) {
      btn.classList.remove("is-listening");
      btn.setAttribute("aria-pressed", "false");
    }
  }

  function renderVoicePreview(parsed) {
    voiceCurrent = parsed;
    const box = document.getElementById("voice-preview");
    const spendLine = document.getElementById("voice-preview-spend");
    const splitBox = document.getElementById("voice-preview-split");
    const saveBtn = document.getElementById("voice-save");
    const hint = document.getElementById("voice-hint");
    if (!box || !spendLine || !saveBtn) return;

    if (!parsed || !(parsed.amount > 0)) {
      box.hidden = true;
      saveBtn.disabled = true;
      saveBtn.textContent = typeof tr === "function" ? tr("Save spend") : "Save spend";
      if (hint) hint.hidden = false;
      return;
    }

    if (hint) hint.hidden = true;
    box.hidden = false;
    saveBtn.disabled = false;

    const money = typeof fmtMoney === "function" ? fmtMoney(parsed.amount) : `RM ${parsed.amount.toFixed(2)}`;
    const catLabel = typeof tr === "function" ? tr(parsed.category) : parsed.category;
    const parts = [money, catLabel, parsed.note, parsed.walletName].filter(Boolean);
    spendLine.textContent = parts.join(" · ");

    if (splitBox) {
      if (parsed.split && parsed.split.people && parsed.split.people.length) {
        splitBox.hidden = false;
        const summary = parsed.split.people.map((p) => {
          const pm = typeof fmtMoney === "function" ? fmtMoney(p.amount) : `RM ${p.amount.toFixed(2)}`;
          return `${p.name} (${pm})`;
        }).join(", ");
        splitBox.textContent = (typeof tr === "function"
          ? tr("Split request: {list}", { list: summary })
          : `Split request: ${summary}`);
        const first = parsed.split.people[0].name;
        saveBtn.textContent = parsed.split.people.length === 1
          ? (typeof tr === "function" ? tr("Save & send to {name}", { name: first }) : `Save & send to ${first}`)
          : (typeof tr === "function" ? tr("Save & send split") : "Save & send split");
      } else {
        splitBox.hidden = true;
        splitBox.textContent = "";
        saveBtn.textContent = typeof tr === "function" ? tr("Save spend") : "Save spend";
      }
    }
  }

  function voiceSaveConfirmed() {
    const p = voiceCurrent;
    if (!p || !(p.amount > 0) || !state) return null;
    const date = typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10);
    const expense = {
      id: typeof uid === "function" ? uid() : `v-${Date.now()}`,
      date,
      amount: p.amount,
      category: p.category || "Others",
      note: p.note || p.category || "",
      kind: "expense",
      createdAt: Date.now(),
    };
    if (p.walletId) expense.walletId = p.walletId;
    state.dailyExpenses = state.dailyExpenses || [];
    state.dailyExpenses.push(expense);

    let splitRec = null;
    if (p.split && Array.isArray(p.split.people) && p.split.people.length && typeof coerceSplitOut === "function" && typeof splitOutList === "function") {
      splitRec = coerceSplitOut({
        id: typeof uid === "function" ? uid() : `vs-${Date.now()}`,
        kind: "split",
        title: p.note || p.category || "Split",
        date,
        total: p.amount,
        expenseId: expense.id,
        people: p.split.people.map((person) => ({
          id: typeof splitShortId === "function" ? splitShortId() : `p-${Math.random().toString(36).slice(2, 8)}`,
          name: person.name,
          amount: person.amount,
          status: "open",
          repayments: [],
        })),
      });
      splitOutList().push(splitRec);
      if (typeof splitRememberName === "function") {
        for (const person of splitRec.people) splitRememberName(person.name);
      }
    }

    if (typeof save === "function") save();
    if (typeof renderAll === "function") renderAll();

    const dlg = document.getElementById("voice-dialog");
    if (dlg && dlg.open) dlg.close();
    voiceStopListening();

    if (splitRec && typeof splitOpenShare === "function") {
      splitOpenShare(splitRec.id, 0).catch(() => {});
    } else if (typeof toast === "function") {
      const m = typeof fmtMoney === "function" ? fmtMoney(p.amount) : `RM ${p.amount.toFixed(2)}`;
      toast(tr("Saved {a}", { a: m }));
      // Kira hops on the toast, like a typed spend (kira.js).
      if (typeof kiraHop === "function") kiraHop();
    }
    return { expense, splitRec };
  }

  function openVoiceEntry(initialText) {
    const dlg = document.getElementById("voice-dialog");
    const input = document.getElementById("voice-input");
    const micBtn = document.getElementById("voice-mic-btn");
    if (!dlg || !input) return;
    if (micBtn) micBtn.hidden = !voiceSpeechCtor();
    input.value = String(initialText || "").trim();
    if (!dlg.open && typeof dlg.showModal === "function") dlg.showModal();
    if (input.value) {
      renderVoicePreview(parseVoiceSentence(input.value));
      parseVoiceSmart(input.value).then((smart) => {
        if (input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
      }).catch(() => {});
    } else {
      renderVoicePreview(null);
      setTimeout(() => { try { input.focus(); } catch {} }, 40);
    }
  }

  function initVoiceUI() {
    const openBtn = document.getElementById("btn-voice");
    const dlg = document.getElementById("voice-dialog");
    const input = document.getElementById("voice-input");
    const micBtn = document.getElementById("voice-mic-btn");
    const saveBtn = document.getElementById("voice-save");
    const cancelBtn = document.getElementById("voice-cancel");

    if (openBtn) openBtn.addEventListener("click", () => openVoiceEntry(""));
    if (cancelBtn) cancelBtn.addEventListener("click", () => { voiceStopListening(); if (dlg && dlg.open) dlg.close(); });
    if (dlg) dlg.addEventListener("close", () => voiceStopListening());

    if (input) {
      let timer = null;
      input.addEventListener("input", () => {
        const val = input.value;
        renderVoicePreview(parseVoiceSentence(val));
        clearTimeout(timer);
        if (val.trim().length >= 4 && typeof window.aiCloudRun === "function") {
          timer = setTimeout(() => {
            parseVoiceSmart(val).then((smart) => {
              if (input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
            }).catch(() => {});
          }, 450);
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && voiceCurrent && voiceCurrent.amount > 0) {
          e.preventDefault();
          voiceSaveConfirmed();
        }
      });
    }

    if (micBtn) {
      micBtn.addEventListener("click", () => {
        if (voiceRec) { voiceStopListening(); return; }
        const Ctor = voiceSpeechCtor();
        if (!Ctor) return;
        const rec = new Ctor();
        const lang = (window.I18N && window.I18N.lang) || "en";
        rec.lang = lang === "ms" ? "ms-MY" : lang === "zh" ? "zh-CN" : "en-MY";
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        voiceRec = rec;
        micBtn.classList.add("is-listening");
        micBtn.setAttribute("aria-pressed", "true");
        rec.onresult = (ev) => {
          const transcript = [...ev.results].map((r) => r[0].transcript).join(" ").trim();
          if (input) {
            input.value = transcript;
            renderVoicePreview(parseVoiceSentence(transcript));
          }
        };
        rec.onerror = () => voiceStopListening();
        rec.onend = () => {
          voiceStopListening();
          if (input && input.value.trim()) {
            parseVoiceSmart(input.value).then((smart) => {
              if (input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
            }).catch(() => {});
          }
        };
        try { rec.start(); } catch { voiceStopListening(); }
      });
    }

    if (saveBtn) saveBtn.addEventListener("click", () => voiceSaveConfirmed());
  }

  window.parseVoiceSentence = parseVoiceSentence;
  window.parseVoiceSmart = parseVoiceSmart;
  window.openVoiceEntry = openVoiceEntry;
  window.voiceSaveConfirmed = voiceSaveConfirmed;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVoiceUI);
  } else {
    initVoiceUI();
  }
})();
