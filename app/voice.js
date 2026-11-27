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

  const VOICE_EXACT_SPLIT_SRC = String.raw`\b(?:request|ask|charge|minta|claim)\s+(?:rm|myr|\$)?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:ringgit|rm|myr)?\s+(?:from|dari|daripada)\s+([a-zA-Z\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff\s,&-]{0,60})`;

  function voiceExtractSplit(text, totalAmount, knownContacts) {
    const raw = String(text || "");
    // 1. Explicit exact request: "request RM 20 from Ali" / "minta RM 20 dari Ali"
    const exactRe = new RegExp(VOICE_EXACT_SPLIT_SRC, "i");
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

  /* ---------- What the recogniser mishears (1.82.0) ----------
     Speech engines trained on English hear Malaysian spend words as English
     ones ("nasi" → "Nazi"). VOICE_CORRECTIONS fixes the few we have seen,
     whole words only, case-insensitive, and only on recognised speech
     (voiceFill), never on typed text. Keep it small: each row is a sound-alike
     that is never what someone logging a spend means. Risky ones ("my" →
     "MAE") are left out on purpose. */
  const VOICE_CORRECTIONS = [
    [/\bnasty\s+lemak\b/gi, "nasi lemak"],
    [/\bnasi\s+lemma\b/gi, "nasi lemak"],
    [/\bnazi\b/gi, "nasi"],
    [/\broti\s+(?:channel|chennai)\b/gi, "roti canai"],
    [/\bteh\s+tarek\b/gi, "teh tarik"],
    [/\bgrab\s+car\b/gi, "Grab"],
    [/\btouch\s+(?:and|n|'n)\s+go\b/gi, "Touch 'n Go"],
    [/\bduit\s+now\b/gi, "DuitNow"],
    [/\bmay\s+bank\b/gi, "Maybank"],
    // 1.89.0: "log my" heard as "lock my"; "two / four ringgit" as "to / for ringgit".
    [/\block\s+my\s+(spending|spend|expenses?|lunch|dinner|breakfast|food|makan)\b/gi, "log my $1"],
    [/^lock\s+(?=rm\b|\d)/i, "log "],
    [/\b(?:to|too)\s+(?=ringgit\b)/gi, "two "],
    [/\bfor\s+(?=ringgit\b)/gi, "four "],
  ];

  function voiceCorrectHeard(text) {
    let out = String(text || "");
    for (const [re, to] of VOICE_CORRECTIONS) out = out.replace(re, to);
    return out;
  }

  // Words the phone's recogniser should expect (speechStart's hints): the
  // usual Malaysian spend words, plus the person's own categories, wallets
  // and the first names on open split requests (first names only).
  const VOICE_HINT_WORDS = [
    "nasi lemak", "nasi", "roti canai", "teh tarik", "kopi", "mamak", "makan",
    "Grab", "Touch 'n Go", "TNG", "MAE", "DuitNow", "Shopee", "Lazada", "Mydin",
    "Petronas", "Shell", "Tealive", "Zus", "KFC", "McD", "ringgit", "sen",
    "split", "bahagi", "minyak", "parking", "tol",
  ];

  function voiceSpeechHints() {
    const out = [];
    const seen = new Set();
    const add = (w) => {
      const t = String(w || "").trim();
      if (!t || t.length > 40 || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase());
      out.push(t);
    };
    VOICE_HINT_WORDS.forEach(add);
    try { if (typeof scanAllCategories === "function") scanAllCategories().forEach(add); } catch {}
    try {
      if (typeof state === "object" && state) {
        for (const w of (state.wallets || [])) if (w && !w.archived) add(w.name);
        const recs = state.split && Array.isArray(state.split.out) ? state.split.out : [];
        for (const r of recs) {
          for (const p of (r && r.people || [])) {
            if (!p || !p.name || p.status === "paid") continue;
            add(String(p.name).trim().split(/\s+/)[0]);
          }
        }
      }
    } catch {}
    return out.slice(0, 100);
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
    const numRe = /(?:(?:rm|myr|\$)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?))|(?:(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:ringgit|rm|myr|bucks|dollars|块|元|令吉)(?:\s*(\d{1,2})\s*(?:sen|cents?)\b)?)/i;
    const numM = work.match(numRe);
    if (numM) {
      // "12 ringgit 50 sen" is RM 12.50 (1.89.0).
      amount = voiceRound2(Number((numM[1] || numM[2]).replace(/,/g, "")) + (numM[3] ? Number(numM[3]) / 100 : 0));
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

    // Detect money-write intent: income vs debt payment vs spend (all still confirm before saving).
    const isIncome = /\b(received|receive|earned|earn|salary|bonus|freelance|dividend|refund|gaji|dapat|terima|pendapatan|bonus|found|jumpa|terjumpa|kutip|pungut)\b|工资|薪水|收入|收到|赚了|捡到/i.test(raw)
      && !/\b(split|bahagi|kongsi)\b/i.test(raw);
    const isDebtPay = !isIncome && /\b(pay\s+debt|paid\s+debt|debt\s+payment|loan\s+payment|bayar\s+hutang|bayar\s+pinjaman|bayar\s+kereta|bayar\s+rumah)\b|[还贷还债还卡]/i.test(raw);
    let debtId = "";
    let debtName = "";
    if (isDebtPay && typeof state === "object" && state && Array.isArray(state.debts)) {
      const lowerRaw = raw.toLowerCase();
      const matchedDebt = state.debts.find((d) => d && d.balance > 0 && d.name && lowerRaw.includes(String(d.name).toLowerCase()))
        || state.debts.find((d) => d && d.balance > 0);
      if (matchedDebt) {
        debtId = matchedDebt.id;
        debtName = matchedDebt.name;
      }
    }

    const category = isIncome ? "Income" : (isDebtPay ? "Debt" : voiceInferCategory(work + " " + raw));

    // Strip leading command boilerplate ("log my", "add", "rekod", "belanja", "spent") to leave a clean note.
    // 1.89.0: strip every leading filler word, not just one ("log my spending nasi" → "Nasi").
    let lead = work;
    for (let n = 0; n < 8; n++) {
      const next = lead
        .replace(/^[\s,.:;-]*(?:please|tolong|log|add|record|track|note|spent|spend|spending|expenses?|paid|pay|bought|ate|had|received|receive|earned|earn|beli|belanja|rekod|tambah|catat|dapat|terima|bayar|my|for|on|at|untuk|di|saya|aku|i|just|today|tadi|hutang|debt)\b\s*/i, "")
        .replace(/^\s*(?:记一笔|花了|买了|收到|还了)\s*/, "");
      if (next === lead) break;
      lead = next;
    }
    let note = lead
      .replace(/\b(?:spending|expense|expenses|in\s+duitful|dalam\s+duitful|and|dan)\s*$/i, "")
      // Currency words are never the note ("RM 40 ringgit nasi" → "Nasi").
      .replace(/(?:^|\s)(?:ringgit|rm|myr|sen)(?=\s|[,.]|$)/gi, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
      .trim();
    if (note) note = note.charAt(0).toUpperCase() + note.slice(1);
    else if (debtName) note = debtName;
    else if (category !== "Others") note = category;

    return {
      raw,
      entryKind: isIncome ? "income" : (isDebtPay && debtId ? "debt" : "expense"),
      amount,
      category,
      note: note.slice(0, 80),
      walletId: wHit ? wHit.wallet.id : "",
      walletName: wHit ? wHit.wallet.name : "",
      debtId,
      debtName,
      split: isIncome || isDebtPay ? null : split,
      source: "local",
    };
  }

  /* ---------- Several spends in one sentence (1.89.0) ----------
     "Log my spending 12 ringgit nasi lemak, five ringgit teh tarik, two ringgit
     roti canai" is three spends. Only amounts anchored by a currency word
     count (RM, ringgit, 块, 元): a bare "2 roti canai" is a quantity. Split
     sentences ("… request RM 20 from Ali"), income and debt payments stay one
     entry. Fewer than two anchored amounts: the single parser, unchanged. */
  const VOICE_MAX_ITEMS = 10;
  const VOICE_NUM_SPAN_RE = /(?:rm|myr|\$)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?:\s*(?:ringgit|rm|myr)\b)?|(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:(?:ringgit|rm|myr|bucks|dollars)\b|块|元|令吉)(?:\s*(\d{1,2})\s*(?:sen|cents?)\b)?/gi;
  const VOICE_ZH_SPAN_RE = /[零一二两三四五六七八九十百千]+\s*(?:块|元|令吉|马币)(?:\s*[零一二两三四五六七八九](?:毛|角)?)?/g;
  const VOICE_NUM_WORDS = new Set(["belas", "puluh", "ratus", "seratus", "hundred", "ribu", "seribu", "thousand"]);
  const VOICE_CURRENCY_WORDS = new Set(["ringgit", "rm", "myr", "dollars", "bucks"]);
  // Words that only say "log this" — what's left after them decides whether
  // the sentence names the thing before its price ("nasi lemak 12 ringgit").
  const VOICE_LEAD_FILLER = /\b(?:please|tolong|log|logged|add|record|track|note|my|me|the|i|i've|just|today|spending|spend|spent|expenses?|paid|pay|bought|buy|ate|eat|had|for|on|at|beli|belanja|rekod|tambah|catat|saya|aku|hari\s+ini|tadi|dan|and|then|also|plus)\b|记一笔|记|花了|买了|今天|我/gi;

  function voiceAmountSpans(text) {
    const raw = String(text || "");
    const spans = [];
    let m;
    VOICE_NUM_SPAN_RE.lastIndex = 0;
    while ((m = VOICE_NUM_SPAN_RE.exec(raw))) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
    VOICE_ZH_SPAN_RE.lastIndex = 0;
    while ((m = VOICE_ZH_SPAN_RE.exec(raw))) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
    // Spoken numbers anchored by a currency word: "five ringgit", "dua belas ringgit lima puluh sen".
    const toks = [];
    const tokRe = /[a-z]+/gi;
    while ((m = tokRe.exec(raw))) toks.push({ w: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
    const isNum = (w) => w in WORD_NUMS || VOICE_NUM_WORDS.has(w);
    for (let i = 0; i < toks.length; i++) {
      if (!isNum(toks[i].w) || toks[i].w === "a" || toks[i].w === "se") continue;
      if (i > 0 && isNum(toks[i - 1].w)) continue;
      let j = i;
      while (j < toks.length && (isNum(toks[j].w) || (j > i && (toks[j].w === "and" || toks[j].w === "dan") && j + 1 < toks.length && isNum(toks[j + 1].w)))) j++;
      if (j >= toks.length || !VOICE_CURRENCY_WORDS.has(toks[j].w)) { i = j - 1; continue; }
      let end = toks[j].e;
      let k = j + 1;
      while (k < toks.length && isNum(toks[k].w)) k++;
      if (k > j + 1 && k < toks.length && /^(?:sen|cents?)$/.test(toks[k].w)) end = toks[k].e;
      spans.push({ start: toks[i].s, end });
      i = j;
    }
    spans.sort((a, b) => a.start - b.start);
    const out = [];
    for (const s of spans) {
      const prev = out[out.length - 1];
      if (prev && s.start < prev.end) { prev.end = Math.max(prev.end, s.end); continue; }
      out.push({ ...s });
    }
    return out;
  }

  function voiceTrimJoiners(s) {
    return String(s || "")
      .replace(/^[\s,.;:&+\-，、。；]*(?:(?:and|dan|then|also|plus|lepas\s+tu|pastu|lagi)\b|和|还有|然后)?[\s,.;:&+\-，、。；]*/i, "")
      .replace(/[\s,.;:&+\-，、。；]*(?:\b(?:and|dan|then|also|plus)|和|还有|然后)?[\s,.;:&+\-，、。；]*$/i, "")
      .trim();
  }

  // Clause breaks that start a new thought: "…, then found 50 ringgit".
  const VOICE_CLAUSE_RE = /\s*(?:[,;，；。]|\.(?=\s|$))\s*(?:(?:and\s+)?then\b|lepas\s+tu\b|pastu\b|also\b|plus\b|然后|还有)?\s*|\s+(?:and\s+then|then|lepas\s+tu|pastu|lepastu)\s+|然后|还有/gi;

  function voiceClauses(raw) {
    const parts = [];
    let last = 0;
    let m;
    VOICE_CLAUSE_RE.lastIndex = 0;
    while ((m = VOICE_CLAUSE_RE.exec(raw))) {
      if (!m[0]) { VOICE_CLAUSE_RE.lastIndex++; continue; }
      parts.push({ start: last, end: m.index });
      last = m.index + m[0].length;
    }
    parts.push({ start: last, end: raw.length });
    return parts.filter((c) => c.end > c.start);
  }

  // Amounts that are a split's own figure ("request RM 20 from Ali") are not a new item.
  function voiceItemSpans(text) {
    const spans = voiceAmountSpans(text);
    const exact = [...text.matchAll(new RegExp(VOICE_EXACT_SPLIT_SRC, "gi"))]
      .map((m) => ({ start: m.index, end: m.index + m[0].length }));
    return spans.filter((s) => !exact.some((x) => s.start >= x.start && s.start < x.end));
  }

  function parseVoiceItems(rawText, opts) {
    const raw = String(rawText || "").trim();
    const whole = parseVoiceSentence(raw, opts);
    if (!raw) return [whole];
    const allSpans = voiceItemSpans(raw);
    if (allSpans.length < 2) return [whole];

    const o = opts && typeof opts === "object" ? opts : {};
    const wallets = Array.isArray(o.wallets) ? o.wallets : (typeof state === "object" && state && Array.isArray(state.wallets) ? state.wallets : []);
    const wHit = voiceMatchWallet(raw, wallets);

    // 1. Clauses; a clause with no amount ("split half with Ali") joins the one before it
    //    (or the next one when it comes first: "nasi lemak, 12 ringgit").
    const clauses = [];
    for (const c of voiceClauses(raw)) {
      const has = allSpans.some((s) => s.start >= c.start && s.start < c.end);
      const prev = clauses[clauses.length - 1];
      if (!has && prev) { prev.end = c.end; continue; }
      if (prev && !prev.has) { prev.end = c.end; prev.has = has; continue; }
      clauses.push({ start: c.start, end: c.end, has });
    }

    // 2. Inside a clause, one item per amount: amount-first, or note-first when
    //    words come before the first amount ("nasi lemak 12 ringgit dan teh tarik 5").
    const segs = [];
    for (const c of clauses) {
      const spans = allSpans.filter((s) => s.start >= c.start && s.start < c.end);
      if (spans.length < 2) { segs.push(raw.slice(c.start, c.end)); continue; }
      const head = raw.slice(c.start, spans[0].start);
      const noteFirst = /[a-z\u4e00-\u9fff]{2,}/i.test(head.replace(VOICE_LEAD_FILLER, " "));
      spans.forEach((sp, i) => {
        if (noteFirst) {
          const from = i === 0 ? c.start : spans[i - 1].end;
          segs.push(raw.slice(from, i === spans.length - 1 ? c.end : sp.end));
        } else {
          const from = i === 0 ? c.start : sp.start;
          segs.push(raw.slice(from, i === spans.length - 1 ? c.end : spans[i + 1].start));
        }
      });
    }
    if (segs.length < 2) return [whole];

    const items = [];
    for (const seg of segs.slice(0, VOICE_MAX_ITEMS)) {
      const p = parseVoiceSentence(voiceTrimJoiners(seg), { ...o, wallets });
      if (!(p.amount > 0)) return [whole];
      if (p.entryKind === "debt" && !p.debtId) p.entryKind = "expense";
      if (!p.walletId && wHit) { p.walletId = wHit.wallet.id; p.walletName = wHit.wallet.name; }
      items.push(p);
    }
    return items;
  }

  // What the sheet previews and saves: one entry, or `items` when the
  // sentence holds several spends (amount = their total).
  function voiceCombine(raw, items) {
    return {
      raw: String(raw || "").trim(),
      entryKind: items.every((p) => p.entryKind === "expense") ? "expense" : "mixed",
      // What goes out (spends, debt payments); money in is not added to it.
      amount: voiceRound2(items.reduce((a, p) => a + (p.entryKind === "income" ? 0 : p.amount), 0)) || voiceRound2(items.reduce((a, p) => a + p.amount, 0)),
      category: items[0].category,
      note: "",
      walletId: "",
      walletName: "",
      debtId: "",
      debtName: "",
      split: null,
      items,
      source: "local",
    };
  }

  function parseVoiceEntry(rawText, opts) {
    const items = parseVoiceItems(rawText, opts);
    return items.length < 2 ? items[0] : voiceCombine(rawText, items);
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
    const local = parseVoiceEntry(rawText);
    if (!rawText || typeof window.aiCloudRun !== "function") return local;
    // Several spends: the cloud task reads one entry, so the local split stands.
    if (local.items) return local;
    if (local.entryKind === "income" || local.entryKind === "debt") return local;
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
        entryKind: local.entryKind || "expense",
        amount: amt,
        category: cat,
        note,
        walletId: wHit ? wHit.wallet.id : local.walletId,
        walletName: wHit ? wHit.wallet.name : local.walletName,
        debtId: local.debtId || "",
        debtName: local.debtName || "",
        split,
        source: "cloud-ai",
      };
    } catch {
      return local;
    }
  }

  /* ---------- 2.0 Stage B: Local-First Commands & Kira Assistant Q&A ----------
     Navigation and simple reads run locally for 0 AI+ quota.
     Money writes ALWAYS go through the 1-tap Confirm card (#voice-preview).
     Session multi-turn Q&A is kept in memory only (capped at 6 messages) and
     wiped as soon as #voice-dialog closes. */

  const VOICE_MAX_TURNS = 6;
  let voiceTurns = [];
  let voiceAskBusy = false;

  function voiceMatchLocalCommand(rawText) {
    const t = String(rawText || "").trim();
    if (!t || /\d/.test(t)) return null;
    if (/^(?:please\s+)?(?:open|show|go\s+to|launch|buka|tunjuk|pergi|打开|进入)?\s*(?:the\s+)?(?:receipt\s+)?(?:scanner|scan\s+receipt|imbas\s+resit|扫描收据)\b/i.test(t)) {
      return { kind: "open_scan" };
    }
    if (/^(?:please\s+)?(?:open|show|go\s+to|buka|tunjuk|打开)\s+(?:my\s+)?(?:bank\s+)?(?:statement|penyata\s+bank|银行账单)\b/i.test(t)
        || /^import\s+(?:bank\s+)?statement\b/i.test(t)) {
      return { kind: "open_statement" };
    }
    if (/^(?:please\s+)?(?:open|show|go\s+to|buka|tunjuk|打开)\s+(?:my\s+)?(?:tax|tax\s+relief|lhdn|cukai|pelepasan\s+cukai|税务|扣税)\b/i.test(t)) {
      return { kind: "open_tax" };
    }
    if (/^(?:please\s+)?(?:open|show|go\s+to|buka|tunjuk|打开)\s+(?:my\s+)?(?:debts?|debt\s+strategy|payoff|hutang|债务)\b/i.test(t)) {
      return { kind: "open_debts" };
    }
    if (/^(?:please\s+)?(?:open|show|go\s+to|buka|tunjuk|打开)\s+(?:my\s+)?(?:savings?|goals?|wallets?|simpanan|tabung|dompet|储蓄|钱包)\b/i.test(t)) {
      return { kind: "open_savings" };
    }
    if (/^(?:please\s+)?(?:open|show|go\s+to|buka|tunjuk|打开)\s+(?:my\s+)?(?:reports?|charts?|laporan|报告)\b/i.test(t)) {
      return { kind: "open_reports" };
    }
    if (/^(?:please\s+)?(?:open|show|go\s+to|buka|tunjuk|打开)\s+(?:my\s+)?(?:monthly|bills?|bulanan|bil|月度|账单)\b/i.test(t)) {
      return { kind: "open_monthly" };
    }
    return null;
  }

  function voiceLooksLikeQuestion(rawText) {
    const t = String(rawText || "").trim();
    if (!t) return false;
    if (/\?$/.test(t)) return true;
    return /\b(how\s+much|what(?:'s|s|\s+is)|which\s+debt|where\s+did|can\s+i|should\s+i|left\s+(?:for|this|in)|tax\s+relief|relief\s+left|payoff|strategy|spent\s+this|spending\s+this|biggest\s+spend|balance|berapa|belanja\s+bulan|pelepasan\s+cukai|hutang\s+mana|baki\s+bulan|策略|花了多少|税务减免|先还哪|余额多少)\b/i.test(t);
  }

  function voiceRunAction(action) {
    if (!action || !action.kind) return false;
    const dlg = document.getElementById("voice-dialog");
    if (action.kind === "prefill_spend" && action.sentence) {
      const input = document.getElementById("voice-input");
      if (input) {
        input.value = action.sentence;
        voiceSyncTranscript(action.sentence);
        renderVoicePreview(parseVoiceEntry(action.sentence));
      }
      return true;
    }
    voiceStopListening({ cancel: true });
    if (dlg && dlg.open) dlg.close();
    if (action.kind === "open_scan") {
      setTimeout(() => document.getElementById("btn-scan")?.click(), 60);
      return true;
    }
    if (action.kind === "open_statement" && typeof openStatementImport === "function") {
      setTimeout(() => openStatementImport(), 60);
      return true;
    }
    const tabMap = {
      open_tax: "tax",
      open_debts: "debts",
      open_savings: "savings",
      open_reports: "reports",
      open_monthly: "flow",
    };
    if (tabMap[action.kind] && typeof switchTab === "function") {
      switchTab(tabMap[action.kind]);
      return true;
    }
    return false;
  }

  function buildKiraLocalSnapshot() {
    const out = {
      month: typeof selectedMonth === "string" && selectedMonth ? selectedMonth : (typeof currentMonthISO === "function" ? currentMonthISO() : new Date().toISOString().slice(0, 7)),
      currency: typeof currentCurrency === "function" ? currentCurrency() : "MYR",
      income: 0,
      spent: 0,
      balance: 0,
      topCats: [],
      debtsCount: 0,
      debtsTotal: 0,
      strategy: (state && state.payoffStrategy) || "avalanche",
      topDebt: null,
      debtFreeMonth: "",
      taxClaimed: 0,
      taxGaps: [],
    };
    if (typeof state !== "object" || !state) return out;
    const m = out.month;
    const inc = (state.income || []).filter((x) => x && x.month === m).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const bills = (state.expenses || []).filter((x) => x && x.month === m).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const daily = (state.dailyExpenses || []).filter((x) => x && String(x.date || "").startsWith(m) && x.kind === "expense");
    const dailySum = daily.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    out.income = voiceRound2(inc);
    out.spent = voiceRound2(bills + dailySum);
    out.balance = voiceRound2(inc - out.spent);

    const catMap = new Map();
    for (const d of daily) {
      const c = d.category || "Others";
      catMap.set(c, (catMap.get(c) || 0) + (Number(d.amount) || 0));
    }
    out.topCats = [...catMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, amount]) => ({ name, amount: voiceRound2(amount) }));

    const activeDebts = (state.debts || []).filter((d) => d && Number(d.balance) > 0);
    out.debtsCount = activeDebts.length;
    out.debtsTotal = voiceRound2(activeDebts.reduce((s, d) => s + (Number(d.balance) || 0), 0));
    if (activeDebts.length) {
      const sorted = [...activeDebts].sort((a, b) => {
        if (out.strategy === "snowball") return (Number(a.balance) || 0) - (Number(b.balance) || 0);
        if (out.strategy === "cfi") {
          const ca = (Number(a.minPayment) || 1) > 0 ? (Number(a.balance) || 0) / (Number(a.minPayment) || 1) : 1e9;
          const cb = (Number(b.minPayment) || 1) > 0 ? (Number(b.balance) || 0) / (Number(b.minPayment) || 1) : 1e9;
          return ca - cb;
        }
        return (Number(b.apr) || 0) - (Number(a.apr) || 0);
      });
      const first = sorted[0];
      const extraEffect = typeof debtExtraEffect === "function" ? debtExtraEffect(first) : "reduces_interest";
      out.topDebt = {
        label: first.name ? `Debt 1 (${first.kind || "standard"})` : "Debt 1",
        displayName: first.name || voiceT("Debt"),
        apr: Number(first.apr) || 0,
        balance: voiceRound2(first.balance),
        extraEffect,
      };
      if (typeof simulateDebtStrategy === "function") {
        try {
          const sim = simulateDebtStrategy(activeDebts, Number(state.extraMonthly) || 0, out.strategy);
          if (sim && sim.debtFreeDate) out.debtFreeMonth = String(sim.debtFreeDate);
        } catch {}
      }
    }

    // Country-aware tax context (local zero-PII totals only: LHDN / IRAS / IRD / Global Vault).
    out.tax = typeof taxKiraContext === "function" ? taxKiraContext() : null;
    if (out.tax) {
      out.taxClaimed = voiceRound2(out.tax.claimedTotal || 0);
      out.taxGaps = (out.tax.topOpportunities || []).slice(0, 3).map((o) => ({
        title: o.label || o.id,
        left: voiceRound2(o.room || 0),
        saving: voiceRound2(o.saving || 0),
      }));
    }
    return out;
  }

  function buildKiraSummaryString(snap) {
    const fmt = (n) => (typeof fmtMoney === "function" ? fmtMoney(n) : `${snap.currency} ${Number(n || 0).toFixed(2)}`);
    const lines = [
      `Month: ${snap.month}`,
      `Income: ${fmt(snap.income)} | Total spent: ${fmt(snap.spent)} | Balance: ${fmt(snap.balance)}`,
    ];
    if (snap.topCats.length) {
      lines.push(`Top spending categories: ${snap.topCats.map((c) => `${c.name} ${fmt(c.amount)}`).join(", ")}`);
    }
    if (snap.debtsCount > 0) {
      lines.push(`Active debts: ${snap.debtsCount} totaling ${fmt(snap.debtsTotal)} (strategy: ${snap.strategy}${snap.debtFreeMonth ? `, projected debt-free ${snap.debtFreeMonth}` : ""})`);
      if (snap.topDebt) {
        lines.push(`Priority debt: ${snap.topDebt.label}, balance ${fmt(snap.topDebt.balance)}, APR ${snap.topDebt.apr}%, extra-payment effect: ${snap.topDebt.extraEffect}`);
      }
    } else {
      lines.push("Active debts: 0");
    }
    if (snap.tax) {
      const tx = snap.tax;
      if (tx.mode === "vault_only") {
        lines.push(`Tax mode: Global Tax Receipt Vault (${tx.yearLabel}, ${tx.currency}) — ${tx.receiptCount} receipts saved totaling ${fmt(tx.claimedTotal)}. No country tax bands or relief caps applied.`);
      } else {
        const extras = [];
        if (tx.overallCap > 0 && tx.overallCapRoom != null) {
          extras.push(`overall cap room ${fmt(tx.overallCapRoom)} of ${fmt(tx.overallCap)}`);
        }
        if (tx.usedStandardRate) extras.push("two-tier standard rate applied");
        if (tx.filingDeadline) extras.push(`filing deadline ${tx.filingDeadline}`);
        const gaps = (tx.topOpportunities || []).slice(0, 4).map((o) => `${o.label} ${fmt(o.room)} left`).join(", ");
        lines.push(`Tax pack: ${tx.country} (${tx.authority}, ${tx.yearLabel}, ${tx.currency}, ${tx.withholdingMode}). Claimed: ${fmt(tx.claimedTotal)}${extras.length ? ` (${extras.join("; ")})` : ""}.${gaps ? ` Top room: ${gaps}` : ""}`);
      }
    } else if (snap.taxClaimed > 0 || snap.taxGaps.length) {
      lines.push(`Tax relief claimed: ${fmt(snap.taxClaimed)}. Remaining room: ${snap.taxGaps.map((g) => `${g.title} ${fmt(g.left)} left`).join(", ")}`);
    }
    return lines.join("\n");
  }

  function kiraLocalAnswer(question, snap) {
    const q = String(question || "").toLowerCase();
    const fmt = (n) => (typeof fmtMoney === "function" ? fmtMoney(n) : `RM ${Number(n || 0).toFixed(2)}`);

    if (/\b(tax|lhdn|iras|ird|relief|cukai|pelepasan|sspn|pcb|cpf|srs|mpf|vhis|etax|receipt vault)\b|[税扣]/.test(q)) {
      const tx = snap.tax;
      if (tx && tx.mode === "vault_only") {
        return {
          reply: tx.receiptCount > 0
            ? voiceT("Your Tax Receipt Vault has {n} receipts saved for {ya} totaling {total}. Open it to tag more or export CSV for filing.", {
                n: tx.receiptCount,
                ya: tx.yearLabel,
                total: fmt(tx.claimedTotal),
              })
            : voiceT("You are using the Global Tax Receipt Vault for {ya}. Tag receipts there and export CSV anytime for filing.", {
                ya: tx.yearLabel,
              }),
          actions: [{ kind: "open_tax", label: voiceT("Open Tax Receipt Vault") }],
        };
      }
      if (tx && tx.countryCode === "SGP" && tx.overallCap > 0 && tx.overallCapRoom === 0) {
        return {
          reply: voiceT("Under IRAS ({ya}), you have reached the {cap} overall personal relief cap. Qualifying IPC donations (250%) still sit outside this cap.", {
            ya: tx.yearLabel,
            cap: fmt(tx.overallCap),
          }),
          actions: [{ kind: "open_tax", label: voiceT("Open Tax Relief") }],
        };
      }
      if (tx && tx.countryCode === "HKG" && tx.usedStandardRate) {
        return {
          reply: voiceT("Under IRD ({ya}), the two-tier standard rate (15% / 16%) is lower than progressive bands on your current figures. Concessionary deductions like MPF, VHIS, or annuity still reduce net income.", {
            ya: tx.yearLabel,
          }),
          actions: [{ kind: "open_tax", label: voiceT("Open Tax Relief") }],
        };
      }
      const who = (tx && tx.authority) || "LHDN";
      const ya = (tx && tx.yearLabel) || "";
      if (snap.taxGaps.length) {
        const g = snap.taxGaps[0];
        return {
          reply: voiceT("Under {who} ({ya}), you have claimed {claimed} so far. You still have {left} left under {group}.", {
            who,
            ya,
            claimed: fmt(snap.taxClaimed),
            left: fmt(g.left),
            group: g.title,
          }),
          actions: [{ kind: "open_tax", label: voiceT("Open Tax Relief") }],
        };
      }
      return {
        reply: voiceT("Under {who} ({ya}), you have claimed {claimed} so far. Open Tax Relief to check remaining caps.", {
          who,
          ya,
          claimed: fmt(snap.taxClaimed),
        }),
        actions: [{ kind: "open_tax", label: voiceT("Open Tax Relief") }],
      };
    }

    if (/\b(debt|loan|payoff|strategy|avalanche|snowball|hutang|pinjaman)\b|[债贷]/.test(q)) {
      if (!snap.debtsCount || !snap.topDebt) {
        return {
          reply: voiceT("You have no active debts right now."),
          actions: [{ kind: "open_debts", label: voiceT("Open Debts") }],
        };
      }
      const effectNote = snap.topDebt.extraEffect === "full_settlement_only"
        ? voiceT("Extra payments do not cut monthly interest on fixed loans — save towards full settlement.")
        : snap.topDebt.extraEffect === "no_savings"
          ? voiceT("This 0% plan saves no interest from paying early.")
          : voiceT("Extra payments go straight to principal and cut interest.");
      return {
        reply: `${voiceT("Under your {strategy} strategy, focus on {name} ({bal}, {apr}% APR) first.", {
          strategy: snap.strategy,
          name: snap.topDebt.displayName,
          bal: fmt(snap.topDebt.balance),
          apr: snap.topDebt.apr,
        })} ${effectNote}`,
        actions: [{ kind: "open_debts", label: voiceT("Open Debts") }],
      };
    }

    // Default: spending / balance summary for current month.
    if (snap.topCats.length) {
      const top = snap.topCats[0];
      return {
        reply: voiceT("This month you spent {spent} with {bal} left. Biggest category: {cat} ({top}).", {
          spent: fmt(snap.spent),
          bal: fmt(snap.balance),
          cat: voiceT(top.name),
          top: fmt(top.amount),
        }),
        actions: [{ kind: "open_reports", label: voiceT("Open Reports") }],
      };
    }
    return {
      reply: voiceT("This month you spent {spent} with {bal} left.", {
        spent: fmt(snap.spent),
        bal: fmt(snap.balance),
      }),
      actions: [{ kind: "open_reports", label: voiceT("Open Reports") }],
    };
  }

  function renderVoiceThread() {
    const el = document.getElementById("voice-thread");
    if (!el) return;
    if (!voiceTurns.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = "";
    for (const turn of voiceTurns) {
      const row = document.createElement("div");
      row.className = `voice-turn voice-turn--${turn.role}`;
      const bubble = document.createElement("p");
      bubble.className = "voice-turn-text";
      bubble.textContent = turn.text;
      row.appendChild(bubble);
      if (turn.role === "kira" && Array.isArray(turn.actions) && turn.actions.length) {
        const chips = document.createElement("div");
        chips.className = "voice-turn-actions";
        for (const a of turn.actions) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ghost voice-action-chip";
          btn.textContent = a.label;
          btn.addEventListener("click", () => voiceRunAction(a));
          chips.appendChild(btn);
        }
        row.appendChild(chips);
      }
      el.appendChild(row);
    }
    el.scrollTop = el.scrollHeight;
  }

  function pushVoiceTurn(turn) {
    voiceTurns.push(turn);
    if (voiceTurns.length > VOICE_MAX_TURNS) {
      voiceTurns = voiceTurns.slice(voiceTurns.length - VOICE_MAX_TURNS);
    }
    renderVoiceThread();
  }

  function clearVoiceThread() {
    voiceTurns = [];
    renderVoiceThread();
  }

  async function voiceAskKira(question) {
    const q = String(question || "").trim();
    if (!q || voiceAskBusy) return;
    voiceAskBusy = true;
    pushVoiceTurn({ role: "user", text: q });
    const input = document.getElementById("voice-input");
    if (input) input.value = "";
    voiceSyncTranscript("");
    renderVoicePreview(null);
    voiceStatus(voiceT("Thinking…"), "");

    const snap = buildKiraLocalSnapshot();
    const summary = buildKiraSummaryString(snap);
    const lang = (window.I18N && window.I18N.lang) || "en";
    const history = voiceTurns.slice(-5, -1).map((t) => `${t.role === "user" ? "User" : "Kira"}: ${t.text}`.slice(0, 240));

    let answer = null;
    if (typeof window.aiCloudKiraAsk === "function" && typeof aiCloudAllowed === "function" && aiCloudAllowed()) {
      try {
        answer = await window.aiCloudKiraAsk({ question: q.slice(0, 300), lang, summary, history });
      } catch {
        answer = null;
      }
    }
    if (!answer) {
      answer = kiraLocalAnswer(q, snap);
    }
    voiceAskBusy = false;
    const statusEl = document.getElementById("voice-status");
    if (statusEl && statusEl.dataset.tone !== "warn") voiceStatus("");
    pushVoiceTurn({ role: "kira", text: answer.reply, actions: answer.actions || [] });
    voiceKiraMood("proud");
  }

  /* ---------- UI: #voice-dialog Siri-style stage, waves & mic ---------- */

  let voiceCurrent = null;
  let voiceRec = null;
  let voiceNative = null;
  let voiceStarting = null;
  let voiceHearTimer = 0;
  const voiceNativeCache = {};

  // Reactive 3-layer SVG waves driven by native speechLevel (~20 Hz, 0..1 float).
  let waveRaf = 0;
  let wavePhase = 0;
  let waveTarget = 0;
  let waveSmooth = 0;
  let waveHasLiveLevel = false;

  function voiceReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch { return false; }
  }

  function voiceWavePath(amp, freq, phase) {
    const w = 320;
    const mid = 60;
    const pts = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(t * w);
      // Taper smoothly to 0 at left & right edges (Hann window).
      const env = Math.sin(Math.PI * t);
      const y = mid + Math.sin(t * Math.PI * 2 * freq + phase) * amp * env;
      pts.push(`${i === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`);
    }
    return pts.join(" ");
  }

  function voiceApplyLevelRing(level) {
    const ring = document.getElementById("voice-rm-ring");
    if (!ring) return;
    const scale = 1 + Math.max(0, Math.min(1, Number(level) || 0)) * 0.35;
    ring.style.setProperty("--voice-level", scale.toFixed(3));
  }

  function voiceWaveReset() {
    const p1 = document.getElementById("voice-wave-1");
    const p2 = document.getElementById("voice-wave-2");
    const p3 = document.getElementById("voice-wave-3");
    const flat = "M0 60 Q 80 60 160 60 T 320 60";
    if (p1) p1.setAttribute("d", flat);
    if (p2) p2.setAttribute("d", flat);
    if (p3) p3.setAttribute("d", flat);
    voiceApplyLevelRing(0);
  }

  function voiceWaveTick() {
    waveRaf = 0;
    const dlg = document.getElementById("voice-dialog");
    if (!dlg || !dlg.open || !voiceListening()) {
      voiceWaveReset();
      return;
    }
    if (voiceReducedMotion()) {
      voiceApplyLevelRing(waveHasLiveLevel ? waveTarget : 0);
      return;
    }
    const target = waveHasLiveLevel ? (0.14 + waveTarget * 0.86) : 0.16;
    waveSmooth += (target - waveSmooth) * (waveHasLiveLevel ? 0.28 : 0.08);
    wavePhase += waveHasLiveLevel ? (0.09 + waveSmooth * 0.1) : 0.035;

    const p1 = document.getElementById("voice-wave-1");
    const p2 = document.getElementById("voice-wave-2");
    const p3 = document.getElementById("voice-wave-3");
    if (p1) p1.setAttribute("d", voiceWavePath(44 * waveSmooth, 1.8, wavePhase));
    if (p2) p2.setAttribute("d", voiceWavePath(34 * waveSmooth, 2.3, -wavePhase * 0.85 + 1.2));
    if (p3) p3.setAttribute("d", voiceWavePath(24 * waveSmooth, 1.4, wavePhase * 0.65 + 2.5));

    waveRaf = requestAnimationFrame(voiceWaveTick);
  }

  function voiceWaveStart() {
    waveHasLiveLevel = false;
    waveTarget = 0;
    waveSmooth = 0.08;
    const center = document.getElementById("voice-stage-center");
    if (center) {
      center.dataset.waveMode = "idle";
      center.style.setProperty("--voice-amp", "0");
    }
    voiceApplyLevelRing(0);
    if (voiceReducedMotion()) return;
    if (!waveRaf) waveRaf = requestAnimationFrame(voiceWaveTick);
  }

  function voiceWaveStop() {
    if (waveRaf) {
      cancelAnimationFrame(waveRaf);
      waveRaf = 0;
    }
    waveHasLiveLevel = false;
    waveTarget = 0;
    waveSmooth = 0;
    const center = document.getElementById("voice-stage-center");
    if (center) {
      center.dataset.waveMode = "idle";
      center.style.setProperty("--voice-amp", "0");
    }
    voiceApplyLevelRing(0);
    voiceWaveReset();
  }

  function voiceOnSpeechLevel(rawLevel) {
    const level = Math.max(0, Math.min(1, Number(rawLevel) || 0));
    waveHasLiveLevel = true;
    waveTarget = level;
    const center = document.getElementById("voice-stage-center");
    if (center) {
      center.dataset.waveMode = "live";
      center.style.setProperty("--voice-amp", level.toFixed(3));
    }
    voiceApplyLevelRing(level);
    if (!voiceReducedMotion() && !waveRaf && voiceListening()) {
      waveRaf = requestAnimationFrame(voiceWaveTick);
    }
  }

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

  function voiceUseKiraFace() {
    return typeof kiraTier === "function" ? kiraTier() !== "free" : true;
  }

  // The sheet's centerpiece: Kira on Paid/Pro/Trial (happy at rest, listening
  // while mic is open, proud once action/answer is ready — never the sempoa),
  // or a clean mic orb on Free.
  function voiceKiraMood(mood) {
    const dlg = document.getElementById("voice-dialog");
    const slot = document.getElementById("voice-kira");
    const orb = document.getElementById("voice-orb");
    const isKira = voiceUseKiraFace();
    if (dlg) dlg.dataset.voiceMode = isKira ? "kira" : "orb";
    if (orb) orb.hidden = isKira;
    if (!slot) return;
    slot.hidden = !isKira;
    if (!isKira) {
      slot.dataset.mood = "";
      slot.innerHTML = "";
      return;
    }
    if (typeof kiraSvg !== "function") return;
    if (slot.dataset.mood === mood) return;
    slot.dataset.mood = mood;
    slot.innerHTML = kiraSvg(mood, { idle: mood === "happy", moment: mood !== "happy" });
  }

  function voiceKiraSync() {
    if (voiceListening()) { voiceKiraMood("listening"); return; }
    voiceKiraMood((voiceCurrent && voiceCurrent.amount > 0) || voiceTurns.length ? "proud" : "happy");
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

  // Live speech bubble above Kira / orb: auto-scrolls to newest words and fades
  // out cleanly at the top when overflowing ~4 lines; never fades short text.
  function voiceSyncTranscript(text) {
    const wrap = document.getElementById("voice-transcript-wrap");
    const box = document.getElementById("voice-transcript");
    const askBtn = document.getElementById("voice-ask-btn");
    const clean = String(text || "").trim();
    if (askBtn) askBtn.hidden = !clean;
    if (!wrap || !box) return;
    if (!clean) {
      wrap.hidden = true;
      box.textContent = "";
      box.classList.remove("is-overflow");
      return;
    }
    wrap.hidden = false;
    box.textContent = clean;
    const updateFade = () => {
      const overflowing = box.scrollHeight > box.clientHeight + 2;
      box.classList.toggle("is-overflow", overflowing);
      if (overflowing) box.scrollTop = box.scrollHeight;
    };
    updateFade();
    requestAnimationFrame(updateFade);
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
    if (on) {
      voiceStatus(voiceT("Listening…"), "");
      voiceWaveStart();
    } else {
      voiceWaveStop();
      const el = document.getElementById("voice-status");
      if (el && el.dataset.tone !== "warn") voiceStatus("");
    }
    voiceKiraSync();
    // The bubble's Kira listens too (kira-bubble.js).
    if (typeof kiraBubbleSync === "function") kiraBubbleSync();
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

  // Recognised speech only (typing never goes through here).
  function voiceFill(text) {
    const input = document.getElementById("voice-input");
    if (!input) return;
    const corrected = voiceCorrectHeard(text);
    input.value = corrected;
    voiceSyncTranscript(corrected);
    renderVoicePreview(parseVoiceEntry(corrected));
  }

  // Final words arrived: check local instant navigation first (0 quota),
  // then money write preview (offline first, AI+ upgrade when on),
  // or Kira Q&A assistant when it's a question.
  function voiceAfterSpeech() {
    const input = document.getElementById("voice-input");
    const raw = input ? input.value.trim() : "";
    if (!raw) { voiceKiraSync(); return; }
    voiceSyncTranscript(raw);

    const nav = voiceMatchLocalCommand(raw);
    if (nav) {
      voiceRunAction(nav);
      return;
    }

    const local = parseVoiceEntry(raw);
    if (local.amount > 0) {
      renderVoicePreview(local);
      parseVoiceSmart(raw).then((smart) => {
        if (input && input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
      }).catch(() => {});
      return;
    }

    if (voiceLooksLikeQuestion(raw)) {
      voiceAskKira(raw);
      return;
    }

    renderVoicePreview(local);
    parseVoiceSmart(raw).then((smart) => {
      if (input && input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
    }).catch(() => {});
  }

  async function voiceStartNative(kit) {
    const session = { kit, cancelled: false, partialHandle: null, levelHandle: null };
    voiceNative = session;
    voiceSetListening(true);
    try {
      if (typeof kit.addListener === "function") {
        session.partialHandle = await Promise.resolve(kit.addListener("speechPartial", (d) => {
          if (session.cancelled || voiceNative !== session) return;
          const t = String((d && d.text) || "").trim();
          if (!t) return;
          voiceFill(t);
          voiceKiraHear();
        }));
        session.levelHandle = await Promise.resolve(kit.addListener("speechLevel", (d) => {
          if (session.cancelled || voiceNative !== session) return;
          if (d && typeof d.level === "number") voiceOnSpeechLevel(d.level);
        }));
      }
    } catch {}
    let text = "";
    let denied = false;
    try {
      const res = await kit.speechStart({ lang: voiceLangTag(), hints: voiceSpeechHints() });
      text = String((res && res.text) || "").trim();
    } catch (e) {
      denied = /DENIED|PERMISSION|NOT[-_ ]?ALLOWED/i.test(String((e && (e.code || e.message)) || ""));
    }
    try { if (session.partialHandle && typeof session.partialHandle.remove === "function") session.partialHandle.remove(); } catch {}
    try { if (session.levelHandle && typeof session.levelHandle.remove === "function") session.levelHandle.remove(); } catch {}
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
      if (hint) hint.hidden = voiceTurns.length > 0;
      voiceKiraSync();
      return;
    }

    if (hint) hint.hidden = true;
    box.hidden = false;
    saveBtn.disabled = false;

    const itemsList = document.getElementById("voice-preview-items");
    if (parsed.items && parsed.items.length > 1) {
      voiceRenderItems(parsed, spendLine, itemsList, splitBox, saveBtn);
      voiceKiraSync();
      return;
    }
    if (itemsList) { itemsList.hidden = true; itemsList.replaceChildren(); }
    box.classList.remove("is-multi");

    const money = typeof fmtMoney === "function" ? fmtMoney(parsed.amount) : `RM ${parsed.amount.toFixed(2)}`;
    const kindTag = parsed.entryKind === "income"
      ? voiceT("Income")
      : (parsed.entryKind === "debt" ? voiceT("Pay debt") : voiceT(parsed.category));
    const parts = [money, kindTag, parsed.entryKind === "debt" ? (parsed.debtName || parsed.note) : parsed.note, parsed.walletName].filter(Boolean);
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
        if (parsed.entryKind === "income") {
          saveBtn.textContent = voiceT("Save income");
        } else if (parsed.entryKind === "debt") {
          saveBtn.textContent = voiceT("Record payment");
        } else {
          saveBtn.textContent = voiceT("Save spend");
        }
      }
    }
    voiceKiraSync();
  }

  function voiceMoney(n) {
    return typeof fmtMoney === "function" ? fmtMoney(n) : `RM ${Number(n).toFixed(2)}`;
  }

  // Several spends: one row each (amount · category · note · wallet) with a
  // remove button, the total above, "Save 3 spends" (1.89.0).
  function voiceRenderItems(parsed, spendLine, list, splitBox, saveBtn) {
    const items = parsed.items;
    const n = items.length;
    const plain = items.every((it) => it.entryKind === "expense" && !it.split);
    const box = document.getElementById("voice-preview");
    if (box) box.classList.add("is-multi");
    spendLine.textContent = typeof trn === "function"
      ? (plain
        ? trn(n, "{n} spend · {a}", "{n} spends · {a}", { a: voiceMoney(parsed.amount) })
        : trn(n, "{n} entry", "{n} entries"))
      : `${n} · ${voiceMoney(parsed.amount)}`;
    if (splitBox) { splitBox.hidden = true; splitBox.textContent = ""; }
    if (list) {
      const rows = items.map((it, idx) => {
        const li = document.createElement("li");
        li.className = "voice-item" + (it.entryKind === "income" ? " is-income" : "");
        const txt = document.createElement("span");
        txt.className = "voice-item-text";
        const amt = document.createElement("b");
        amt.textContent = (it.entryKind === "income" ? "+" : "") + voiceMoney(it.amount);
        const tag = it.entryKind === "income" ? voiceT("Income") : (it.entryKind === "debt" ? voiceT("Pay debt") : voiceT(it.category));
        const note = it.entryKind === "debt" ? (it.debtName || it.note) : (it.note !== it.category ? it.note : "");
        txt.append(amt, document.createTextNode(" · " + [tag, note, it.walletName].filter(Boolean).join(" · ")));
        if (it.split && it.split.people && it.split.people.length) {
          const sp = document.createElement("span");
          sp.className = "voice-item-split";
          sp.textContent = voiceT("Split request: {list}", { list: it.split.people.map((x) => `${x.name} (${voiceMoney(x.amount)})`).join(", ") });
          txt.append(sp);
        }
        const drop = document.createElement("button");
        drop.type = "button";
        drop.className = "ghost voice-item-drop";
        drop.setAttribute("aria-label", voiceT("Remove {name}", { name: note || tag || voiceMoney(it.amount) }));
        drop.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        drop.addEventListener("click", () => voiceDropItem(idx));
        li.append(txt, drop);
        return li;
      });
      list.replaceChildren(...rows);
      list.hidden = false;
    }
    saveBtn.textContent = typeof trn === "function"
      ? (plain ? trn(n, "Save {n} spend", "Save {n} spends") : trn(n, "Save {n} entry", "Save {n} entries"))
      : `Save ${n}`;
  }

  // A misheard item goes without dropping the rest.
  function voiceDropItem(idx) {
    const p = voiceCurrent;
    if (!p || !Array.isArray(p.items)) return;
    const items = p.items.filter((_, i) => i !== idx);
    const focusNext = () => {
      const btns = document.querySelectorAll("#voice-preview-items .voice-item-drop");
      const b = btns[Math.min(idx, btns.length - 1)] || document.getElementById("voice-save");
      try { b && b.focus(); } catch {}
    };
    if (items.length > 1) {
      renderVoicePreview(voiceCombine(p.raw, items));
    } else {
      renderVoicePreview(items[0] || null);
    }
    focusNext();
  }

  function voiceSaveItems(p) {
    const date = typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10);
    const booked = p.items.filter((it) => it.amount > 0).map((it) => voiceBook(it, date));
    if (typeof save === "function") save();
    if (typeof renderAll === "function") renderAll();

    const dlg = document.getElementById("voice-dialog");
    voiceStopListening({ cancel: true });
    clearVoiceThread();
    if (dlg && dlg.open) dlg.close();
    if (typeof kiraPlaySaveFeedback === "function") kiraPlaySaveFeedback();
    const n = booked.length;
    const allSpends = booked.every((x) => x.expense && x.expense.kind === "expense");
    if (typeof toast === "function") {
      const spent = voiceRound2(booked.reduce((a, x) => a + (x.destTab === "flow" ? 0 : x.expense.amount), 0));
      toast(typeof trn === "function"
        ? (allSpends
          ? trn(n, "Saved {n} spend · {a}", "Saved {n} spends · {a}", { a: voiceMoney(spent) })
          : trn(n, "Saved {n} entry", "Saved {n} entries"))
        : `Saved ${n}`);
      if (typeof kiraHop === "function") kiraHop();
    }
    // A split request still needs sending: open the first one's share sheet.
    const firstSplit = booked.find((x) => x.splitRec);
    if (firstSplit && typeof splitOpenShare === "function") {
      setTimeout(() => splitOpenShare(firstSplit.splitRec.id, 0).catch(() => {}), 350);
    } else {
      const last = booked[booked.length - 1];
      if (last && typeof kiraHighlightLanding === "function") {
        kiraHighlightLanding({ kind: last.destTab === "flow" ? "income" : "expense", id: last.id, tab: last.destTab, label: last.destLabel });
      }
    }
    return { expenses: booked.map((x) => x.expense), expense: booked[0] ? booked[0].expense : null, splitRec: firstSplit ? firstSplit.splitRec : null, booked };
  }

  // Books one parsed entry (spend, spend + split request, income or debt
  // payment) into state; the caller saves, renders and closes once.
  function voiceBook(p, date) {
    const id = typeof uid === "function" ? uid() : `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let expense = null;
    let splitRec = null;
    let destTab = "dashboard";
    let destLabel = voiceT("Added to Today → View");

    if (p.entryKind === "income") {
      const month = date.slice(0, 7);
      const day = Number(date.slice(8, 10)) || 1;
      const inc = {
        id,
        name: p.note || voiceT("Income"),
        amount: p.amount,
        month,
        day,
        repeatNext: false,
      };
      if (p.walletId) inc.walletId = p.walletId;
      state.income = state.income || [];
      state.income.push(inc);
      expense = inc;
      destTab = "flow";
      destLabel = voiceT("Added to Monthly → View");
    } else if (p.entryKind === "debt" && p.debtId) {
      const debt = (state.debts || []).find((d) => d && d.id === p.debtId);
      if (debt) {
        const applied = Math.min(p.amount, Number(debt.balance) || 0);
        debt.balance = Math.max(0, voiceRound2((Number(debt.balance) || 0) - applied));
        expense = {
          id,
          date,
          amount: p.amount,
          kind: "debt",
          debtId: debt.id,
          debtName: debt.name,
          note: p.note || debt.name,
          createdAt: Date.now(),
        };
        if (p.walletId) expense.walletId = p.walletId;
        state.dailyExpenses = state.dailyExpenses || [];
        state.dailyExpenses.push(expense);
        destTab = "debts";
        destLabel = voiceT("Paid debt → View");
      }
    }

    if (!expense) {
      expense = {
        id,
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
    }

    if (typeof kiraBumpStat === "function") kiraBumpStat("voiceLogged");
    return { id, expense, splitRec, destTab, destLabel };
  }

  function voiceSaveConfirmed() {
    const p = voiceCurrent;
    if (!p || !(p.amount > 0) || !state) return null;
    if (Array.isArray(p.items) && p.items.length > 1) return voiceSaveItems(p);
    const date = typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10);
    const { id, expense, splitRec, destTab, destLabel } = voiceBook(p, date);
    if (typeof save === "function") save();
    if (typeof renderAll === "function") renderAll();

    const dlg = document.getElementById("voice-dialog");
    voiceStopListening({ cancel: true });
    clearVoiceThread();
    if (dlg && dlg.open) dlg.close();

    if (typeof kiraPlaySaveFeedback === "function") kiraPlaySaveFeedback();

    if (splitRec && typeof splitOpenShare === "function") {
      splitOpenShare(splitRec.id, 0).catch(() => {});
    } else if (typeof toast === "function") {
      const m = typeof fmtMoney === "function" ? fmtMoney(p.amount) : `RM ${p.amount.toFixed(2)}`;
      toast(tr("Saved {a}", { a: m }));
      // Kira hops on the toast, like a typed spend (kira.js).
      if (typeof kiraHop === "function") kiraHop();
    }
    if (typeof kiraHighlightLanding === "function") {
      kiraHighlightLanding({ kind: p.entryKind || "expense", id, tab: destTab, label: destLabel });
    }
    return { expense, splitRec };
  }

  // opts.listen: open already listening (holding Kira on Home or bubble hold-pop).
  // opts.fromBubble: float Kira / orb up from the popped center bubble.
  function openVoiceEntry(initialText, opts) {
    const o = opts || {};
    const dlg = document.getElementById("voice-dialog");
    const input = document.getElementById("voice-input");
    if (!dlg || !input) return;
    voiceStatus("");
    clearVoiceThread();
    const micReady = voiceSyncMic();
    input.value = String(initialText || "").trim();
    voiceSyncTranscript(input.value);
    const slot = document.getElementById("voice-kira");
    if (slot) { slot.dataset.mood = ""; slot.innerHTML = ""; }
    const title = document.getElementById("voice-dialog-title");
    if (title) {
      title.textContent = voiceUseKiraFace() ? voiceT("Talk to Kira") : voiceT("Voice entry");
    }
    if (!dlg.open && typeof dlg.showModal === "function") dlg.showModal();

    const center = document.getElementById("voice-stage-center");
    if (center && o.fromBubble && !voiceReducedMotion()) {
      center.classList.remove("is-pop-in");
      void center.offsetWidth;
      center.classList.add("is-pop-in");
      setTimeout(() => center.classList.remove("is-pop-in"), 460);
    }

    if (input.value) {
      const parsed = parseVoiceEntry(input.value);
      renderVoicePreview(parsed);
      parseVoiceSmart(input.value).then((smart) => {
        if (input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
      }).catch(() => {});
    } else {
      renderVoicePreview(null);
      // Holding Kira / bubble: no keyboard over the sheet while listening.
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
     bubble's Talk (#btn-voice) is the accessible way in. */
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
    const askBtn = document.getElementById("voice-ask-btn");
    const saveBtn = document.getElementById("voice-save");
    const cancelBtn = document.getElementById("voice-cancel");
    const closeX = document.getElementById("voice-close-x");
    const transcriptEl = document.getElementById("voice-transcript");
    const editBtn = document.getElementById("voice-edit-btn");

    const closeVoice = () => {
      voiceStopListening({ cancel: true });
      clearVoiceThread();
      if (dlg && dlg.open) dlg.close();
    };

    if (openBtn) openBtn.addEventListener("click", () => openVoiceEntry(""));
    if (cancelBtn) cancelBtn.addEventListener("click", closeVoice);
    if (closeX) closeX.addEventListener("click", closeVoice);
    if (dlg) {
      dlg.addEventListener("close", () => {
        // The close event arrives asynchronously a task after close(); ignore
        // a stale close if #voice-dialog has already been reopened.
        if (dlg.open) return;
        voiceStopListening({ cancel: true });
        voiceStatus("");
        clearVoiceThread();
        if (typeof syncBubbleHoldHint === "function") syncBubbleHoldHint();
      });
    }

    const focusEdit = () => {
      if (!input) return;
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch {}
    };
    if (transcriptEl) transcriptEl.addEventListener("click", focusEdit);
    if (editBtn) editBtn.addEventListener("click", focusEdit);

    const submitInputText = () => {
      const val = input ? input.value.trim() : "";
      if (!val) return;
      const nav = voiceMatchLocalCommand(val);
      if (nav) { voiceRunAction(nav); return; }
      if (voiceCurrent && voiceCurrent.amount > 0) {
        voiceSaveConfirmed();
        return;
      }
      if (voiceLooksLikeQuestion(val)) {
        voiceAskKira(val);
      }
    };

    if (askBtn) askBtn.addEventListener("click", submitInputText);

    if (input) {
      let timer = null;
      input.addEventListener("input", () => {
        const val = input.value;
        voiceSyncTranscript(val);
        renderVoicePreview(parseVoiceEntry(val));
        clearTimeout(timer);
        if (val.trim().length >= 4 && typeof window.aiCloudRun === "function" && !voiceLooksLikeQuestion(val) && !voiceMatchLocalCommand(val)) {
          timer = setTimeout(() => {
            parseVoiceSmart(val).then((smart) => {
              if (input.value.trim() === smart.raw.trim()) renderVoicePreview(smart);
            }).catch(() => {});
          }, 450);
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submitInputText();
        }
      });
    }

    if (micBtn) {
      micBtn.addEventListener("click", () => {
        if (voiceListening()) { voiceStopListening(); return; }
        voiceListen();
      });
    }

    window.addEventListener("duitful:ai-quota", () => {
      if (dlg && dlg.open) {
        voiceStatus(voiceT("Kira reached the monthly limit — using on-device voice."), "warn");
      }
    });

    initVoiceHold();

    if (saveBtn) saveBtn.addEventListener("click", () => voiceSaveConfirmed());
  }

  window.parseVoiceSentence = parseVoiceSentence;
  window.parseVoiceItems = parseVoiceItems;
  window.parseVoiceEntry = parseVoiceEntry;
  window.voiceCorrectHeard = voiceCorrectHeard;
  window.voiceSpeechHints = voiceSpeechHints;
  window.parseVoiceSmart = parseVoiceSmart;
  window.voiceMatchLocalCommand = voiceMatchLocalCommand;
  window.voiceAskKira = voiceAskKira;
  window.voiceOnSpeechLevel = voiceOnSpeechLevel;
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
