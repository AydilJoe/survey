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
    [/\bnama\s+lemak\b/gi, "nasi lemak"],
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
      // Case-insensitive: the spoken match is lower-case, the heard text may say "Two ringgit".
      const at = work.toLowerCase().indexOf(String(amountMatch).toLowerCase());
      work = at >= 0 ? work.slice(0, at) + " " + work.slice(at + amountMatch.length) : work.replace(amountMatch, " ");
    }

    const wHit = voiceMatchWallet(work, wallets);
    if (wHit && wHit.matched) {
      work = work.replace(new RegExp(wHit.matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
    }

    // Detect money-write intent: income vs debt payment vs spend (all still confirm before saving).
    const isIncome = /\b(received|receive|earned|earn|salary|bonus|income|freelance|freelancing|freelancer|commission|komisen|allowance|elaun|side\s+income|dividend|refund|gaji|dapat|terima|pendapatan|upah|found|jumpa|terjumpa|kutip|pungut)\b|工资|薪水|收入|收到|赚了|捡到/i.test(raw)
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
    return voiceItemsByRules(rawText, opts).map(voiceRefine);
  }

  function voiceItemsByRules(rawText, opts) {
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

  /* ---------- Learned from the person's own entries (1.93.0) ----------
     The word lists above are the last fallback. Before them, an item's note
     is matched against what this person has already logged: a correction they
     made on a voice row (state.voiceLearn), then a past entry with the same
     note (income names → money in; spends → that category), then a past entry
     sharing a significant word (≥ 4 letters, not a filler). A word match only
     counts when every past entry with that word agrees, and only changes in /
     out when the sentence had no cue word ("received", "spent"…). Offline,
     every platform; never touches the amount. */
  const VOICE_LEARN_MAX = 200;
  const VOICE_HISTORY_MAX = 400;
  const VOICE_LEARN_FILLER = new Set([
    "income", "spend", "spending", "spent", "expense", "expenses", "from", "with", "dengan", "untuk",
    "this", "that", "today", "tadi", "semalam", "yesterday", "ringgit", "money", "duit", "paid", "bayar",
    "beli", "belanja", "dapat", "terima", "received", "receive", "found", "jumpa", "terjumpa", "also",
    "then", "lepas", "pastu", "lagi", "just", "some", "sikit", "please", "tolong", "record", "catat",
    "bought", "payment", "pembayaran", "pendapatan", "dollars", "bucks", "cents",
  ]);
  const VOICE_SPEND_CUE = /\b(?:spent|spend|spending|paid|pay|bought|buy|beli|belanja|bayar|makan|ate|expenses?|bill)\b|花了|买了|付了/i;
  const VOICE_STRONG_IN_CUE = /\b(?:received|receive|earned|earn|salary|bonus|income|commission|komisen|allowance|elaun|side\s+income|dividend|refund|gaji|pendapatan|upah)\b|工资|薪水|收入|收到|赚了/i;

  function voiceNormNote(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\d+(?:[.,]\d+)*/g, " ")
      .replace(/(?:^|\s)(?:ringgit|rm|myr|sen|dollars|bucks|cents?)(?=\s|$)/g, " ")
      .replace(/块|元|令吉|马币/g, " ")
      .replace(/[^\p{L}\p{N}\s'&-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  }
  function voiceSigWords(norm) {
    return [...new Set(String(norm || "").split(" ").filter((w) => w.length >= 4 && /^\p{L}+$/u.test(w) && !VOICE_LEARN_FILLER.has(w)))];
  }
  function voiceCategories() {
    try { return typeof scanAllCategories === "function" ? scanAllCategories() : []; } catch { return []; }
  }
  function voiceCatIn(cat, cats) {
    const c = String(cat || "").trim().toLowerCase();
    return c ? ((cats || voiceCategories()).find((x) => String(x).toLowerCase() === c) || "") : "";
  }

  // The last ~400 income and spend entries, newest first, cached on the
  // lists' lengths (the parser runs on every keystroke).
  let voiceHistCache = null;
  function voiceHistory() {
    const st = typeof state === "object" && state ? state : null;
    if (!st) return [];
    const inc = Array.isArray(st.income) ? st.income : [];
    const daily = Array.isArray(st.dailyExpenses) ? st.dailyExpenses : [];
    const key = `${inc.length}|${daily.length}`;
    if (voiceHistCache && voiceHistCache.st === st && voiceHistCache.key === key) return voiceHistCache.rows;
    const rows = [];
    for (const x of inc) {
      if (!x || !x.name) continue;
      const day = String(Number(x.day) || 1).padStart(2, "0");
      rows.push({ norm: voiceNormNote(x.name), kind: "income", category: "Income", at: `${x.month || ""}-${day}`, ts: 0 });
    }
    for (const x of daily) {
      if (!x || x.kind !== "expense" || !x.note) continue;
      rows.push({ norm: voiceNormNote(x.note), kind: "expense", category: x.category || "", at: String(x.date || ""), ts: Number(x.createdAt) || 0 });
    }
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.ts - a.ts));
    const out = rows.filter((r) => r.norm).slice(0, VOICE_HISTORY_MAX);
    voiceHistCache = { st, key, rows: out };
    return out;
  }

  // → { kind: "income" | "expense", category, from: "learn" | "history" | "word" } or null.
  function voiceLearnedFor(note) {
    const norm = voiceNormNote(note);
    if (!norm) return null;
    const cats = voiceCategories();
    const fix = (k, c, from) => {
      if (k === "income") return { kind: "income", category: "Income", from };
      if (k !== "expense") return null;
      return { kind: "expense", category: voiceCatIn(c, cats), from };
    };
    const learn = typeof state === "object" && state && state.voiceLearn && typeof state.voiceLearn === "object" ? state.voiceLearn : {};
    if (learn[norm]) { const r = fix(learn[norm].kind, learn[norm].category, "learn"); if (r) return r; }
    const hist = voiceHistory();
    const exact = hist.find((r) => r.norm === norm);
    if (exact) { const r = fix(exact.kind, exact.category, "history"); if (r) return r; }
    for (const w of voiceSigWords(norm)) {
      const re = new RegExp(`(?:^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
      const hits = [
        ...Object.entries(learn).filter(([k]) => re.test(k)).map(([, v]) => v),
        ...hist.filter((r) => re.test(r.norm)),
      ].filter((v) => v && (v.kind === "income" || v.kind === "expense"));
      if (!hits.length) continue;
      const k = hits[0].kind;
      const c = k === "income" ? "Income" : voiceCatIn(hits[0].category, cats);
      // Every past entry with this word must agree, or the word decides nothing.
      if (hits.every((v) => v.kind === k && (k === "income" || voiceCatIn(v.category, cats) === c))) {
        const r = fix(k, c, "word");
        if (r) return r;
      }
    }
    return null;
  }
  function voiceLearnedKind(note) {
    const r = voiceLearnedFor(note);
    return r ? r.kind : "";
  }
  function voiceLearnedCategory(note) {
    const r = voiceLearnedFor(note);
    return r && r.kind === "expense" ? r.category : "";
  }

  // Rules first (parseVoiceSentence), then what this person taught us. Debt
  // payments are left alone; a split is always a spend.
  function voiceRefine(p) {
    if (!p || !(p.amount > 0) || p.entryKind === "debt") return p;
    const seg = String(p.raw || "");
    p.kindFrom = VOICE_STRONG_IN_CUE.test(seg) || (p.entryKind === "expense" && VOICE_SPEND_CUE.test(seg)) || (p.split && p.split.people && p.split.people.length)
      ? "rule"
      : (p.entryKind === "income" ? "weak" : "none");
    p.catFrom = p.entryKind === "expense" && p.category && p.category !== "Others" ? "rule" : "none";
    const hit = voiceLearnedFor(p.note);
    if (!hit) return p;
    const hasSplit = !!(p.split && p.split.people && p.split.people.length);
    const mayFlip = hit.from !== "word" || p.kindFrom !== "rule";
    if (hit.kind === "income" && p.entryKind === "expense" && mayFlip && !hasSplit) {
      p.spendCat = p.category;
      p.entryKind = "income";
      p.category = "Income";
      p.split = null;
      p.kindFrom = hit.from;
      p.learned = true;
    } else if (hit.kind === "expense" && p.entryKind === "income" && mayFlip) {
      p.entryKind = "expense";
      p.category = hit.category || voiceInferCategory(p.note);
      p.kindFrom = hit.from;
      p.catFrom = hit.category ? hit.from : p.catFrom;
      p.learned = true;
    } else if (hit.kind === "expense" && p.entryKind === "expense" && hit.category && hit.category !== p.category) {
      p.category = hit.category;
      p.catFrom = hit.from;
      p.learned = true;
    } else if (hit.kind === p.entryKind) {
      if (p.kindFrom !== "rule") p.kindFrom = hit.from;
      if (hit.kind === "expense" && hit.category) p.catFrom = hit.from;
    }
    return p;
  }

  // A row the person fixed (In / Out, category): remembered on Save.
  function voiceRemember(it) {
    if (!it || !(it.userKind || it.userCat) || typeof state !== "object" || !state) return;
    if (it.entryKind !== "income" && it.entryKind !== "expense") return;
    const norm = voiceNormNote(it.note);
    if (!norm) return;
    const learn = state.voiceLearn && typeof state.voiceLearn === "object" && !Array.isArray(state.voiceLearn) ? state.voiceLearn : {};
    learn[norm] = { kind: it.entryKind, category: it.entryKind === "income" ? "Income" : (it.category || "Others"), at: Date.now() };
    const keys = Object.keys(learn);
    if (keys.length > VOICE_LEARN_MAX) {
      keys.sort((a, b) => (Number(learn[a].at) || 0) - (Number(learn[b].at) || 0));
      for (const k of keys.slice(0, keys.length - VOICE_LEARN_MAX)) delete learn[k];
    }
    state.voiceLearn = learn;
  }

  /* ---------- On-device AI for the rows the rules are unsure of (1.93.0) ----------
     Phone app only, behind aiAllowed(): DuitfulKit.aiReadVoice (Gemini Nano
     on Android, Foundation Models on iOS 26) labels ONE item's words —
     direction, a category from the app's own list, a short note made of the
     item's own words. It never returns an amount: the amount is the rules'.
     Asked only when nothing learned answered and the rules said "Others" or
     guessed the direction from a weak word; ≤ 6 items, 6 s each, badge only.
     The preview is already on screen; answers land row by row, never on a row
     the person touched, and only while the box still says the same thing. */
  const VOICE_AI_MAX = 6;
  const VOICE_AI_TIMEOUT_MS = 6000;
  let voiceAiGen = 0;

  async function voiceAiKit() {
    try {
      if (typeof aiAllowed === "function" && !aiAllowed()) return null;
      const kit = typeof duitfulKit === "function" ? duitfulKit("aiReadVoice") : null;
      if (!kit || typeof kit.aiStatus !== "function") return null;
      const st = await (typeof withTimeout === "function" ? withTimeout(kit.aiStatus(), 2000) : kit.aiStatus());
      return st && st.available ? kit : null;
    } catch { return null; }
  }

  // Android answers {json: "<model text>"}, iOS the fields themselves.
  function parseAiVoiceReply(reply) {
    if (!reply || typeof reply !== "object") return null;
    let f = reply;
    if (typeof reply.json === "string") {
      const m = reply.json.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { f = JSON.parse(m[0]); } catch { return null; }
    }
    if (!f || typeof f !== "object") return null;
    const dir = String(f.direction || "").trim().toLowerCase();
    return {
      direction: dir === "spend" || dir === "income" ? dir : "",
      category: typeof f.category === "string" ? f.category.trim().slice(0, 40) : "",
      note: typeof f.note === "string" ? f.note.trim().slice(0, 60) : "",
    };
  }

  function voiceAiWants(it) {
    if (!it || !(it.amount > 0) || it.entryKind === "debt" || it.learned || it.ai || it.cloud || it.touched || it.userKind || it.userCat) return false;
    if (it.split && it.split.people && it.split.people.length) return false;
    if (it.kindFrom === "learn" || it.kindFrom === "history" || it.kindFrom === "word") return false;
    return (it.entryKind === "expense" && it.category === "Others") || it.kindFrom === "weak";
  }

  // Applies one validated answer to the item; true when something changed.
  function voiceAiApply(it, ans, cats) {
    if (!ans) return false;
    let changed = false;
    const hasSplit = !!(it.split && it.split.people && it.split.people.length);
    if (ans.direction === "income" && it.entryKind === "expense" && !hasSplit) {
      it.spendCat = it.category;
      it.entryKind = "income";
      it.category = "Income";
      it.split = null;
      changed = true;
    } else if (ans.direction === "spend" && it.entryKind === "income") {
      it.entryKind = "expense";
      it.category = voiceInferCategory(it.note);
      changed = true;
    }
    if (it.entryKind === "expense") {
      const cat = voiceCatIn(ans.category, cats);
      if (cat && cat !== it.category && cat !== "Income") { it.category = cat; changed = true; }
    }
    // A note must be the item's own words (no figures): never a made-up name.
    const note = ans.note && !/\d/.test(ans.note) && typeof aiNameInText === "function"
      ? aiNameInText(ans.note, it.raw)
      : (ans.note && !/\d/.test(ans.note) && ans.note.length >= 2 && String(it.raw || "").toLowerCase().includes(ans.note.toLowerCase()) ? ans.note : "");
    if (note && note.toLowerCase() !== String(it.note || "").toLowerCase()) {
      it.note = (note.charAt(0).toUpperCase() + note.slice(1)).slice(0, 80);
      changed = true;
    }
    if (changed) { it.ai = true; it.kindFrom = "ai"; }
    return changed;
  }

  // Runs on whatever the sheet shows now; resolves when every answer is in.
  // One pass per preview: a second ask for the same rows joins the first.
  let voiceAiRun = null;
  function voiceAiLabel() {
    const parsed = voiceCurrent;
    const r = voiceAiRun;
    if (r && parsed && r.gen === voiceAiGen && (r.parsed === parsed || (!!parsed.items && r.parsed.items === parsed.items))) return r.promise;
    const promise = voiceAiLabelRun(parsed);
    const run = { parsed, promise, gen: voiceAiGen };
    voiceAiRun = run;
    promise.finally(() => { if (voiceAiRun === run) voiceAiRun = null; }).catch(() => {});
    return promise;
  }

  async function voiceAiLabelRun(parsed) {
    const gen = ++voiceAiGen;
    if (!parsed || !(parsed.amount > 0)) return 0;
    const items = parsed.items && parsed.items.length > 1 ? parsed.items : [parsed];
    const ask = items.filter(voiceAiWants).slice(0, VOICE_AI_MAX);
    if (!ask.length) return 0;
    const kit = await voiceAiKit();
    if (!kit) return 0;
    const input = document.getElementById("voice-input");
    const raw = input ? input.value.trim() : String(parsed.raw || "").trim();
    const cats = voiceCategories().filter((c) => c !== "Income");
    const still = () => gen === voiceAiGen && voiceCurrent && (voiceCurrent === parsed || (!!parsed.items && voiceCurrent.items === parsed.items))
      && (!input || input.value.trim() === raw);
    let n = 0;
    for (const it of ask) {
      if (!still()) break;
      let ans = null;
      try {
        const call = () => (typeof withTimeout === "function"
          ? withTimeout(kit.aiReadVoice({ text: String(it.raw || "").slice(0, 200), categories: cats.slice(0, 40) }), VOICE_AI_TIMEOUT_MS)
          : kit.aiReadVoice({ text: String(it.raw || "").slice(0, 200), categories: cats.slice(0, 40) }));
        ans = parseAiVoiceReply(typeof withAiThinking === "function" ? await withAiThinking(call) : await call());
      } catch { ans = null; }
      if (!still() || it.userKind || it.userCat || voiceRowBusy(it)) continue;
      const amount = it.amount;
      if (voiceAiApply(it, ans, cats)) {
        it.amount = amount;
        n++;
        voiceRefreshAfterAi(it);
      }
    }
    return n;
  }

  // The person's finger is on this row right now: leave it be.
  function voiceRowBusy(it) {
    const el = document.activeElement;
    if (!el || !el.closest) return false;
    const li = el.closest("[data-voice-idx]");
    if (li && voiceCurrent && voiceCurrent.items) return voiceCurrent.items[Number(li.dataset.voiceIdx)] === it;
    return !!el.closest("#voice-preview-fix") && voiceCurrent === it;
  }

  function voiceRefreshAfterAi(it) {
    const p = voiceCurrent;
    if (!p) return;
    if (p.items && p.items.length > 1) {
      const idx = p.items.indexOf(it);
      const list = document.getElementById("voice-preview-items");
      const li = list && list.querySelector(`[data-voice-idx="${idx}"]`);
      const next = voiceCombine(p.raw, p.items);
      voiceCurrent = next;
      if (li) {
        li.replaceWith(voiceItemRow(it, idx));
        voiceItemsHeader(next);
      } else {
        renderVoicePreview(next);
      }
      return;
    }
    renderVoicePreview(p);
  }

  // After a parse settles (speech ended, text opened, typing paused).
  let voiceAiTimer = 0;
  function voiceAiSoon(ms) {
    clearTimeout(voiceAiTimer);
    voiceAiTimer = setTimeout(() => { voiceAiLabel().then(() => voiceClarifyMaybe()).catch(() => {}); }, ms == null ? 450 : ms);
  }

  // A row the person already changed keeps their choice against late answers.
  function voiceRowTouched(it) {
    return !!(it && (it.touched || it.userKind || it.userCat || it.ai));
  }

  function voiceTouched(p) {
    if (!p) return false;
    const items = p.items && p.items.length > 1 ? p.items : [p];
    return items.some(voiceRowTouched);
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

  /* ---------- AI+ voice-entry v2: the cloud labels, the phone decides (1.98.0) ----------
     The sentence goes to the cloud even when the phone found several items
     (docs/plans/voice-items-ai-plus.md). What the cloud may change, per row:
       - kind, only when the phone's rules had no cue word (kindFrom weak / none)
         and the row isn't a debt payment the phone matched; never "debt" on a
         row the phone didn't match to a debt (it would book as a spend);
       - category, from the app's own list, unless the person's own history
         (learn / history / word) already answered;
       - note, only with words of that row's own text;
       - wallet, by exact name, when the phone found none;
       - split, only where the phone found none (the maths stays here).
     An amount never changes: a cloud item pairs with a phone row only when
     both read the same figure; differing counts keep the phone's rows. When
     the phone found no amount at all, a cloud amount counts only if the
     sentence says that number. Rows the person touched (or the phone's AI
     labelled) are never overwritten. */
  const VOICE_CLOUD_SENTENCE_MAX = 400;

  function voiceCloudKind(rawKind) {
    const k = typeof rawKind === "string" ? rawKind.trim().toLowerCase() : "";
    if (k === "income") return "income";
    if (k === "debt") return "debt";
    if (k === "spend" || k === "expense") return "expense";
    return "";
  }

  // The figures the sentence itself says: digits, or spoken numbers.
  function voiceNumbersSaid(text) {
    const raw = String(text || "");
    const out = [];
    for (const m of raw.match(/\d[\d,]*(?:\.\d{1,2})?/g) || []) {
      const n = Number(m.replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
    const spoken = voiceParseSpokenNumber(raw);
    if (spoken && spoken.value > 0) out.push(spoken.value);
    return out;
  }
  function voiceSameAmount(a, b) {
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.005;
  }

  // Every word of the cloud's note must be in this row's own words.
  function voiceNoteInText(rawNote, text) {
    if (typeof rawNote !== "string") return "";
    const clean = rawNote.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean || /\d/.test(clean)) return "";
    const hay = String(text || "").toLowerCase();
    const cjk = clean.match(/[一-鿿]/g) || [];
    if (cjk.length && !cjk.every((ch) => hay.includes(ch))) return "";
    const words = clean.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter((w) => w.length >= 2 && !/[一-鿿]/.test(w));
    const hayWords = new Set(hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    if (words.length && !words.every((w) => hayWords.has(w))) return "";
    return cjk.length || words.length ? clean : "";
  }

  function voiceBuildCloudSplit(rawSplit, amt) {
    if (!rawSplit || typeof rawSplit !== "object" || !Array.isArray(rawSplit.people) || !rawSplit.people.length) return null;
    const rows = [];
    const seen = new Set();
    for (const src of rawSplit.people.slice(0, 10)) {
      const rawName = typeof src === "string" ? src : (src && src.name) || "";
      const name = voiceMatchContacts([rawName], voiceKnownContacts())[0];
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      rows.push({ name, share: src && typeof src === "object" && Number(src.share) > 0 ? voiceRound2(Number(src.share)) : 0 });
    }
    if (!rows.length) return null;
    // The maths is the phone's: equal shares (you + them), or each person's
    // own figure when every one was said and they fit inside the total.
    const exact = rawSplit.mode === "exact" && rows.every((r) => r.share > 0 && r.share <= amt)
      && voiceRound2(rows.reduce((a, r) => a + r.share, 0)) <= amt;
    if (exact) return { mode: "exact", people: rows.map((r) => ({ name: r.name, amount: r.share })), matched: "" };
    const share = voiceRound2(amt / (rows.length + 1));
    return { mode: "equal", people: rows.map((r) => ({ name: r.name, amount: share })), matched: "" };
  }

  function voiceWalletByName(name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n || typeof state !== "object" || !state || !Array.isArray(state.wallets)) return null;
    return state.wallets.find((w) => w && !w.archived && String(w.name || "").trim().toLowerCase() === n) || null;
  }

  // One cloud item onto one phone row; returns the row itself when nothing changes.
  function voiceApplyCloudToItem(li, ci, opts) {
    if (!li || !ci || typeof ci !== "object") return li;
    if (voiceRowTouched(li)) return li;
    const fresh = !!(opts && opts.fresh);
    const it = { ...li };
    let changed = false;
    const hasSplit = !!(it.split && it.split.people && it.split.people.length);

    // Kind: the cloud fills what the rules couldn't tell.
    const ck = voiceCloudKind(ci.kind);
    const kindOpen = fresh || it.kindFrom === "weak" || it.kindFrom === "none" || !it.kindFrom;
    if (ck && ck !== "debt" && it.entryKind !== "debt" && ck !== it.entryKind && kindOpen) {
      if (ck === "income" && !hasSplit) {
        it.spendCat = it.category && it.category !== "Income" ? it.category : (it.spendCat || "");
        it.entryKind = "income";
        it.category = "Income";
        it.split = null;
        it.kindFrom = "cloud";
        changed = true;
      } else if (ck === "expense") {
        it.entryKind = "expense";
        it.category = it.spendCat || voiceLearnedCategory(it.note) || voiceInferCategory(it.note);
        it.kindFrom = "cloud";
        changed = true;
      }
    }

    // Category: the app's own list, never over the person's own history.
    if (it.entryKind === "expense") {
      const cat = voiceCatIn(ci.category);
      const learnedCat = it.catFrom === "learn" || it.catFrom === "history" || it.catFrom === "word";
      if (cat && cat !== "Income" && cat !== it.category && !learnedCat) {
        it.category = cat;
        it.catFrom = "cloud";
        changed = true;
      }
    }

    // Note: this row's own words only.
    const note = voiceNoteInText(ci.note, it.raw || (opts && opts.text) || "");
    if (note && note.toLowerCase() !== String(it.note || "").toLowerCase()) {
      it.note = note.charAt(0).toUpperCase() + note.slice(1);
      changed = true;
    }

    // Wallet: exact name, only when the phone found none.
    if (!it.walletId) {
      const w = voiceWalletByName(ci.wallet);
      if (w) { it.walletId = w.id; it.walletName = w.name; changed = true; }
    }

    // Split: only where the phone found none; the maths is ours.
    if (it.entryKind === "expense" && !hasSplit && ci.split) {
      const sp = voiceBuildCloudSplit(ci.split, it.amount);
      if (sp) { it.split = sp; it.kindFrom = it.kindFrom === "none" || it.kindFrom === "weak" ? "rule" : it.kindFrom; changed = true; }
    }

    if (!changed) return li;
    it.amount = li.amount; // never the cloud's figure
    it.cloud = true;
    return it;
  }

  // The cloud's validated reply → a merged preview (or `local` unchanged).
  // `res.clarify` (optional) is kept only when its item paired with a row.
  function voiceMergeCloud(local, res, rawText) {
    if (!res || typeof res !== "object") return local;
    const cloudItems = Array.isArray(res.items) && res.items.length
      ? res.items.slice(0, VOICE_MAX_ITEMS)
      : (res.amount !== undefined ? [res] : []);
    if (!cloudItems.length) return local;
    const text = String(rawText || "").trim();
    const localItems = local && local.items && local.items.length > 1
      ? local.items
      : (local && local.amount > 0 ? [local] : []);
    const rowOf = new Map(); // cloud index → local index

    let merged;
    if (!localItems.length) {
      // The phone read no amount: only figures the sentence says.
      const said = voiceNumbersSaid(text);
      const built = [];
      cloudItems.forEach((ci, j) => {
        const amt = Number(ci && ci.amount);
        if (!(amt > 0) || !said.some((n) => voiceSameAmount(n, amt))) return;
        const blank = { raw: text, entryKind: "expense", amount: voiceRound2(amt), category: "Others", note: "", walletId: "", walletName: "", debtId: "", debtName: "", split: null, kindFrom: "none", catFrom: "none", source: "local" };
        const it = voiceApplyCloudToItem(blank, ci, { fresh: true, text });
        it.cloud = true;
        rowOf.set(j, built.length);
        built.push(it);
      });
      if (!built.length) return local;
      merged = built;
    } else {
      const used = new Set();
      let any = false;
      const sameCount = cloudItems.length === localItems.length;
      merged = localItems.map((li, idx) => {
        let pick = -1;
        const atIdx = cloudItems[idx];
        if (sameCount && atIdx && (voiceSameAmount(atIdx.amount, li.amount)
          || (localItems.length === 1 && (atIdx.amount === undefined || atIdx.amount === null)))) pick = idx;
        if (pick < 0) pick = cloudItems.findIndex((ci, j) => !used.has(j) && ci && voiceSameAmount(ci.amount, li.amount));
        if (pick < 0 || used.has(pick)) return li;
        used.add(pick);
        rowOf.set(pick, idx);
        const next = voiceApplyCloudToItem(li, cloudItems[pick], { text });
        if (next !== li) any = true;
        return next;
      });
      if (!any && !res.clarify) return local;
    }

    const out = merged.length === 1
      ? { ...merged[0], raw: merged[0].raw || text, source: merged[0].cloud ? "cloud-ai" : (merged[0].source || "local") }
      : { ...voiceCombine(text, merged), source: "cloud-ai" };
    // AI+'s follow-up question rides along only when its item paired with a row.
    const cl = res.clarify;
    if (cl && typeof cl === "object" && rowOf.has(Number(cl.item))) {
      out.cloudClarify = { row: rowOf.get(Number(cl.item)), field: cl.field, question: cl.question, options: cl.options };
    }
    return out;
  }

  // The cloud's validated reply for this sentence, or null (off, offline, cap).
  async function voiceCloudFetch(rawText) {
    if (!rawText || typeof window.aiCloudRun !== "function") return null;
    try {
      const wallets = (state && Array.isArray(state.wallets) ? state.wallets : []).filter((w) => w && !w.archived).map((w) => w.name).filter(Boolean);
      const categories = voiceCategories();
      const res = await window.aiCloudRun("voice-entry", {
        sentence: String(rawText).slice(0, VOICE_CLOUD_SENTENCE_MAX),
        categories: categories.slice(0, 60),
        wallets: wallets.slice(0, 40),
        people: voiceKnownContacts().slice(0, 30),
      });
      return res && typeof res === "object" ? res : null;
    } catch {
      return null;
    }
  }

  /**
   * Optional Cloud AI+ upgrade (voice-entry v2: several items, 400 chars).
   * The phone's parse, labelled by the cloud where both read the same
   * amounts (voiceMergeCloud); falls back to the phone's parse.
   */
  async function parseVoiceSmart(rawText) {
    const local = parseVoiceEntry(rawText);
    const res = await voiceCloudFetch(rawText);
    if (!res) return local;
    try { return voiceMergeCloud(local, res, rawText); } catch { return local; }
  }

  /* ---------- Kira asks when a row is unclear (1.99.0) ----------
     After the rules, the person's history, AI+ and the phone's AI have had
     their say, a row that is still unclear gets ONE short question in the
     chat with quick replies: money in or out (no cue word, nothing learned,
     "Others"), a split name that sounds like someone already in the split
     list, or a wallet the sentence names that two wallets share. AI+ may
     send its own question (`clarify`, voice-entry v2); it is shown the same
     way. Offline, no quota. A reply changes that row only — never the
     amount — and marks it touched (a direction answer is remembered on Save
     like a manual fix, `voiceRemember`). Skippable; Save works without an
     answer; a question goes as soon as its row changes or leaves the sheet. */
  let voiceClarify = null;
  const voiceClarifyDone = new Set();

  function voiceRows(p) {
    return p ? (p.items && p.items.length > 1 ? p.items : [p]) : [];
  }
  function voiceClarifyKey(it, field) {
    return `${field}|${String((it && it.raw) || "").trim().toLowerCase()}|${it && it.amount}`;
  }
  function voiceClarifyAlive(parsed) {
    const q = voiceClarify;
    return !!(q && voiceRows(parsed).includes(q.it) && !voiceRowTouched(q.it));
  }
  function voiceClarifyClear() {
    if (!voiceClarify) return;
    voiceClarify = null;
    renderVoiceThread();
  }

  // Edit distance ≤ 2 (or one starts the other), same first letter: "Aly" ~ "Ali".
  function voiceNameNear(a, b) {
    const x = String(a || "").toLowerCase();
    const y = String(b || "").toLowerCase();
    if (!x || !y || x === y || x[0] !== y[0]) return false;
    if (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))) return true;
    if (Math.abs(x.length - y.length) > 2) return false;
    const d = Array.from({ length: x.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= y.length; j++) d[0][j] = j;
    for (let i = 1; i <= x.length; i++) {
      for (let j = 1; j <= y.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      }
    }
    return d[x.length][y.length] <= 2;
  }

  function voiceActiveWallets() {
    return typeof state === "object" && state && Array.isArray(state.wallets) ? state.wallets.filter((w) => w && !w.archived && w.name) : [];
  }
  // Wallets sharing a word the row says ("Maybank" → "Maybank savings", "Maybank card").
  function voiceWalletChoices(it) {
    if (!it || it.walletId) return [];
    const wallets = voiceActiveWallets();
    if (wallets.length < 2) return [];
    const words = new Set(String(it.raw || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
    const hits = wallets.filter((w) => String(w.name).toLowerCase().split(/[^\p{L}\p{N}]+/u).some((t) => t.length >= 3 && words.has(t)));
    return hits.length >= 2 ? hits.slice(0, 4) : [];
  }

  function voiceRowWhat(it) {
    const note = it.entryKind === "debt" ? (it.debtName || it.note) : it.note;
    return [voiceMoney(it.amount), note].filter(Boolean).join(" ");
  }

  function voiceLocalClarify(p) {
    const rows = voiceRows(p).filter((it) => it && it.amount > 0 && !voiceRowTouched(it) && it.entryKind !== "debt");
    // 1. Money in or out?
    for (const it of rows) {
      const hasSplit = !!(it.split && it.split.people && it.split.people.length);
      const unclear = !hasSplit && !it.learned && it.kindFrom !== "cloud"
        && (it.kindFrom === "weak" || (it.kindFrom === "none" && it.entryKind === "expense" && it.category === "Others"));
      if (!unclear || voiceClarifyDone.has(voiceClarifyKey(it, "kind"))) continue;
      return {
        it, field: "kind", from: "local",
        question: voiceT("{what}: money in or out?", { what: voiceRowWhat(it) }),
        options: [{ label: voiceT("In"), value: "in" }, { label: voiceT("Out"), value: "out" }],
      };
    }
    // 2. A split name that sounds like someone already in the list.
    const known = voiceKnownContacts();
    if (known.length) {
      for (const it of rows) {
        if (!(it.split && it.split.people && it.split.people.length) || voiceClarifyDone.has(voiceClarifyKey(it, "person"))) continue;
        for (const person of it.split.people) {
          if (known.some((k) => k.toLowerCase() === String(person.name).toLowerCase())) continue;
          const near = known.filter((k) => voiceNameNear(k, person.name)).slice(0, 3);
          if (!near.length) continue;
          return {
            it, field: "person", from: "local", person: person.name,
            question: voiceT("Split with {name}, or did you mean {other}?", { name: person.name, other: near[0] }),
            options: [...near, person.name].map((n) => ({ label: n, value: n })),
          };
        }
      }
    }
    // 3. Which wallet?
    for (const it of rows) {
      if (voiceClarifyDone.has(voiceClarifyKey(it, "wallet"))) continue;
      const choices = voiceWalletChoices(it);
      if (!choices.length) continue;
      return {
        it, field: "wallet", from: "local",
        question: voiceT("Which wallet for {what}?", { what: voiceRowWhat(it) }),
        options: choices.map((w) => ({ label: w.name, value: w.name })),
      };
    }
    return null;
  }

  // AI+'s own question (voice-entry v2 `clarify`, already checked twice).
  function voiceCloudClarify(p) {
    const cl = p && p.cloudClarify;
    if (!cl) return null;
    const it = voiceRows(p)[cl.row];
    if (!it || !(it.amount > 0) || voiceRowTouched(it) || it.entryKind === "debt") return null;
    if (voiceClarifyDone.has(voiceClarifyKey(it, cl.field))) return null;
    const opts = Array.isArray(cl.options) ? cl.options : [];
    let options = [];
    let person = "";
    if (cl.field === "kind") {
      if (it.split && it.split.people && it.split.people.length) return null;
      options = [{ label: voiceT("In"), value: "in" }, { label: voiceT("Out"), value: "out" }];
    } else if (cl.field === "category") {
      if (it.entryKind !== "expense") return null;
      options = opts.map((c) => voiceCatIn(c)).filter((c) => c && c !== "Income").map((c) => ({ label: voiceT(c), value: c }));
    } else if (cl.field === "wallet") {
      options = opts.map((n) => voiceWalletByName(n)).filter(Boolean).map((w) => ({ label: w.name, value: w.name }));
    } else if (cl.field === "person") {
      if (!(it.split && it.split.people && it.split.people.length)) return null;
      person = it.split.people.find((x) => !opts.some((o) => String(o).toLowerCase() === String(x.name).toLowerCase()))?.name || it.split.people[0].name;
      options = opts.map((n) => String(n).trim()).filter(Boolean).slice(0, 4).map((n) => ({ label: n, value: n }));
    }
    if (options.length < 2) return null;
    return { it, field: cl.field, from: "cloud", person, question: String(cl.question || "").slice(0, 140), options };
  }

  // Once the labels have settled: one question, if a row still needs one.
  function voiceClarifyMaybe() {
    const p = voiceCurrent;
    if (voiceClarify && voiceClarifyAlive(p)) return voiceClarify;
    voiceClarify = null;
    const dlg = document.getElementById("voice-dialog");
    if (p && p.amount > 0 && (!dlg || dlg.open)) voiceClarify = voiceCloudClarify(p) || voiceLocalClarify(p);
    renderVoiceThread();
    return voiceClarify;
  }

  // A quick reply: that row only, never its amount.
  function voiceClarifyAnswer(value) {
    const q = voiceClarify;
    const p = voiceCurrent;
    if (!q || !voiceClarifyAlive(p)) { voiceClarifyClear(); return false; }
    const it = q.it;
    const amount = it.amount;
    voiceClarifyDone.add(voiceClarifyKey(it, q.field));
    if (q.field === "kind") {
      voiceSetKind(it, value === "in" ? "income" : "expense");
      it.userKind = true; // "Out" on a spend is an answer too: remembered on Save
    } else if (q.field === "category") {
      const cat = voiceCatIn(value);
      if (cat) { it.category = cat; it.userCat = true; it.catFrom = "user"; }
    } else if (q.field === "wallet") {
      const w = voiceWalletByName(value);
      if (w) { it.walletId = w.id; it.walletName = w.name; }
    } else if (q.field === "person" && it.split && Array.isArray(it.split.people)) {
      const name = String(value || "").trim();
      const row = it.split.people.find((x) => x.name === q.person);
      if (row && name && !it.split.people.some((x) => x !== row && x.name.toLowerCase() === name.toLowerCase())) row.name = name;
    }
    it.touched = true;
    it.ai = false;
    it.amount = amount;
    voiceClarify = null;
    if (p.items && p.items.length > 1) renderVoicePreview(voiceCombine(p.raw, p.items));
    else renderVoicePreview(p);
    voiceClarifyMaybe();
    return true;
  }

  function voiceClarifySkip() {
    const q = voiceClarify;
    if (q && q.it) voiceClarifyDone.add(voiceClarifyKey(q.it, q.field));
    voiceClarify = null;
    voiceClarifyMaybe();
  }

  // Kira's question with its quick replies (local, AI+ voice, or kira-ask).
  function voiceAskRow(question, options, onPick, opts) {
    const row = document.createElement("div");
    row.className = "voice-turn voice-turn--kira voice-turn--ask";
    if (question) {
      const bubble = document.createElement("p");
      bubble.className = "voice-turn-text";
      bubble.textContent = question;
      row.appendChild(bubble);
    }
    if (options && options.length) {
      const replies = document.createElement("div");
      replies.className = "voice-turn-replies";
      replies.setAttribute("role", "group");
      if (question) replies.setAttribute("aria-label", question);
      for (const o of options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "voice-reply-chip";
        btn.textContent = o.label;
        btn.addEventListener("click", () => onPick(o.value));
        replies.appendChild(btn);
      }
      if (opts && opts.onSkip) {
        const skip = document.createElement("button");
        skip.type = "button";
        skip.className = "voice-reply-chip is-skip";
        skip.textContent = voiceT("Skip");
        skip.addEventListener("click", opts.onSkip);
        replies.appendChild(skip);
      }
      row.appendChild(replies);
    }
    return row;
  }

  /* ---------- 2.0 Stage B: Local-First Commands & Kira Assistant Q&A ----------
     Navigation and simple reads run locally for 0 AI+ quota.
     Money writes ALWAYS go through the 1-tap Confirm card (#voice-preview).
     Session multi-turn chat (1.99.0) is kept in memory only (capped at 10
     messages) and wiped as soon as #voice-dialog closes. Kira talks about the
     person's own money in Duitful and how to use Duitful, nothing else, and
     may ask one follow-up (`ask`: a question + ≤ 4 quick replies; a tap sends
     the reply as the next turn). The history sent with each question carries
     Kira's last question, so "yes" / "the second one" make sense. */

  const VOICE_MAX_TURNS = 10;
  const VOICE_HISTORY_TURNS = 8;
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
    voiceCloseStage({ clearThread: false });
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

  // What counts as "about your money in Duitful" for the offline answer.
  const VOICE_TOPIC_RE = /\b(?:spen[dt]|spending|money|duit|wang|balance|baki|budget|bajet|income|pendapatan|gaji|salary|sav(?:e|ing|ings)|simpan(?:an)?|tabung|goals?|wallets?|dompet|bills?|bil|categor(?:y|ies)|kategori|month|bulan|reports?|laporan|split|bahagi|receipts?|resit|statements?|penyata|expenses?|belanja|berapa|how\s+much|left|cash|tunai|pay|bayar|duitful|kira|transfer|zakat|pools?|summary|ringkasan)\b|[钱花费余额预算收入储蓄钱包账单报告分账收据开销]/i;

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

    // Not about money in Duitful: one friendly line back.
    if (!VOICE_TOPIC_RE.test(q)) {
      const words = q.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
      const greet = /^(?:hi|hello|hey|hai|helo|yo|assalamualaikum|salam|thanks|thank\s+you|terima\s+kasih|ok(?:ay)?|yes|no|ya|tak|tidak|nope|你好|谢谢|好的?|是|不是)\b/i.test(q.trim());
      // A few words with no amount and no question: what was it worth?
      if (!greet && words.length && words.length <= 5 && !voiceLooksLikeQuestion(question)) {
        const what = String(question || "").trim().slice(0, 40);
        return {
          reply: voiceT("How much was “{what}”? Say it with the amount, like “RM 12 {what}”.", { what }),
          actions: [],
        };
      }
      return {
        reply: voiceT("I can help with your money in Duitful — like what you spent this month, your debts or your tax relief."),
        actions: [
          { kind: "open_reports", label: voiceT("Open Reports") },
          { kind: "open_debts", label: voiceT("Open Debts") },
        ],
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
    if (!voiceTurns.length && !voiceClarify) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = "";
    voiceTurns.forEach((turn, idx) => {
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
      // Kira's follow-up: quick replies only on the newest turn; a tap is the next turn.
      if (turn.role === "kira" && turn.ask) {
        const last = idx === voiceTurns.length - 1 && !voiceAskBusy;
        el.appendChild(voiceAskRow(turn.ask.question, last ? turn.ask.options.map((o) => ({ label: o, value: o })) : [], (v) => voiceAskKira(v)));
      }
    });
    if (voiceClarify) {
      el.appendChild(voiceAskRow(voiceClarify.question, voiceClarify.options, (v) => voiceClarifyAnswer(v), { onSkip: voiceClarifySkip }));
    }
    // Newest at the bottom, but never with the newest row's first line cut off.
    const last = el.lastElementChild;
    const lastTop = last ? last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
    el.scrollTop = Math.min(el.scrollHeight, Math.max(0, lastTop));
  }

  // One line of history for the next question; Kira's own question rides
  // along so a short reply ("yes", "the second one") makes sense.
  function voiceTurnLine(t) {
    const who = t.role === "user" ? "User" : "Kira";
    let line = `${who}: ${t.text}`;
    if (t.role === "kira" && t.ask) line += ` [Kira asked: ${t.ask.question} Options: ${t.ask.options.join(" / ")}]`;
    return line.slice(0, 260);
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
    voiceClarify = null;
    voiceClarifyDone.clear();
    renderVoiceThread();
  }

  async function voiceAskKira(question, opts) {
    const q = String(question || "").trim();
    const localOnly = !!(opts && opts.local);
    if (!q || voiceAskBusy) return;
    voiceAskBusy = true;
    voiceClarify = null;
    pushVoiceTurn({ role: "user", text: q });
    const input = document.getElementById("voice-input");
    if (input) input.value = "";
    voiceSyncTranscript("");
    renderVoicePreview(null);
    voiceStatus(voiceT("Thinking…"), "");

    const snap = buildKiraLocalSnapshot();
    const summary = buildKiraSummaryString(snap);
    const lang = (window.I18N && window.I18N.lang) || "en";
    const history = voiceTurns.slice(0, -1).slice(-VOICE_HISTORY_TURNS).map(voiceTurnLine);

    let answer = null;
    if (!localOnly && typeof window.aiCloudKiraAsk === "function" && typeof aiCloudAllowed === "function" && aiCloudAllowed()) {
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
    const ask = answer.ask && typeof answer.ask.question === "string" && Array.isArray(answer.ask.options) && answer.ask.options.length >= 2
      ? { question: answer.ask.question, options: answer.ask.options.slice(0, 4) }
      : null;
    pushVoiceTurn({ role: "kira", text: answer.reply, actions: answer.actions || [], ask });
    voiceKiraMood("proud");
  }

  /* ---------- UI: #voice-dialog Siri-style stage, waves & mic ---------- */

  let voiceCurrent = null;
  let voiceRec = null;
  let voiceNative = null;
  let voiceStarting = null;
  let voiceHearTimer = 0;
  const voiceNativeCache = {};

  // Reactive 3-layer SVG waves driven by native speechLevel (~20 Hz, 0..1 float)
  // plus gentle word-arrival surges (waveWordPulse) so web/quiet mics animate too.
  let waveRaf = 0;
  let wavePhase = 0;
  let waveTarget = 0;
  let waveSmooth = 0;
  let waveWordPulse = 0;
  let waveHasLiveLevel = false;

  function voiceReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch { return false; }
  }

  function voiceWavePath(amp, freq, phase) {
    const w = 320;
    const mid = 60;
    const pts = [];
    const steps = 20;
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
    const holdMic = document.getElementById("voice-hold-mic");
    const lv = Math.max(0, Math.min(1, Number(level) || 0));
    // The held bubble's mic pulses with the same level (no-preference only, CSS).
    if (holdMic) holdMic.style.setProperty("--hold-level", lv.toFixed(3));
    if (!ring) return;
    const scale = 1 + lv * 0.35;
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
    waveWordPulse = waveWordPulse > 0.01 ? waveWordPulse * 0.9 : 0;
    const energy = Math.max(waveHasLiveLevel ? waveTarget : 0, waveWordPulse);
    const active = waveHasLiveLevel || waveWordPulse > 0.01;
    const target = active ? (0.18 + energy * 0.82) : 0.18;
    waveSmooth += (target - waveSmooth) * (active ? 0.24 : 0.06);
    wavePhase += active ? (0.095 + waveSmooth * 0.11) : 0.042;

    const p1 = document.getElementById("voice-wave-1");
    const p2 = document.getElementById("voice-wave-2");
    const p3 = document.getElementById("voice-wave-3");
    if (p1) p1.setAttribute("d", voiceWavePath(46 * waveSmooth, 1.9, wavePhase));
    if (p2) p2.setAttribute("d", voiceWavePath(36 * waveSmooth, 2.5, -wavePhase * 1.15 + 1.2));
    if (p3) p3.setAttribute("d", voiceWavePath(28 * waveSmooth, 1.4, wavePhase * 0.75 + 2.5));

    waveRaf = requestAnimationFrame(voiceWaveTick);
  }

  function voiceWaveStart() {
    waveHasLiveLevel = false;
    waveTarget = 0;
    waveWordPulse = 0;
    waveSmooth = 0.12;
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
    waveWordPulse = 0;
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
    if (!voiceReducedMotion()) {
      waveWordPulse = Math.max(waveWordPulse, 0.72 + Math.random() * 0.32);
      if (!waveRaf && voiceListening()) waveRaf = requestAnimationFrame(voiceWaveTick);
    }
    const svg = document.querySelector("#voice-kira svg.kira--listening");
    if (!svg) return;
    svg.classList.remove("is-hearing");
    void svg.getBoundingClientRect();
    svg.classList.add("is-hearing");
    clearTimeout(voiceHearTimer);
    voiceHearTimer = setTimeout(() => svg.classList.remove("is-hearing"), 420);
  }

  let voiceFlightTimer = 0;

  function voiceClearFlight() {
    if (voiceFlightTimer) { clearTimeout(voiceFlightTimer); voiceFlightTimer = 0; }
    const dlg = document.getElementById("voice-dialog");
    const fig = document.getElementById("voice-figure");
    if (dlg) dlg.classList.remove("is-launching");
    if (fig) {
      fig.classList.remove("is-flying-in");
      fig.style.removeProperty("--flight-dx");
      fig.style.removeProperty("--flight-dy");
    }
  }

  function voiceCaptureFigure() {
    if (voiceReducedMotion()) return null;
    const dlg = document.getElementById("voice-dialog");
    if (!dlg || !dlg.open) return null;
    const slot = document.getElementById("voice-kira");
    const orb = document.getElementById("voice-orb");
    const el = slot && !slot.hidden && slot.innerHTML.trim()
      ? slot
      : (orb && !orb.hidden ? orb : null);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      html: el.innerHTML,
      isOrb: el === orb,
    };
  }

  function voiceLaunchReturnFlight(snap) {
    if (!snap || voiceReducedMotion()) return;
    const bubble = document.getElementById("kira-bubble");
    if (!bubble) return;
    const br = bubble.getBoundingClientRect();
    if (!br.width || !br.height) return;
    const from = snap.rect;
    const dx = Math.round((br.left + br.width / 2) - (from.left + from.width / 2));
    const dy = Math.round((br.top + br.height / 2) - (from.top + from.height / 2));
    const ghost = document.createElement("div");
    ghost.className = snap.isOrb ? "kira-return-flight is-orb" : "kira-return-flight";
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.left = `${Math.round(from.left)}px`;
    ghost.style.top = `${Math.round(from.top)}px`;
    ghost.style.width = `${Math.round(from.width)}px`;
    ghost.style.height = `${Math.round(from.height)}px`;
    ghost.innerHTML = snap.html;
    document.body.appendChild(ghost);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ghost.style.transform = `translate(${dx}px, ${dy}px) scale(0.32)`;
        ghost.style.opacity = "0";
      });
    });
    setTimeout(() => {
      if (typeof window.kiraSquishBubble === "function") window.kiraSquishBubble();
    }, 280);
    setTimeout(() => ghost.remove(), 400);
  }

  function voiceCloseStage(opts) {
    const o = opts || {};
    const dlg = document.getElementById("voice-dialog");
    const snap = o.animateReturn !== false ? voiceCaptureFigure() : null;
    voiceHoldExit();
    voiceStopListening({ cancel: true });
    if (o.clearThread !== false) clearVoiceThread();
    voiceClearFlight();
    if (dlg && dlg.open) dlg.close();
    if (snap) voiceLaunchReturnFlight(snap);
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
    // A cancel also drops final words still on their way from an earlier stop.
    if (cancel) voiceDropPendingStop();
    if (voiceRec) {
      const rec = voiceRec;
      voiceRec = null;
      if (cancel) rec.duitfulCancelled = true;
      else voicePendingStop = { rec };
      try { if (cancel && typeof rec.abort === "function") rec.abort(); else rec.stop(); } catch {}
    }
    if (voiceNative) {
      const s = voiceNative;
      voiceNative = null;
      if (cancel) s.cancelled = true;
      else voicePendingStop = { session: s };
      try { Promise.resolve(s.kit.speechStop()).catch(() => {}); } catch {}
    }
    voiceSetListening(false);
  }

  /* A plain stop leaves the recogniser's final words on their way: the
     native speechStart resolves, or the browser's onend fires. The slide to
     Save waits for them (voiceWaitFinal), then drops anything later. */
  let voicePendingStop = null;
  let voiceFinalWaiters = [];

  function voiceFinalArrived(ref) {
    const p = voicePendingStop;
    if (!p || (ref && p.session !== ref && p.rec !== ref)) return;
    voicePendingStop = null;
    const w = voiceFinalWaiters;
    voiceFinalWaiters = [];
    w.forEach((f) => f());
  }

  function voiceDropPendingStop() {
    const p = voicePendingStop;
    if (!p) return;
    if (p.session) p.session.cancelled = true;
    if (p.rec) p.rec.duitfulCancelled = true;
    voiceFinalArrived();
  }

  function voiceWaitFinal(ms) {
    if (!voicePendingStop) return Promise.resolve();
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      voiceFinalWaiters.push(fin);
      setTimeout(fin, ms);
    });
  }

  // Recognised speech only (typing never goes through here).
  function voiceFill(text) {
    const input = document.getElementById("voice-input");
    if (!input) return;
    const corrected = voiceCorrectHeard(text);
    input.value = corrected;
    voiceSyncTranscript(corrected);
    voiceAiGen++;
    renderVoicePreview(parseVoiceEntry(corrected));
  }

  // The AI+ upgrade (when on), then the phone's AI for rows still unsure. A
  // late answer never replaces rows the person (or the phone's AI) changed.
  // The cloud's labels land on whatever the sheet shows now (rows dropped
  // or changed while the call was out stay as the person left them), then
  // then the phone's AI for the rows still unclear, then — if a row still
  // needs it — one question (voiceClarifyMaybe).
  function voiceSmartThenAi(raw) {
    const input = document.getElementById("voice-input");
    const text = String(raw || "").trim();
    return voiceCloudFetch(text).then((res) => {
      if (!input || input.value.trim() !== text) return 0;
      if (res) {
        const base = voiceCurrent && voiceCurrent.amount > 0 ? voiceCurrent : parseVoiceEntry(text);
        const merged = voiceMergeCloud(base, res, text);
        if (merged !== base) renderVoicePreview(merged);
      }
      return voiceAiLabel().then((n) => {
        if (input.value.trim() === text) voiceClarifyMaybe();
        return n;
      });
    }).catch(() => 0);
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
      voiceSmartThenAi(raw);
      return;
    }

    if (voiceLooksLikeQuestion(raw) || voiceTurns.length) {
      voiceAskKira(raw);
      return;
    }

    renderVoicePreview(local);
    voiceSmartThenAi(raw);
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
    if (session.cancelled) { voiceFinalArrived(session); return; }
    if (denied) voiceShowDenied();
    if (text) voiceFill(text);
    voiceAfterSpeech();
    voiceFinalArrived(session);
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
      voiceFinalArrived(rec);
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
    if (voiceClarify && !voiceClarifyAlive(parsed)) { voiceClarify = null; renderVoiceThread(); }
    const box = document.getElementById("voice-preview");
    const spendLine = document.getElementById("voice-preview-spend");
    const splitBox = document.getElementById("voice-preview-split");
    const saveBtn = document.getElementById("voice-save");
    const hint = document.getElementById("voice-hint");
    if (!box || !spendLine || !saveBtn) return;

    const fixRow = document.getElementById("voice-preview-fix");
    if (!parsed || !(parsed.amount > 0)) {
      if (fixRow) { fixRow.hidden = true; fixRow.replaceChildren(); }
      box.hidden = true;
      saveBtn.disabled = true;
      saveBtn.textContent = typeof tr === "function" ? tr("Save spend") : "Save spend";
      if (hint) hint.hidden = voiceTurns.length > 0;
      voiceKiraSync();
      voiceHoldSync();
      return;
    }

    if (hint) hint.hidden = true;
    box.hidden = false;
    saveBtn.disabled = false;

    const itemsList = document.getElementById("voice-preview-items");
    if (parsed.items && parsed.items.length > 1) {
      voiceRenderItems(parsed, spendLine, itemsList, splitBox, saveBtn);
      voiceKiraSync();
      voiceHoldSync();
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
    if (fixRow) {
      const keep = document.activeElement && fixRow.contains(document.activeElement) ? document.activeElement.dataset.voiceRole : "";
      const fix = voiceFixControls(parsed, () => renderVoicePreview(parsed));
      if (fix) fixRow.replaceChildren(fix); else fixRow.replaceChildren();
      fixRow.hidden = !fix;
      if (keep) {
        const el = fixRow.querySelector(`[data-voice-role="${keep}"]`);
        try { el && el.focus({ preventScroll: true }); } catch {}
      }
    }

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
    voiceHoldSync();
  }

  function voiceMoney(n) {
    return typeof fmtMoney === "function" ? fmtMoney(n) : `RM ${Number(n).toFixed(2)}`;
  }

  // Several spends: one row each (amount · note · wallet, then the In / Out
  // toggle and the category chip) with a remove button, the total above,
  // "Save 3 spends" (1.89.0; one-tap fixes 1.93.0).
  function voiceRenderItems(parsed, spendLine, list, splitBox, saveBtn) {
    const box = document.getElementById("voice-preview");
    if (box) box.classList.add("is-multi");
    const fix = document.getElementById("voice-preview-fix");
    if (fix) { fix.hidden = true; fix.replaceChildren(); }
    if (splitBox) { splitBox.hidden = true; splitBox.textContent = ""; }
    if (list) {
      // Keep the focused control across a re-render (a chip just changed).
      const act = document.activeElement;
      const actLi = act && act.closest ? act.closest("[data-voice-idx]") : null;
      const keep = actLi && list.contains(actLi) ? { idx: actLi.dataset.voiceIdx, role: act.dataset.voiceRole || "" } : null;
      list.replaceChildren(...parsed.items.map((it, idx) => voiceItemRow(it, idx)));
      list.hidden = false;
      if (keep && keep.role) {
        const el = list.querySelector(`[data-voice-idx="${keep.idx}"] [data-voice-role="${keep.role}"]`);
        try { el && el.focus({ preventScroll: true }); } catch {}
      }
    }
    voiceItemsHeader(parsed, spendLine, saveBtn);
  }

  function voiceItemsHeader(parsed, spendLine, saveBtn) {
    const line = spendLine || document.getElementById("voice-preview-spend");
    const btn = saveBtn || document.getElementById("voice-save");
    const items = parsed.items;
    const n = items.length;
    const plain = items.every((it) => it.entryKind === "expense" && !it.split);
    if (line) {
      line.textContent = typeof trn === "function"
        ? (plain
          ? trn(n, "{n} spend · {a}", "{n} spends · {a}", { a: voiceMoney(parsed.amount) })
          : trn(n, "{n} entry", "{n} entries"))
        : `${n} · ${voiceMoney(parsed.amount)}`;
    }
    if (btn) {
      btn.textContent = typeof trn === "function"
        ? (plain ? trn(n, "Save {n} spend", "Save {n} spends") : trn(n, "Save {n} entry", "Save {n} entries"))
        : `Save ${n}`;
    }
  }

  // The phone's AI filled this row: the statement review's "AI" tag.
  function voiceAiTag() {
    const t = voiceT("Suggested by your phone's AI");
    const tag = document.createElement("span");
    tag.className = "stmt-tag stmt-ai voice-ai-tag";
    tag.setAttribute("translate", "no");
    tag.title = t;
    tag.setAttribute("aria-label", t);
    tag.textContent = "AI";
    return tag;
  }

  // In / Out and the category, one tap each. Split rows are always a spend
  // (no toggle); debt payments keep their own line.
  function voiceFixControls(it, onChange) {
    const wrap = document.createElement("span");
    wrap.className = "voice-fix";
    if (it.entryKind === "debt") return null;
    const hasSplit = !!(it.split && it.split.people && it.split.people.length);
    const income = it.entryKind === "income";
    if (!hasSplit) {
      const kind = document.createElement("button");
      kind.type = "button";
      kind.className = "voice-chip voice-kind" + (income ? " is-in" : "");
      kind.dataset.voiceRole = "kind";
      kind.setAttribute("aria-pressed", income ? "true" : "false");
      kind.setAttribute("aria-label", voiceT("Money in"));
      kind.textContent = income ? voiceT("In") : voiceT("Out");
      kind.addEventListener("click", () => {
        voiceSetKind(it, it.entryKind === "income" ? "expense" : "income");
        onChange();
      });
      wrap.append(kind);
    }
    // Money in has no category: the "In" chip says it all.
    if (!income) {
      const sel = document.createElement("select");
      sel.className = "voice-chip voice-cat";
      sel.dataset.voiceRole = "cat";
      sel.setAttribute("aria-label", voiceT("Category"));
      const cats = voiceCategories().filter((c) => c !== "Income");
      if (it.category && !cats.includes(it.category)) cats.unshift(it.category);
      for (const c of cats) {
        const o = document.createElement("option");
        o.value = c;
        // Stored names stay as typed; the built-in ones read in the app's language.
        o.textContent = voiceT(c);
        if (c === it.category) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        it.category = sel.value;
        it.userCat = true;
        it.touched = true;
        it.ai = false;
        onChange();
      });
      wrap.append(sel);
    }
    if (it.ai) wrap.append(voiceAiTag());
    return wrap;
  }

  function voiceSetKind(it, kind) {
    if (kind === it.entryKind) return;
    if (kind === "income") {
      if (it.split && it.split.people && it.split.people.length) return;
      it.spendCat = it.category && it.category !== "Income" ? it.category : (it.spendCat || "");
      it.entryKind = "income";
      it.category = "Income";
    } else {
      it.entryKind = "expense";
      it.category = it.spendCat || voiceLearnedCategory(it.note) || voiceInferCategory(it.note);
    }
    it.userKind = true;
    it.touched = true;
    it.ai = false;
  }

  function voiceItemRow(it, idx) {
    const li = document.createElement("li");
    li.className = "voice-item" + (it.entryKind === "income" ? " is-income" : "");
    li.dataset.voiceIdx = String(idx);
    const txt = document.createElement("span");
    txt.className = "voice-item-text";
    const amt = document.createElement("b");
    amt.textContent = (it.entryKind === "income" ? "+" : "") + voiceMoney(it.amount);
    const tag = it.entryKind === "income" ? voiceT("Income") : (it.entryKind === "debt" ? voiceT("Pay debt") : voiceT(it.category));
    const note = it.entryKind === "debt" ? (it.debtName || it.note) : (it.note !== it.category ? it.note : "");
    const words = it.entryKind === "debt" ? [tag, note, it.walletName] : [note, it.walletName];
    const rest = words.filter(Boolean).join(" · ");
    txt.append(amt, document.createTextNode(rest ? " · " + rest : ""));
    if (it.split && it.split.people && it.split.people.length) {
      const sp = document.createElement("span");
      sp.className = "voice-item-split";
      sp.textContent = voiceT("Split request: {list}", { list: it.split.people.map((x) => `${x.name} (${voiceMoney(x.amount)})`).join(", ") });
      txt.append(sp);
    }
    const fix = voiceFixControls(it, () => {
      const p = voiceCurrent;
      if (p && p.items) renderVoicePreview(voiceCombine(p.raw, p.items));
    });
    if (fix) txt.append(fix);
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "ghost voice-item-drop";
    drop.setAttribute("aria-label", voiceT("Remove {name}", { name: note || tag || voiceMoney(it.amount) }));
    drop.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    drop.addEventListener("click", () => voiceDropItem(idx));
    li.append(txt, drop);
    return li;
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

  function voiceSaveItems(p, opts) {
    const undo = !!(opts && opts.undo);
    const date = typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10);
    p.items.forEach(voiceRemember);
    const booked = p.items.filter((it) => it.amount > 0).map((it) => voiceBook(it, date));
    if (typeof save === "function") save();
    if (typeof renderAll === "function") renderAll();

    voiceCloseStage();
    if (typeof kiraPlaySaveFeedback === "function") kiraPlaySaveFeedback();
    const n = booked.length;
    const allSpends = booked.every((x) => x.expense && x.expense.kind === "expense");
    if (typeof toast === "function") {
      const spent = voiceRound2(booked.reduce((a, x) => a + (x.destTab === "flow" ? 0 : x.expense.amount), 0));
      toast(typeof trn === "function"
        ? (allSpends
          ? trn(n, "Saved {n} spend · {a}", "Saved {n} spends · {a}", { a: voiceMoney(spent) })
          : trn(n, "Saved {n} entry", "Saved {n} entries"))
        : `Saved ${n}`, undo ? { action: voiceUndoAction(booked) } : undefined);
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
    let debtBefore = null;

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
        // Undo puts back exactly this figure (the payment may be clamped).
        debtBefore = { id: debt.id, balance: debt.balance };
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
    return { id, expense, splitRec, destTab, destLabel, debtBefore };
  }

  /* Undo after a slide to Save: takes out exactly what voiceBook added (the
     spends, the income, a split record, a debt's balance as it was) — by id,
     so anything else that arrived meanwhile stays. */
  function voiceUndoAction(booked) {
    return { label: voiceT("Undo"), run: () => voiceUndoBooked(booked) };
  }

  function voiceUndoBooked(booked) {
    if (!state || !Array.isArray(booked)) return;
    for (const x of booked) {
      if (!x || !x.expense) continue;
      const id = x.expense.id;
      if (x.destTab === "flow") {
        state.income = (state.income || []).filter((i) => i.id !== id);
      } else if (typeof removeDailyEntry === "function") {
        removeDailyEntry(id);
      } else {
        state.dailyExpenses = (state.dailyExpenses || []).filter((e) => e.id !== id);
      }
      if (x.debtBefore) {
        const d = (state.debts || []).find((y) => y && y.id === x.debtBefore.id);
        if (d) d.balance = x.debtBefore.balance;
      }
      if (x.splitRec && typeof splitOutList === "function") {
        const list = splitOutList();
        const at = list.findIndex((r) => r && r.id === x.splitRec.id);
        if (at >= 0) list.splice(at, 1);
      }
      if (state.kiraStats && Number(state.kiraStats.voiceLogged) > 0) state.kiraStats.voiceLogged -= 1;
    }
    if (typeof save === "function") save();
    if (typeof renderAll === "function") renderAll();
    if (typeof toast === "function") toast(voiceT("Removed"));
  }

  // opts.undo: the toast offers Undo (a slide to Save, which never carries a split).
  function voiceSaveConfirmed(opts) {
    const p = voiceCurrent;
    if (!p || !(p.amount > 0) || !state) return null;
    if (Array.isArray(p.items) && p.items.length > 1) return voiceSaveItems(p, opts);
    const date = typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10);
    voiceRemember(p);
    const booked = voiceBook(p, date);
    const { id, expense, splitRec, destTab, destLabel } = booked;
    if (typeof save === "function") save();
    if (typeof renderAll === "function") renderAll();

    voiceCloseStage();

    if (typeof kiraPlaySaveFeedback === "function") kiraPlaySaveFeedback();

    if (splitRec && typeof splitOpenShare === "function") {
      splitOpenShare(splitRec.id, 0).catch(() => {});
    } else if (typeof toast === "function") {
      const m = typeof fmtMoney === "function" ? fmtMoney(p.amount) : `RM ${p.amount.toFixed(2)}`;
      toast(tr("Saved {a}", { a: m }), opts && opts.undo ? { action: voiceUndoAction([booked]) } : undefined);
      // Kira hops on the toast, like a typed spend (kira.js).
      if (typeof kiraHop === "function") kiraHop();
    }
    if (typeof kiraHighlightLanding === "function") {
      kiraHighlightLanding({ kind: p.entryKind || "expense", id, tab: destTab, label: destLabel });
    }
    return { expense, splitRec, booked: [booked] };
  }

  // opts.listen: open already listening (holding Kira on Home or bubble hold-pop).
  // opts.fromBubble: float Kira / orb up continuously from the popped center bubble.
  // opts.hold: { pointerId } — the finger is still on the bubble: slide mode
  // (voiceHoldBegin); letting go saves, cancels or leaves the rows to check.
  function openVoiceEntry(initialText, opts) {
    const o = opts || {};
    const dlg = document.getElementById("voice-dialog");
    const input = document.getElementById("voice-input");
    if (!dlg || !input) return;
    if (!dlg.open) {
      voiceStopListening({ cancel: true });
      voiceWaveStop();
    }
    voiceClearFlight();
    voiceStatus("");
    clearVoiceThread();
    if (typeof syncAiQualityPickers === "function") syncAiQualityPickers();
    const micReady = voiceSyncMic();
    input.value = String(initialText || "").trim();
    voiceSyncTranscript(input.value);
    const slot = document.getElementById("voice-kira");
    if (slot) { slot.dataset.mood = ""; slot.innerHTML = ""; }
    const title = document.getElementById("voice-dialog-title");
    if (title) {
      title.textContent = voiceUseKiraFace() ? voiceT("Talk to Kira") : voiceT("Voice entry");
    }
    const bubbleBtn = document.getElementById("kira-bubble");
    const originRect = o.bubbleRect || (o.fromBubble && bubbleBtn ? bubbleBtn.getBoundingClientRect() : null);

    if (!dlg.open && typeof dlg.showModal === "function") dlg.showModal();
    voiceHoldExit();
    if (o.hold && o.listen) voiceHoldBegin(o.hold, originRect);

    const fig = document.getElementById("voice-figure");
    if (fig && o.fromBubble && !voiceReducedMotion()) {
      const targetRect = fig.getBoundingClientRect();
      let dx = 0;
      let dy = Math.round((window.innerHeight || 640) * 0.36);
      if (originRect && originRect.width && targetRect.width) {
        dx = Math.round((originRect.left + originRect.width / 2) - (targetRect.left + targetRect.width / 2));
        dy = Math.round((originRect.top + originRect.height / 2) - (targetRect.top + targetRect.height / 2));
      }
      fig.style.setProperty("--flight-dx", `${dx}px`);
      fig.style.setProperty("--flight-dy", `${dy}px`);
      dlg.classList.remove("is-launching");
      fig.classList.remove("is-flying-in");
      void fig.offsetWidth;
      dlg.classList.add("is-launching");
      fig.classList.add("is-flying-in");
      voiceFlightTimer = setTimeout(() => voiceClearFlight(), 760);
    }

    if (input.value) {
      const parsed = parseVoiceEntry(input.value);
      renderVoicePreview(parsed);
      voiceSmartThenAi(input.value);
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
        // Nothing can hear on this device: the slide has nothing to finish.
        if (!m && voiceSlide) voiceHoldRelease("review");
        if (voiceSlide) return;
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

  /* ---------- Hold the bubble: slide to Save or Cancel (1.97.0) ----------
     Spec: docs/plans/voice-hold-gesture.md (the WhatsApp voice-note pattern).
     While the finger stays down after the bubble's hold-pop, the bubble is the
     mic (#voice-hold-mic, at the bubble's own rect, pulsing with speechLevel),
     Cancel sits up-left and Save up-right (#voice-hold-cancel / -save, 64px,
     hit within VOICE_SLIDE_HIT of the centre). Save is armed only when there
     is an amount and no split row (a split request is always sent knowingly,
     from review). Letting go on armed Save stops the mic, waits for the final
     words (≤ VOICE_SLIDE_FINAL_MS), re-parses locally and saves with Undo; on
     Cancel closes; anywhere else, pointercancel, blur or the app going to the
     background stops and leaves the rows to check with the tap buttons. The
     targets are aria-hidden: the tap buttons are the accessible way. */
  const VOICE_SLIDE_HIT = 44;
  const VOICE_SLIDE_FINAL_MS = 600;
  const VOICE_SLIDE_HINT_KEY = "duitful.holdSlideHint";
  let voiceSlide = null;

  function voiceHasSplit(it) {
    return !!(it && it.split && Array.isArray(it.split.people) && it.split.people.length);
  }

  // Something to save, and nothing that would send a request.
  function voiceHoldArmed() {
    const p = voiceCurrent;
    if (!p || !(p.amount > 0)) return false;
    const items = Array.isArray(p.items) && p.items.length ? p.items : [p];
    if (!items.some((it) => it && it.amount > 0)) return false;
    return !voiceHasSplit(p) && !items.some(voiceHasSplit);
  }

  // Cancel up-left, Save up-right of the bubble on a small arc (135° / 45°),
  // or beside it on the rail / sidebar; kept on screen.
  function voiceHoldLayout(rect) {
    const dlg = document.getElementById("voice-dialog");
    const mic = document.getElementById("voice-hold-mic");
    const cancel = document.getElementById("voice-hold-cancel");
    const saveT = document.getElementById("voice-hold-save");
    const hint = document.getElementById("voice-hold-hint");
    if (!dlg || !mic || !cancel || !saveT || !rect) return null;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // The rect is the charged (scaled) bubble's: its centre, the resting size.
    const bubble = document.getElementById("kira-bubble");
    const size = Math.max(48, Math.round((bubble && bubble.offsetWidth) || rect.width || 64));
    const cx = rect.left + (rect.width || size) / 2;
    const cy = rect.top + (rect.height || size) / 2;
    mic.style.left = `${Math.round(cx - size / 2)}px`;
    mic.style.top = `${Math.round(cy - size / 2)}px`;
    mic.style.width = `${size}px`;
    mic.style.height = `${size}px`;
    const side = typeof radialSide === "function" && radialSide();
    const half = 32;
    const clampX = (x) => Math.min(vw - half - 8, Math.max(half + 8, x));
    const clampY = (y) => Math.min(vh - half - 8, Math.max(half + 8, y));
    let pts;
    if (side) {
      pts = { cancel: { x: cx + 104, y: cy - 52 }, save: { x: cx + 104, y: cy + 52 } };
    } else {
      const r = Math.max(100, size / 2 + 66);
      const k = Math.SQRT1_2;
      pts = { cancel: { x: cx - r * k, y: cy - r * k }, save: { x: cx + r * k, y: cy - r * k } };
    }
    for (const key of ["cancel", "save"]) {
      pts[key].x = Math.round(clampX(pts[key].x));
      pts[key].y = Math.round(clampY(pts[key].y));
      const el = key === "cancel" ? cancel : saveT;
      el.style.left = `${pts[key].x}px`;
      el.style.top = `${pts[key].y}px`;
    }
    const top = Math.min(pts.cancel.y, pts.save.y) - half;
    if (hint) {
      hint.style.left = `${Math.round(side ? cx + 104 : cx)}px`;
      hint.style.top = `${Math.round(top - 10)}px`;
    }
    // Keep the rows above the targets (and the hint, when it shows).
    const d = dlg.getBoundingClientRect();
    const hintH = hint && !hint.hidden ? 40 : 0;
    const zone = side ? 0 : Math.max(0, Math.round(d.bottom - (top - 14 - hintH)));
    dlg.style.setProperty("--voice-hold-zone", `${zone}px`);
    return pts;
  }

  function voiceHoldSync() {
    const h = voiceSlide;
    const saveT = document.getElementById("voice-hold-save");
    if (!h || !saveT) return;
    const armed = voiceHoldArmed();
    saveT.classList.toggle("is-armed", armed);
    if (!armed && h.over === "save") voiceHoldOver("");
  }

  function voiceHoldOver(which) {
    const h = voiceSlide;
    if (!h || h.over === which) return;
    h.over = which;
    const cancel = document.getElementById("voice-hold-cancel");
    const saveT = document.getElementById("voice-hold-save");
    if (cancel) cancel.classList.toggle("is-over", which === "cancel");
    if (saveT) saveT.classList.toggle("is-over", which === "save");
    if (which && typeof kiraHaptic === "function") kiraHaptic(10, "LIGHT");
  }

  function voiceHoldHit(x, y) {
    const h = voiceSlide;
    if (!h || !h.pts) return "";
    let best = "";
    let bestD = Infinity;
    for (const key of ["cancel", "save"]) {
      const p = h.pts[key];
      const dd = Math.hypot(x - p.x, y - p.y);
      if (dd <= VOICE_SLIDE_HIT && dd < bestD) { best = key; bestD = dd; }
    }
    // Unarmed Save is dimmed and does nothing.
    if (best === "save" && !voiceHoldArmed()) return "";
    return best;
  }

  function voiceHoldBegin(hold, rect) {
    const dlg = document.getElementById("voice-dialog");
    const layer = document.getElementById("voice-hold");
    const hint = document.getElementById("voice-hold-hint");
    if (!dlg || !layer || !rect) return;
    let firstTime = false;
    try {
      firstTime = localStorage.getItem(VOICE_SLIDE_HINT_KEY) !== "1";
      if (firstTime) localStorage.setItem(VOICE_SLIDE_HINT_KEY, "1");
    } catch {}
    if (hint) {
      hint.textContent = voiceT("Slide to Save · Let go to check");
      hint.hidden = !firstTime;
    }
    voiceSlide = { id: hold.pointerId, over: "", pts: null, rect };
    layer.hidden = false;
    dlg.classList.add("is-holding");
    dlg.classList.remove("is-hold-review");
    voiceSlide.pts = voiceHoldLayout(rect);
    voiceHoldSync();
    // The finger is captured by the bubble, now under the modal: hand it to
    // the mic drawn in the same place, inside the dialog.
    const mic = document.getElementById("voice-hold-mic");
    try { if (mic && typeof mic.setPointerCapture === "function") mic.setPointerCapture(hold.pointerId); } catch {}
    const live = document.getElementById("voice-hold-live");
    if (live) {
      live.textContent = "";
      setTimeout(() => {
        if (voiceSlide) live.textContent = voiceT("Release on Save to save, on Cancel to cancel, anywhere else to check");
      }, 60);
    }
  }

  // Back to the ordinary stage (no hold visuals). review: Cancel and Save sit
  // above the input as tap buttons.
  function voiceHoldExit(review) {
    const dlg = document.getElementById("voice-dialog");
    const layer = document.getElementById("voice-hold");
    const h = voiceSlide;
    voiceSlide = null;
    if (layer) layer.hidden = true;
    for (const id of ["voice-hold-cancel", "voice-hold-save"]) {
      const el = document.getElementById(id);
      if (el) el.classList.remove("is-over");
    }
    if (dlg) {
      dlg.classList.remove("is-holding");
      dlg.classList.toggle("is-hold-review", !!review);
      dlg.style.removeProperty("--voice-hold-zone");
    }
    const mic = document.getElementById("voice-hold-mic");
    if (h && mic) { try { if (mic.hasPointerCapture && mic.hasPointerCapture(h.id)) mic.releasePointerCapture(h.id); } catch {} }
  }

  function voiceHoldReview() {
    voiceHoldExit(true);
    voiceStopListening();
    const btn = document.getElementById("voice-save");
    try { if (btn && !btn.disabled) btn.focus({ preventScroll: true }); } catch {}
  }

  async function voiceHoldSave() {
    const dlg = document.getElementById("voice-dialog");
    const input = document.getElementById("voice-input");
    voiceHoldExit(true);
    voiceStopListening();
    await voiceWaitFinal(VOICE_SLIDE_FINAL_MS);
    // Anything the recogniser says after this is dropped.
    voiceDropPendingStop();
    if (!dlg || !dlg.open) return;
    const raw = input ? input.value.trim() : "";
    // The final words, parsed locally with what Kira learned (never the AI+
    // upgrade, which can't be waited for).
    if (raw && !(voiceCurrent && String(voiceCurrent.raw || "").trim() === raw)) {
      renderVoicePreview(parseVoiceEntry(raw));
    }
    if (voiceHoldArmed()) {
      voiceSaveConfirmed({ undo: true });
      return;
    }
    const btn = document.getElementById("voice-save");
    try { if (btn && !btn.disabled) btn.focus({ preventScroll: true }); } catch {}
  }

  // kind: "up" (with coordinates) or "review" (pointercancel, blur, hidden).
  function voiceHoldRelease(kind, x, y) {
    if (!voiceSlide) return;
    const at = kind === "up" ? voiceHoldHit(x, y) : "";
    if (at === "cancel") { voiceCloseStage(); return; }
    if (at === "save") { voiceHoldSave(); return; }
    voiceHoldReview();
  }

  function initVoiceSlide() {
    document.addEventListener("pointermove", (e) => {
      const h = voiceSlide;
      if (!h || e.pointerId !== h.id) return;
      voiceHoldOver(voiceHoldHit(e.clientX, e.clientY));
    }, { capture: true, passive: true });
    document.addEventListener("pointerup", (e) => {
      const h = voiceSlide;
      if (!h || e.pointerId !== h.id) return;
      voiceHoldRelease("up", e.clientX, e.clientY);
    }, { capture: true, passive: true });
    document.addEventListener("pointercancel", (e) => {
      const h = voiceSlide;
      if (!h || e.pointerId !== h.id) return;
      voiceHoldRelease("review");
    }, { capture: true, passive: true });
    window.addEventListener("blur", () => voiceHoldRelease("review"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") voiceHoldRelease("review");
    });
    window.addEventListener("resize", () => {
      const h = voiceSlide;
      if (!h) return;
      const b = document.getElementById("kira-bubble");
      const r = b && b.getClientRects().length ? b.getBoundingClientRect() : h.rect;
      h.rect = r;
      h.pts = voiceHoldLayout(r);
    });
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
      voiceCloseStage();
    };

    if (openBtn) openBtn.addEventListener("click", () => openVoiceEntry(""));
    if (cancelBtn) cancelBtn.addEventListener("click", closeVoice);
    if (closeX) closeX.addEventListener("click", closeVoice);
    if (dlg) {
      dlg.addEventListener("cancel", (e) => {
        e.preventDefault();
        closeVoice();
      });
      dlg.addEventListener("close", () => {
        // The close event arrives asynchronously a task after close(); ignore
        // a stale close if #voice-dialog has already been reopened.
        if (dlg.open) return;
        voiceAiGen++;
        clearTimeout(voiceAiTimer);
        voiceClearFlight();
        voiceHoldExit();
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
      // Anything else is a turn in the chat: a question, a short reply to
      // Kira's question ("yes", "the second one"), or words with no amount.
      // A few words with no amount before any chat ("nasi lemak") are
      // answered on the phone ("How much was …?"), so no quota is spent.
      const fewWords = val.split(/\s+/).filter(Boolean).length <= 5;
      voiceAskKira(val, { local: !voiceTurns.length && fewWords && !voiceLooksLikeQuestion(val) && !VOICE_TOPIC_RE.test(val) });
    };

    if (askBtn) askBtn.addEventListener("click", submitInputText);

    if (input) {
      let timer = null;
      input.addEventListener("input", () => {
        const val = input.value;
        voiceSyncTranscript(val);
        renderVoicePreview(parseVoiceEntry(val));
        clearTimeout(timer);
        clearTimeout(voiceAiTimer);
        voiceAiGen++;
        if (val.trim().length >= 4 && !voiceLooksLikeQuestion(val) && !voiceMatchLocalCommand(val)) {
          timer = setTimeout(() => {
            if (!dlg || !dlg.open) return;
            if (typeof window.aiCloudRun === "function") voiceSmartThenAi(val);
            else voiceAiSoon(0);
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

    initVoiceSlide();

    if (saveBtn) saveBtn.addEventListener("click", () => voiceSaveConfirmed());
  }

  window.parseVoiceSentence = parseVoiceSentence;
  window.parseVoiceItems = parseVoiceItems;
  window.parseVoiceEntry = parseVoiceEntry;
  window.voiceCorrectHeard = voiceCorrectHeard;
  window.voiceSpeechHints = voiceSpeechHints;
  window.parseVoiceSmart = parseVoiceSmart;
  window.voiceLearnedKind = voiceLearnedKind;
  window.voiceLearnedCategory = voiceLearnedCategory;
  window.voiceAiLabel = voiceAiLabel;
  window.parseAiVoiceReply = parseAiVoiceReply;
  window.voiceMatchLocalCommand = voiceMatchLocalCommand;
  window.voiceAskKira = voiceAskKira;
  window.kiraLocalAnswer = kiraLocalAnswer;
  window.voiceClarifyMaybe = voiceClarifyMaybe;
  window.voiceClarifyAnswer = voiceClarifyAnswer;
  window.voiceOnSpeechLevel = voiceOnSpeechLevel;
  window.openVoiceEntry = openVoiceEntry;
  window.voiceSaveConfirmed = voiceSaveConfirmed;
  window.voiceUndoBooked = voiceUndoBooked;
  window.voiceHoldArmed = voiceHoldArmed;
  window.voiceStopListening = voiceStopListening;
  window.voiceSpeechMode = voiceSpeechMode;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVoiceUI);
  } else {
    initVoiceUI();
  }
})();
