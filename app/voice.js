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

  /* ---------- UI: #voice-dialog & Home mic button ----------
     Two ways to hear a spend (1.80.0, "Talk to Kira"):
       - native: inside the iPhone / Android app, DuitfulKit's speech methods
         (speechAvailable / speechStart / speechStop + "speechPartial"
         events). iPhone hears it on the phone only (a language that can't be
         is reported unavailable and the mic stays hidden); Android asks for
         its on-device recogniser first. WebViews don't have Web Speech, so
         inside the app this is the only path.
       - web: the browser's Web Speech API, where the browser has one.
     Partial text fills the box as it comes; the final text runs the same
     parse (and AI+, when on) as typing. A refused microphone shows one line
     and the keyboard still works. Holding Kira on Home opens the sheet
     already listening; letting go stops and shows the preview. */

  let voiceCurrent = null;
  let voiceRec = null;
  let voiceNative = null;
  let voiceStarting = null;
  let voiceHearTimer = 0;
  const voiceNativeCache = {};

  function voiceSpeechCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function voiceT(s, vars) {
    return typeof tr === "function" ? tr(s, vars) : s;
  }

  // The recogniser's language: the app's, as a BCP-47 tag.
  function voiceLangTag() {
    const lang = (window.I18N && window.I18N.lang) || "en";
    return lang === "ms" ? "ms-MY" : lang === "zh" ? "zh-CN" : "en-MY";
  }

  function voiceInShell() {
    try {
      return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
    } catch { return false; }
  }

  function voiceKit() {
    if (typeof duitfulKit !== "function") return null;
    const k = duitfulKit("speechStart");
    return k && typeof k.speechAvailable === "function" && typeof k.speechStop === "function" ? k : null;
  }

  // Asked once per language per session; a missing or failing kit is "no".
  async function voiceNativeReady() {
    const kit = voiceKit();
    if (!kit) return false;
    const lang = voiceLangTag();
    if (lang in voiceNativeCache) return voiceNativeCache[lang];
    let ok = false;
    try {
      const r = await Promise.race([
        Promise.resolve(kit.speechAvailable({ lang })),
        new Promise((res) => setTimeout(() => res(null), 3000)),
      ]);
      ok = !!(r && r.available);
    } catch { ok = false; }
    voiceNativeCache[lang] = ok;
    return ok;
  }

  // "native" | "web" | "" — which ear this device has.
  async function voiceSpeechMode() {
    if (voiceInShell()) return (await voiceNativeReady()) ? "native" : "";
    return voiceSpeechCtor() ? "web" : "";
  }

  function voiceListening() {
    return !!(voiceRec || voiceNative);
  }

  // The sheet's Kira: happy at rest, listening while the mic is open (a nod
  // per new word), proud once there is a spend to save. Never the sempoa.
  function voiceKiraMood(mood) {
    const slot = document.getElementById("voice-kira");
    if (!slot || typeof kiraSvg !== "function") return;
    if (slot.dataset.mood === mood) return;
    slot.dataset.mood = mood;
    slot.innerHTML = kiraSvg(mood, { moment: true });
  }

  function voiceKiraSync() {
    if (voiceListening()) { voiceKiraMood("listening"); return; }
    voiceKiraMood(voiceCurrent && voiceCurrent.amount > 0 ? "proud" : "happy");
  }

  function voiceKiraHear() {
    const svg = document.querySelector("#voice-kira svg.kira--listening");
    if (!svg) return;
    svg.classList.remove("is-hearing");
    void svg.getBoundingClientRect();
    svg.classList.add("is-hearing");
    clearTimeout(voiceHearTimer);
    voiceHearTimer = setTimeout(() => svg.classList.remove("is-hearing"), 700);
  }

  function voiceStatus(text, tone) {
    const el = document.getElementById("voice-status");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
    el.dataset.tone = tone || "";
  }

  function voiceShowDenied() {
    voiceStatus(voiceT("Allow the microphone in Settings to talk to Kira."), "warn");
  }

  function voiceSetListening(on) {
    const btn = document.getElementById("voice-mic-btn");
    const dlg = document.getElementById("voice-dialog");
    if (btn) {
      btn.classList.toggle("is-listening", !!on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", on ? voiceT("Stop listening") : voiceT("Start voice input"));
    }
    if (dlg) dlg.classList.toggle("is-listening", !!on);
    if (on) voiceStatus(voiceT("Listening…"), "");
    else {
      const el = document.getElementById("voice-status");
      if (el && el.dataset.tone !== "warn") voiceStatus("");
    }
    voiceKiraSync();
  }

  // Stop the mic. { cancel: true } (Cancel, closing the sheet) drops what
  // was heard; a plain stop (let go of Kira, tap the mic) keeps it.
  function voiceStopListening(opts) {
    const cancel = !!(opts && opts.cancel);
    if (voiceStarting) voiceStarting.stop = true;
    if (voiceRec) {
      const rec = voiceRec;
      voiceRec = null;
      if (cancel) rec.duitfulCancelled = true;
      try { if (cancel && typeof rec.abort === "function") rec.abort(); else rec.stop(); } catch {}
    }
    if (voiceNative) {
      const s = voiceNative;
      voiceNative = null;
      if (cancel) s.cancelled = true;
      try { Promise.resolve(s.kit.speechStop()).catch(() => {}); } catch {}
    }
    voiceSetListening(false);
  }

  function voiceFill(text) {
    const input = document.getElementById("voice-input");
    if (!input) return;
    input.value = text;
    renderVoicePreview(parseVoiceSentence(text));
  }

  // The words are in: the same parse as typing, then AI+ when it's on.
  function voiceAfterSpeech() {
    const input = document.getElementById("voice-input");
    if (!input || !input.value.trim()) { voiceKiraSync(); return; }
    renderVoicePreview(parseVoiceSentence(input.value));
    parseVoiceSmart(input.value).then((smart) => {
      if (input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
    }).catch(() => {});
  }

  async function voiceStartNative(kit) {
    const session = { kit, cancelled: false, handle: null };
    voiceNative = session;
    voiceSetListening(true);
    try {
      if (typeof kit.addListener === "function") {
        session.handle = await Promise.resolve(kit.addListener("speechPartial", (d) => {
          if (session.cancelled || voiceNative !== session) return;
          const t = String((d && d.text) || "").trim();
          if (!t) return;
          voiceFill(t);
          voiceKiraHear();
        }));
      }
    } catch {}
    let text = "";
    let denied = false;
    try {
      const res = await kit.speechStart({ lang: voiceLangTag() });
      text = String((res && res.text) || "").trim();
    } catch (e) {
      denied = /DENIED|PERMISSION|NOT[-_ ]?ALLOWED/i.test(String((e && (e.code || e.message)) || ""));
    }
    try { if (session.handle && typeof session.handle.remove === "function") session.handle.remove(); } catch {}
    if (voiceNative === session) { voiceNative = null; voiceSetListening(false); }
    if (session.cancelled) return;
    if (denied) voiceShowDenied();
    if (text) voiceFill(text);
    voiceAfterSpeech();
  }

  function voiceStartWeb(Ctor) {
    const input = document.getElementById("voice-input");
    const rec = new Ctor();
    rec.lang = voiceLangTag();
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    voiceRec = rec;
    voiceSetListening(true);
    rec.onresult = (ev) => {
      if (rec.duitfulCancelled) return;
      const transcript = [...ev.results].map((r) => r[0].transcript).join(" ").trim();
      if (input) { voiceFill(transcript); voiceKiraHear(); }
    };
    rec.onerror = (ev) => {
      if (ev && (ev.error === "not-allowed" || ev.error === "service-not-allowed")) voiceShowDenied();
      if (voiceRec === rec) voiceStopListening();
    };
    rec.onend = () => {
      if (voiceRec === rec) { voiceRec = null; voiceSetListening(false); }
      if (!rec.duitfulCancelled) voiceAfterSpeech();
    };
    try { rec.start(); } catch { voiceStopListening(); }
  }

  // Start the mic, whichever this device has. A stop that lands while the
  // kit is still being asked (a very short hold) means: don't start.
  async function voiceListen() {
    if (voiceListening() || voiceStarting) return;
    const el = document.getElementById("voice-status");
    if (el && el.dataset.tone === "warn") voiceStatus("");
    const token = { stop: false };
    voiceStarting = token;
    let mode = "";
    try { mode = await voiceSpeechMode(); } catch { mode = ""; }
    if (voiceStarting === token) voiceStarting = null;
    const dlg = document.getElementById("voice-dialog");
    if (token.stop || !dlg || !dlg.open) return;
    if (mode === "native") { const kit = voiceKit(); if (kit) voiceStartNative(kit); }
    else if (mode === "web") voiceStartWeb(voiceSpeechCtor());
  }

  // The mic shows only where something can hear: the browser's Web Speech,
  // or the app's own kit for this language.
  function voiceSyncMic() {
    const micBtn = document.getElementById("voice-mic-btn");
    if (!micBtn) return Promise.resolve("");
    if (!voiceInShell()) {
      const m = voiceSpeechCtor() ? "web" : "";
      micBtn.hidden = !m;
      return Promise.resolve(m);
    }
    micBtn.hidden = true;
    return voiceSpeechMode().then((m) => { micBtn.hidden = !m; return m; }).catch(() => "");
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
      voiceKiraSync();
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
    voiceKiraSync();
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
    voiceStopListening({ cancel: true });
    if (dlg && dlg.open) dlg.close();

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

  // opts.listen: open already listening (holding Kira on Home).
  function openVoiceEntry(initialText, opts) {
    const o = opts || {};
    const dlg = document.getElementById("voice-dialog");
    const input = document.getElementById("voice-input");
    if (!dlg || !input) return;
    voiceStatus("");
    const micReady = voiceSyncMic();
    input.value = String(initialText || "").trim();
    const slot = document.getElementById("voice-kira");
    if (slot) { slot.dataset.mood = ""; slot.innerHTML = ""; }
    if (!dlg.open && typeof dlg.showModal === "function") dlg.showModal();
    if (input.value) {
      renderVoicePreview(parseVoiceSentence(input.value));
      parseVoiceSmart(input.value).then((smart) => {
        if (input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
      }).catch(() => {});
    } else {
      renderVoicePreview(null);
      // Holding Kira: no keyboard over the sheet while listening.
      if (!o.listen) setTimeout(() => { try { input.focus(); } catch {} }, 40);
    }
    if (o.listen) {
      // showModal focused the box; no keyboard over the sheet while listening.
      if (document.activeElement === input) { try { input.blur(); } catch {} }
      voiceListen();
      // Focus goes to the mic (now "Stop listening"); no ear on this device:
      // the keyboard it is.
      micReady.then((m) => {
        if (!dlg.open) return;
        const mic = document.getElementById("voice-mic-btn");
        try { if (m && mic) mic.focus({ preventScroll: true }); else input.focus(); } catch {}
      });
    }
  }

  /* ---------- Hold Kira to talk (Home) ----------
     A press on Home's Kira (the receipt's own paper, the only part of Kira
     that takes the pointer) held for VOICE_HOLD_MS opens the Voice sheet
     already listening; letting go stops and shows the preview. A shorter tap
     is just Kira's giggle (kiraTap in kira.js). Kira stays aria-hidden: the
     Voice button beside Scan receipt is the accessible way in. */
  const VOICE_HOLD_MS = 350;
  const VOICE_HOLD_SLOP = 12;
  let voiceHold = null;

  function voiceHoldTarget(t) {
    if (!(t instanceof Element) || !t.closest(".kira-body")) return null;
    const svg = t.closest("svg.kira");
    if (!svg || !svg.closest("#tab-dashboard") || svg.closest(".kira-hop")) return null;
    return svg;
  }

  function voiceHoldClear() {
    if (voiceHold) clearTimeout(voiceHold.timer);
    voiceHold = null;
  }

  function initVoiceHold() {
    document.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      const svg = voiceHoldTarget(e.target);
      if (!svg || document.querySelector("dialog[open]")) return;
      voiceHoldClear();
      const h = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
      h.timer = setTimeout(() => {
        if (voiceHold !== h) return;
        h.fired = true;
        openVoiceEntry("", { listen: true });
      }, VOICE_HOLD_MS);
      voiceHold = h;
    }, { capture: true, passive: true });
    document.addEventListener("pointermove", (e) => {
      const h = voiceHold;
      if (!h || h.fired || e.pointerId !== h.id) return;
      if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > VOICE_HOLD_SLOP) voiceHoldClear();
    }, { capture: true, passive: true });
    const release = (e) => {
      const h = voiceHold;
      if (!h || e.pointerId !== h.id) return;
      voiceHoldClear();
      if (h.fired) voiceStopListening();
    };
    document.addEventListener("pointerup", release, { capture: true, passive: true });
    document.addEventListener("pointercancel", release, { capture: true, passive: true });
    // No long-press menu or text selection on Kira.
    document.addEventListener("contextmenu", (e) => {
      if (voiceHoldTarget(e.target)) e.preventDefault();
    }, { capture: true });
  }

  function initVoiceUI() {
    const openBtn = document.getElementById("btn-voice");
    const dlg = document.getElementById("voice-dialog");
    const input = document.getElementById("voice-input");
    const micBtn = document.getElementById("voice-mic-btn");
    const saveBtn = document.getElementById("voice-save");
    const cancelBtn = document.getElementById("voice-cancel");

    if (openBtn) openBtn.addEventListener("click", () => openVoiceEntry(""));
    if (cancelBtn) cancelBtn.addEventListener("click", () => { voiceStopListening({ cancel: true }); if (dlg && dlg.open) dlg.close(); });
    if (dlg) dlg.addEventListener("close", () => { voiceStopListening({ cancel: true }); voiceStatus(""); });

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
        if (voiceListening()) { voiceStopListening(); return; }
        voiceListen();
      });
    }

    initVoiceHold();

    if (saveBtn) saveBtn.addEventListener("click", () => voiceSaveConfirmed());
  }

  window.parseVoiceSentence = parseVoiceSentence;
  window.parseVoiceSmart = parseVoiceSmart;
  window.openVoiceEntry = openVoiceEntry;
  window.voiceSaveConfirmed = voiceSaveConfirmed;
  window.voiceStopListening = voiceStopListening;
  window.voiceSpeechMode = voiceSpeechMode;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVoiceUI);
  } else {
    initVoiceUI();
  }
})();
