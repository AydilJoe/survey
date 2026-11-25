/* ---------- "Not picked up?" — share an alert's wording, redacted ----------
   Banks reword their alerts. The fastest fix is the real wording, so the
   user can send one: pasted (missed) or from a card ("Wrong?"). It is
   redacted on this phone first, shown exactly as it will be sent, and
   leaves only through the user's own email app or share sheet, to the
   address the app already uses for feedback. No upload, no endpoint. */
const SAMPLE_TO = "hello@duitful.app";
// Words that look like a name in capitals but are bank or payment terms.
const SAMPLE_KEEP = new Set(["DUITNOW", "TRANSFER", "FPX", "JOMPAY", "QR", "IBG", "GIRO", "IBFT", "ATM", "POS", "ID", "OTP", "TAC",
  "REF", "RM", "MYR", "SGD", "VISA", "MASTERCARD", "DEBIT", "CREDIT", "CARD", "MAYBANK", "MAYBANK2U", "MAE", "CIMB", "OCTO", "RHB",
  "HSBC", "OCBC", "UOB", "TMRW", "TNG", "EWALLET", "E-WALLET", "AMBANK", "BSN", "GXBANK", "AEON", "BANK", "BOOST", "RYT", "SHOPEEPAY",
  "GRABPAY", "SETEL", "BIGPAY", "ATOME", "SPAYLATER", "MYDEBIT", "SUCCESSFUL", "RECEIVED", "FUNDS", "ALERT"]);
// Pure: the alert text with names, account / card / reference / phone
// numbers and emails replaced. Amounts and currencies stay.
function redactAlertSample(text) {
  let t = String(text || "").slice(0, 2000);
  const keep = [];
  const hold = (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; };
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  // Amounts with their currency are what we need; set them aside.
  t = t.replace(/(?:\bRM|\bMYR|S\$|\bSGD|\bRp|\bIDR|฿|\bTHB|₱|\bPHP)\s?\d[\d,]*(?:\.\d{1,2})?/gi, hold);
  t = t.replace(/(?:\+?6?0)1\d[\s-]?\d{3,4}[\s-]?\d{4}\b/g, "[phone]");
  t = t.replace(/\b(ref(?:erence)?(?:\s*(?:no|number))?|rujukan|no\.?\s*rujukan|transaction\s+id|txn\s*id)(\.?\s*[:#]?\s*)[A-Z0-9][A-Z0-9-]{2,}/gi, "$1$2[ref]");
  t = t.replace(/[*xX•·]{2,}\s?\d{2,}/g, "[account]");
  t = t.replace(/\d[\d\s-]{2,}\d/g, (m) => (m.replace(/\D/g, "").length >= 4 ? "[number]" : m));
  // Names: after to / from / daripada / kepada, a run of capitalised words.
  t = t.replace(/\b(to|from|daripada|kepada|dari)(\s+)((?:[A-Z][\w'@&/-]*(?:\.[\w'@&/-]+)*)(?:\s+(?:[A-Z][\w'@&/-]*(?:\.[\w'@&/-]+)*|bin|binti|bt|bte|a\/l|a\/p|@))*)/g, (m, w, sp, name) => {
    const words = name.split(/\s+/);
    if (words.every((x) => SAMPLE_KEEP.has(x.toUpperCase().replace(/[^A-Z0-9-]/g, "")))) return m;
    return `${w}${sp}[name]`;
  });
  // Any other run of two or more words in capitals.
  t = t.replace(/\b[A-Z][A-Z'@&/-]+(?:\s+(?:[A-Z][A-Z'@&/-]+|BIN|BINTI|A\/L|A\/P))+\b/g, (m) => {
    const words = m.split(/\s+/);
    return words.every((x) => SAMPLE_KEEP.has(x.replace(/[^A-Z0-9-]/g, ""))) ? m : "[name]";
  });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]).replace(/(\[name\]\s*){2,}/g, "[name] ");
}
function captureShareAllowed() { return isNative() && nativePlatform() === "android"; }
let shareCtx = { pkg: "", kind: "missed" };
function openCaptureShare(opts) {
  const o = opts || {};
  const dlg = document.getElementById("capture-share-dialog");
  if (!dlg) return;
  // kind "add-bank": from a wallet's "Ask us to add your bank", with only
  // the bank name the user typed.
  shareCtx = { pkg: o.pkg || "", kind: o.kind || "missed", bank: String(o.bank || "").replace(/\S+@\S*/g, "").replace(/\d/g, "").replace(/\s+/g, " ").trim().slice(0, 40) };
  const raw = document.getElementById("share-raw");
  const app = document.getElementById("share-app");
  if (app) {
    const mine = TXN_PROVIDERS.filter((x) => x.country === "MY");
    app.innerHTML = `<option value="">${tr("Which app sent it?")}</option>` + mine.map((x) => `<option value="${escapeHtml(x.packages[0])}">${escapeHtml(x.name)}</option>`).join("");
    const known = providerForPackage(shareCtx.pkg);
    app.value = known ? known.packages[0] : "";
  }
  if (raw) raw.value = o.text || "";
  const st = document.getElementById("share-shot-status");
  if (st) { st.textContent = ""; st.hidden = true; }
  updateCaptureSharePreview();
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  setTimeout(() => (o.text ? document.getElementById("share-redacted") : raw)?.focus(), 30);
}
function updateCaptureSharePreview() {
  const raw = document.getElementById("share-raw");
  const out = document.getElementById("share-redacted");
  if (out) out.value = redactAlertSample(raw ? raw.value : "");
  const send = document.getElementById("share-send");
  if (send) send.disabled = !(out && out.value.trim());
}
function captureShareBody() {
  const app = document.getElementById("share-app");
  const pkg = (app && app.value) || shareCtx.pkg || "";
  const text = (document.getElementById("share-redacted") || {}).value || "";
  if (shareCtx.kind === "add-bank") {
    return {
      subject: `Please add my bank${shareCtx.bank ? `: ${shareCtx.bank}` : ""}`,
      body: `Bank or e-wallet: ${shareCtx.bank || "(not typed)"}\nApp: ${pkg || "not chosen"}\nDuitful: ${APP_VERSION} · add a bank\n\n${text.trim()}\n`,
    };
  }
  return {
    subject: `Bank alert sample (${shareCtx.kind}${pkg ? `, ${pkg}` : ""})`,
    body: `App: ${pkg || "not chosen"}\nDuitful: ${APP_VERSION} · ${shareCtx.kind === "misread" ? "read wrongly" : "not picked up"}\n\n${text.trim()}\n`,
  };
}
function captureShareMailto() {
  const b = captureShareBody();
  return `mailto:${SAMPLE_TO}?subject=${encodeURIComponent(b.subject)}&body=${encodeURIComponent(b.body)}`;
}
document.getElementById("share-raw")?.addEventListener("input", updateCaptureSharePreview);
/* "Use a screenshot": the same on-device OCR as receipts (ML Kit where the
   phone has it, Tesseract otherwise) reads the text into the box above, and
   the same redaction runs (Vision on iPhone, but alert sharing is Android
   only today). Only the cleaned words are ever sent: the image
   is read in memory and dropped, never stored or attached. */
async function ocrAlertScreenshot(file) {
  let text = null;
  try { if (nativeTextReader()) text = await runMlKitOcr(file); } catch { text = null; }
  if (text == null && tesseractAllowed()) {
    const worker = await getTesseractWorker(() => {});
    const res = await worker.recognize(file);
    text = (res && res.data && res.data.text) || "";
  }
  return String(text || "").replace(/[ \t]+\n/g, "\n").trim();
}
async function shareFromScreenshot(file) {
  const status = document.getElementById("share-shot-status");
  const say = (m) => { if (status) { status.textContent = m; status.hidden = !m; } };
  if (!file) return;
  say(tr("Reading the screenshot on your phone…"));
  let text = "";
  try { text = await ocrAlertScreenshot(file); } catch { text = ""; }
  if (!text) { say(tr("No text found in that picture. Paste the words instead.")); return; }
  say("");
  const raw = document.getElementById("share-raw");
  if (raw) raw.value = text;
  updateCaptureSharePreview();
  document.getElementById("share-redacted")?.focus();
}
document.getElementById("share-shot")?.addEventListener("click", () => document.getElementById("share-shot-file")?.click());
document.getElementById("share-shot-file")?.addEventListener("change", async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = "";                      // the picture is not kept
  await shareFromScreenshot(file);
});
document.getElementById("share-send")?.addEventListener("click", () => {
  window.location.href = captureShareMailto();
  document.getElementById("capture-share-dialog")?.close();
});
document.getElementById("share-sheet")?.addEventListener("click", async () => {
  const b = captureShareBody();
  try { await navigator.share({ title: b.subject, text: `To: ${SAMPLE_TO}\n${b.body}` }); document.getElementById("capture-share-dialog")?.close(); } catch {}
});
document.getElementById("share-cancel")?.addEventListener("click", () => document.getElementById("capture-share-dialog")?.close());
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  if (el.closest("[data-capture-share]")) { openCaptureShare({ kind: "missed" }); return; }
  const w = el.closest("[data-pending-wrong]");
  if (w) {
    const p = (state.pendingTxns || []).find((x) => x.id === w.dataset.pendingWrong);
    const src = p && (p.kind === "move" ? (p.from || p.to) : p);
    openCaptureShare({ kind: "misread", pkg: src ? src.pkg : "", text: src ? src.raw : "" });
  }
});
function pendingWrongBtn(p) {
  return captureShareAllowed() ? `<button type="button" class="pending-wrong" data-pending-wrong="${escapeHtml(p.id)}">${tr("Wrong?")}</button>` : "";
}
function renderCaptureShareLinks() {
  const on = captureShareAllowed();
  document.querySelectorAll("[data-capture-share-wrap]").forEach((el) => { el.hidden = !on; });
  const sheet = document.getElementById("share-sheet");
  if (sheet) sheet.hidden = typeof navigator.share !== "function";
}

// "Read by your phone's AI": on a card where the AI gave the direction,
// payee or category (never the amount).
function pendingAiTag(p) {
  const ai = p && (p.ai || (p.from && p.from.ai) || (p.to && p.to.ai));
  return ai ? `<p class="pending-ai">${tr("Read by your phone's AI")}</p>` : "";
}

/* ---------- Check auto-capture: plain facts for a tester to send us ----------
   Native says whether notification access is granted, when the listener was
   last connected, the battery setting, what it saw (app, time, outcome) and
   how many alerts wait in its store. This side adds what each drained alert
   became. No message text and no amounts anywhere: the outcome is what we
   need, and leaving amounts out keeps the report safe to paste anywhere. */
const CAPTURE_DIAG_MAX = 20;
function coerceCaptureDiag(d) {
  const items = d && Array.isArray(d.items) ? d.items : [];
  return {
    lastDrainAt: Number(d && d.lastDrainAt) || 0,
    items: items.filter((x) => x && typeof x === "object")
      .map((x) => ({ p: String(x.p || "").slice(0, 80), t: Number(x.t) || 0, at: Number(x.at) || 0, became: String(x.became || "").slice(0, 40) }))
      .slice(-CAPTURE_DIAG_MAX),
  };
}
function noteCaptureOutcome(data, became) {
  state.captureDiag = coerceCaptureDiag(state.captureDiag);
  state.captureDiag.items.push({ p: String(data.package || ""), t: Number(data.postedAt) || 0, at: Date.now(), became });
  state.captureDiag.items = state.captureDiag.items.slice(-CAPTURE_DIAG_MAX);
}
function pendingFingerprint() {
  return new Map((state.pendingTxns || []).map((p) => [p.id, p.kind || "spend"]));
}
// What the last capture did to the pending list.
function captureBecame(before) {
  for (const p of state.pendingTxns || []) {
    const was = before.get(p.id);
    if (was === undefined || was !== (p.kind || "spend")) {
      return p.kind === "move" ? "move" : p.kind === "income" ? "income" : p.kind === "split-match" ? "split repayment" : "spend";
    }
  }
  return "queued";
}
function captureWhyNot(data) {
  const texts = captureTexts(data);
  if (texts.some((t) => CAPTURE_DENY.test(t))) return "dropped: OTP / security";
  if (texts.some((t) => TXN_FAILED_DENY.test(t))) return "dropped: failed / declined";
  if (texts.every((t) => isLikelyPromo(t))) return "dropped: promo";
  if (!providerForPackage(String(data.package || ""))) return "dropped: app not known";
  return "no rule matched (AI / entity reader next)";
}
function captureAppName(pkg) {
  const pr = providerForPackage(pkg);
  return pr ? pr.name : pkg || "unknown";
}
function fmtDiagTime(ms) {
  if (!ms) return "never";
  const d = new Date(ms);
  return `${d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short" })} ${d.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}`;
}
// Pure: the facts as lines, for the dialog and for "Copy report".
function captureCheckLines(nat, diag) {
  const n = nat || {};
  const lines = [];
  lines.push(`Duitful ${APP_VERSION} · ${[n.manufacturer, n.model].filter(Boolean).join(" ") || "device unknown"}${n.sdk ? ` · Android API ${n.sdk}` : ""}`);
  if (n.error) lines.push(`Native check: ${n.error}`);
  lines.push(`Notification access: ${n.accessGranted === true ? "granted" : n.accessGranted === false ? "NOT granted" : "unknown"}`);
  lines.push(`Listener: last connected ${fmtDiagTime(n.connectedAt)}${n.disconnectedAt ? `, last disconnected ${fmtDiagTime(n.disconnectedAt)}` : ""}`);
  lines.push(`Battery: ${n.batteryUnrestricted === true ? "unrestricted" : n.batteryUnrestricted === false ? "optimised (may stop the listener)" : "unknown"}`);
  lines.push(`Waiting in store: ${Number(n.stored) || 0}`);
  const seen = Array.isArray(n.log) ? n.log.slice(-10).reverse() : [];
  lines.push(`Seen by the listener (last ${seen.length}):`);
  for (const r of seen) lines.push(`  ${captureAppName(r.p)} · ${fmtDiagTime(r.t)} · ${r.r}`);
  if (!seen.length) lines.push("  nothing yet");
  const d = coerceCaptureDiag(diag);
  lines.push(`Last drain: ${fmtDiagTime(d.lastDrainAt)}`);
  const done = d.items.slice(-10).reverse();
  lines.push(`Drained (last ${done.length}):`);
  for (const x of done) lines.push(`  ${captureAppName(x.p)} · ${fmtDiagTime(x.t || x.at)} → ${x.became}`);
  if (!done.length) lines.push("  nothing yet");
  return lines;
}
async function openCaptureCheck() {
  const dlg = document.getElementById("capture-check-dialog");
  const list = document.getElementById("capture-check-list");
  if (!dlg || !list) return;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  let nat = {};
  try {
    nat = NL && typeof NL.captureStatus === "function" ? await withTimeout(NL.captureStatus(), 3000) : { error: "this app version can't report it" };
  } catch (e) { nat = { error: String((e && e.message) || e).slice(0, 80) }; }
  const lines = captureCheckLines(nat, state.captureDiag);
  list.textContent = lines.join("\n");
  dlg.dataset.report = lines.join("\n");
  const fix = document.getElementById("capture-check-access");
  if (fix) fix.hidden = nat.accessGranted !== false;
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
}
document.getElementById("capture-check-open")?.addEventListener("click", () => openCaptureCheck().catch(() => {}));
document.getElementById("capture-check-close")?.addEventListener("click", () => document.getElementById("capture-check-dialog")?.close());
document.getElementById("capture-check-access")?.addEventListener("click", () => {
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  try { NL && NL.openSettings && NL.openSettings(); } catch {}
});
document.getElementById("capture-check-copy")?.addEventListener("click", async () => {
  const text = document.getElementById("capture-check-dialog")?.dataset.report || "";
  try { await navigator.clipboard.writeText(text); toast(tr("Report copied")); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(tr("Report copied")); } catch { toast(tr("Couldn't copy — select the text instead")); }
    ta.remove();
  }
});

/* ---------- Auto-capture from bank / e-wallet notifications (Android) ----------
   The native NotificationListenerService pushes raw notification text to
   window.duitfulIncoming({ package, title, text }). We run a layered
   multilingual grammar (EN, BM, ZH, ID, TH, FIL, VI) against a whitelist of
   MY/SG/ID/TH/PH/VN banks and wallets, and queue a pending transaction for
   user review. Nothing is auto-saved — the user always confirms. */

function normNotifText(s) {
  return String(s || "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Reusable amount fragment for all supported markets (prefix or suffix).
const TXN_NUM_SRC = "(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
const TXN_CUR_PRE_SRC = "(?:\\bRM|\\bMYR|马币|馬幣|令吉|S\\$|\\bSGD|新币|新幣|新元|\\bRp\\.?|\\bIDR|฿|\\bTHB|₱|\\bPHP|\\bPhp|₫|\\bVND)";
const TXN_CUR_SUF_SRC = "(?:₫|\\bVND\\b|đ|บาท|令吉|新元|\\bMYR\\b|\\bRM\\b|\\bSGD\\b|\\bTHB\\b|\\bPHP\\b|\\bIDR\\b)";
const TXN_AMT_SRC = `(?:(?:${TXN_CUR_PRE_SRC})\\s*${TXN_NUM_SRC}|${TXN_NUM_SRC}\\s*(?:${TXN_CUR_SUF_SRC}))`;
const TXN_AMT_SCAN_RE = new RegExp(`(?<cpre>${TXN_CUR_PRE_SRC})\\s*(?<npre>${TXN_NUM_SRC})|(?<nsuf>${TXN_NUM_SRC})\\s*(?<csuf>${TXN_CUR_SUF_SRC})`, "gi");
// Preceded by a remaining-balance label (NOT Vietnamese "biến động số dư", which
// means balance change): never mistake an account balance for the transaction.
const TXN_BALANCE_BEFORE = /(?:avail(?:able)?\s+bal(?:ance)?|bal(?:ance)?|baki(?:\s+(?:tersedia|semasa|akaun))?|saldo(?:\s+(?:akhir|tersedia|anda))?|可用[余餘][额額]|[余餘][额額]|ยอด(?:เงิน)?คงเหลือ|(?<!biến\s+động\s+)số\s+dư(?:\s+(?:hiện\s+tại|khả\s+dụng|cuối))?|balanse)\s*[:：\-]?\s*$/i;

function txnCurrencyCode(token, fallback) {
  const t = String(token || "").trim().toUpperCase().replace(/\.$/, "");
  if (t === "RM" || t === "MYR" || t === "马币" || t === "馬幣" || t === "令吉") return "MYR";
  if (t === "S$" || t === "SGD" || t === "新币" || t === "新幣" || t === "新元") return "SGD";
  if (t === "RP" || t === "IDR") return "IDR";
  if (t === "฿" || t === "THB" || t === "บาท") return "THB";
  if (t === "₱" || t === "PHP") return "PHP";
  if (t === "₫" || t === "VND" || t === "Đ") return "VND";
  return fallback || "MYR";
}

function extractTxnAmounts(text, defaultCurrency) {
  const norm = normNotifText(text);
  const out = [];
  for (const m of norm.matchAll(TXN_AMT_SCAN_RE)) {
    const g = m.groups || {};
    const curTok = g.cpre || g.csuf || "";
    const numRaw = g.npre || g.nsuf || "";
    const currency = txnCurrencyCode(curTok, defaultCurrency);
    const amount = parseAmount(numRaw, currency);
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e9) continue;
    const before = norm.slice(Math.max(0, m.index - 40), m.index);
    const lineBefore = before.slice(before.lastIndexOf("\n") + 1);
    out.push({
      raw: m[0],
      amount: Math.round(amount * 100) / 100,
      currency,
      index: m.index,
      end: m.index + m[0].length,
      isBalance: TXN_BALANCE_BEFORE.test(lineBefore),
    });
  }
  return out;
}

function parseTxnAmtFragment(raw, defaultCurrency) {
  const hits = extractTxnAmounts(raw, defaultCurrency);
  return hits.length ? hits[0] : null;
}

// A "payee" that is really the reader: the alert is about money coming in.
const TXN_PAYEE_IS_YOU = /^(?:you|your(?:\s+(?:account|e-?wallet|wallet|card))?|yourself|me|my\s+account|anda|akaun\s+anda|dompet\s+anda|rekening\s+anda|saldo\s+anda|diri\s+anda|iyo|iyong\s+account)\b|^(?:您的?(?:[账賬][户戶]|(?:[电電]子)?[钱錢]包)|您|你|本人|คุณ|บัญชีของคุณ|กระเป๋าของคุณ|bạn|tài\s+khoản(?:\s+của\s+bạn)?|ví(?:\s+của\s+bạn)?)(?:[\s.,。，!！]|$)/i;

// Title or body says money came TO the reader (EN, MS, ZH, ID, TH, FIL, VI).
const TXN_CREDIT_CUE = new RegExp([
  "\\b(?:you(?:'|’)?(?:ve| have)?\\s+(?:just\\s+)?received|received\\s+money|funds\\s+received|money\\s+received|transfer\\s+received|incoming\\s+transfer|payment\\s+received\\s+from|to\\s+you\\b|credited\\s+to\\s+your|deposited\\s+(?:in|into|to)\\s+your)",
  "\\b(?:kepada\\s+anda|anda\\s+(?:telah\\s+)?(?:berjaya\\s+)?menerima|wang\\s+diterima|dana\\s+diterima|bayaran\\s+diterima|pindahan\\s+diterima|dikreditkan\\s+ke\\s+akaun|dimasukkan\\s+ke\\s+akaun)",
  "\\b(?:dana\\s+masuk|uang\\s+masuk|transfer\\s+masuk|saldo\\s+masuk|berhasil\\s+diterima|dikreditkan\\s+ke\\s+rekening|menerima\\s+(?:transfer|dana|uang|pembayaran))",
  "(?:[您你](?:已|刚刚|剛剛)?收到|收到(?:[转轉][账賬]|收款|款[项項]|[汇匯]款)|已(?:存入|入[账賬]|[转轉]入)(?:您的|你的)?(?:[账賬][户戶]|[钱錢]包)?|[转轉][给給][您你]|向[您你][转轉][账賬]|收款成功)",
  "(?:คุณได้รับ(?:เงิน|โอน)?|ได้รับเงิน(?:โอน)?|เงินเข้า(?:บัญชี)?|โอนเงินเข้า|รับโอนเงิน|มีเงินเข้า|ให้คุณ)",
  "\\b(?:nakatanggap\\s+ka\\s+ng|natanggap\\s+mo\\s+ang|may\\s+pumasok\\s+na)",
  "(?:bạn\\s+(?:vừa\\s+|đã\\s+)?nhận\\s+được|nhận\\s+(?:tiền|được\\s+tiền)|tiền\\s+về|cộng\\s+vào\\s+tài\\s+khoản|ghi\\s+có|(?:biến\\s+động\\s+số\\s+dư|tài\\s+khoản)[^.\\n]{0,40}\\+\\s*\\d)",
].join("|"), "i");

// Explicit "you sent / paid" cues so a real outbound transfer isn't blocked by a stray word.
const TXN_SELF_OUT_CUE = new RegExp([
  "\\byou(?:'|’)?(?:ve| have)?\\s+(?:successfully\\s+)?(?:transferred|paid|spent|sent|made\\s+a\\s+payment)",
  "\\banda\\s+(?:telah\\s+)?(?:berjaya\\s+)?(?:memindahkan|membayar|berbelanja|membuat\\s+bayaran)",
  "\\banda\\s+(?:telah\\s+|berhasil\\s+)?(?:mentransfer|membayar|mengirim)",
  "(?:(?<![向给給])[您你](?:已|刚刚|剛剛)?(?:成功)?(?:[转轉][账賬]|付款|支付|消[费費]|刷卡|[汇匯]款))",
  "(?:คุณได้(?:โอน|ชำระ|จ่าย|ใช้จ่าย))",
  "\\b(?:nagbayad|nagpadala|gumastos)\\s+ka\\b",
  "(?:bạn\\s+(?:vừa\\s+|đã\\s+)?(?:chuyển|thanh\\s+toán|trả|chi\\s+tiêu))",
].join("|"), "i");

// Debit/spend cue anywhere in title or body (used for structured & title+body shapes).
const TXN_DEBIT_CUE = new RegExp([
  "\\b(?:paid|spent|charged|debited|deducted|withdrawn|purchased|purchase|payment|duitnow\\s*qr|qr\\s*pay(?:ment)?|card\\s+(?:spend|purchase|transaction)|e-?commerce\\s+transaction|bill\\s+payment|auto[- ]?debit|top[- ]?up|reload|transaction\\s+successful|payment\\s+successful)",
  "\\b(?:dibayar|membayar|bayar|pembayaran|bayaran|ditolak|didebitkan|didebet|dibelanjakan|dipotong|dikenakan|pembelian|belanja|potongan|tarik\\s+tunai|qris|transaksi\\s+berjaya|transaksi\\s+berhasil)",
  "(?:支付|付款|消[费費]|刷卡|扣款|扣除|[缴繳][费費]|[购購][买買]|[转轉]出)",
  "(?:ชำระ(?:เงิน|ค่า)?|จ่าย(?:เงิน|ค่า)?|หัก(?:เงิน|บัญชี)|ใช้จ่าย|ซื้อสินค้า|รูดบัตร)",
  "\\b(?:nagbayad|binayaran|gumastos|bayad|binawas)",
  "(?:thanh\\s*toán|chi\\s*tiêu|trừ\\s*tiền|trả\\s*tiền|mua\\s*hàng|rút\\s*tiền|(?:biến\\s+động\\s+số\\s+dư|tài\\s+khoản)[^.\\n]{0,40}-\\s*\\d)",
].join("|"), "i");

// Failed / declined / cancelled alerts are never real transactions.
// Note: bare Malay "ditolak" means "deducted" (a real debit), so only match it
// when paired with transaction/card/payment nouns.
const TXN_FAILED_DENY = new RegExp([
  "\\b(?:failed|unsuccessful|declined|rejected|cancelled|canceled|insufficient\\s+(?:funds|balance))\\b",
  "\\b(?:gagal|tidak\\s+berjaya|dibatalkan|baki\\s+tidak\\s+mencukupi|saldo\\s+tidak\\s+cukup|(?:transaksi|kad|pembayaran|bayaran|permintaan)\\s+(?:anda\\s+)?ditolak)\\b",
  "(?:交易[失失][败敗]|支付[失失][败敗]|付款[失失][败敗]|[转轉][账賬][失失][败敗]|扣款[失失][败敗]|[余餘][额額]不足|已取消|被拒[绝絕])",
  "(?:ไม่สำเร็จ|ยอดเงินไม่เพียงพอ|ถูกปฏิเสธ|ยกเลิกรายการ)",
  "(?:không\\s+thành\\s+công|thất\\s+bại|số\\s+dư\\s+không\\s+đủ|bị\\s+từ\\s+chối|đã\\s+hủy)",
  "\\b(?:hindi\\s+matagumpay|nabigo|kulang\\s+ang\\s+balanse)\\b",
].join("|"), "i");

// Kept by name for MY provider patterns & backwards compatibility.
const TXN_TRANSFER_OUT = /\b(?:transferred|sent)\s+(?:RM|MYR)\s*([\d,]+(?:\.\d{1,2})?)\s+to\s+([^\n.…]+?)(?:\s*(?:[.\n…]|\bon\s|\bvia\s)|$)/i;

// Clean a parsed merchant / recipient string across all supported languages.
function cleanTxnMerchant(raw) {
  let s = normNotifText(raw || "").replace(/\n[\s\S]*$/, "");
  s = s.replace(/^[:：\-\s]+/, "");
  // Strip trailing noise clauses (dates, channels, account refs, balance, tap prompts).
  s = s.replace(/\s+(?:on\s+\d|at\s+\d{1,2}:\d{2}|via\s+|using\s+|with\s+(?:your\s+)?(?:card|account|wallet)|from\s+(?:your\s+)?(?:account|card|wallet|saving|current)|ref(?:erence)?\s*(?:no\.?|id|:|#|\b)|tap\s+(?:here|to)|avail(?:able)?\s+bal|balance\b).*$/i, "");
  s = s.replace(/\s+(?:pada\s+\d|melalui\s+|menggunakan\s+|dari(?:pada)?\s+(?:akaun|rekening|kad|dompet)|no\.?\s*rujukan|rujukan\s*:|baki\b|saldo\b|ketik\s+(?:di\s+sini|untuk)|klik\s+untuk).*$/i, "");
  s = s.replace(/(?:[，,\s]*(?:可用)?(?:[余餘][额額]|[参參]考[号號]|[点點][击擊]查看|[时時][间間]|卡[号號]|尾[号號]|交易[号號])).*$/i, "");
  s = s.replace(/\s*(?:เมื่อ|เวลา\s*\d|ยอด(?:เงิน)?คงเหลือ|เลขอ้างอิง|แตะเพื่อ).*$/i, "");
  s = s.replace(/\s*(?:lúc\s+\d|số\s+dư|mã\s+giao\s+dịch|nội\s+dung\s*:).*$/i, "");
  s = s.replace(/[\s.,;!?…。「」、，:：\-]+$/, "").trim();
  if (!s || /^[\d\s*#\-/.:]+$/.test(s)) return "";
  if (TXN_PAYEE_IS_YOU.test(s)) return "";
  return s.slice(0, 60);
}

// Wallets read this list too (walletBrands in wallets.js): one row per brand,
// so `walletBrand` folds an app into its bank (MAE → Maybank), `walletName`
// is the name a new wallet gets, `walletType` is "ewallet" / "card" (pay
// later); a provider without one is a bank.
const TXN_PROVIDERS = [
  { id: "maybank",   name: "Maybank",       short: "Maybank", country: "MY", currency: "MYR",
    packages: ["com.mbb.malaysia.android"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:charged|debited|deducted|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "cimb",      name: "CIMB",          country: "MY", currency: "MYR",
    packages: ["com.cimb.cimbocto", "com.cimb.mob.my", "com.cimb.octo"],
    patterns: [/(?:Purchase|Charge)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "hlb",       name: "Hong Leong",    country: "MY", currency: "MYR",
    packages: ["my.com.hongleongconnect.mobileconnect", "com.hongleong.cfs.connect"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:spent|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "rhb",       name: "RHB",           country: "MY", currency: "MYR",
    packages: ["com.rhbgroup.rhbmobilebanking", "my.com.rhbgroup.rhbmobilebanking"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:has been|was)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "publicbank",name: "Public Bank",   country: "MY", currency: "MYR",
    packages: ["com.pbb.mypb", "my.com.publicbank.pbengine"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "tng",       name: "Touch 'n Go", walletName: "TNG eWallet", walletType: "ewallet",   short: "TNG", country: "MY", currency: "MYR",
    packages: ["my.com.tngdigital.ewallet"],
    patterns: [
      /(?:spent|paid|deducted)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i,
      // "You have successfully transferred RM 0.10 to ALI BIN ABU" (DuitNow Transfer)
      TXN_TRANSFER_OUT,
    ] },
  { id: "grabpay",   name: "GrabPay", walletType: "ewallet",       country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/(?:paid|spent|charged)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "boost",     name: "Boost", walletType: "ewallet",         country: "MY", currency: "MYR",
    packages: ["my.com.myboost"],
    patterns: [/(?:paid|spent)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bigpay",    name: "BigPay", walletType: "ewallet",        country: "MY", currency: "MYR",
    packages: ["com.tpaay.bigpay", "com.bigpay.wallet"],
    patterns: [/(?:paid|charged)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "spaylater", name: "SPayLater", walletType: "card",     country: "MY", currency: "MYR",
    packages: ["com.shopee.my"],
    patterns: [
      /SPayLater[^.]*?(?:charged|installment)[^.]*?(?:RM|MYR)\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i,
      /installment\s+of\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:is )?due/i,
    ] },
  { id: "atome",     name: "Atome", walletType: "card",         country: "MY", currency: "MYR",
    packages: ["my.atome.paylater", "com.atomeapp.mobile", "sg.com.apaylater"],
    patterns: [/Atome[^.]*?(?:charged|paid)[^.]*?(?:RM|MYR)\s*([\d,]+\.?\d*)[^.]*?(?:for|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "graypaylater",name: "GrabPay Later", walletName: "Grab PayLater", walletType: "card",country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/PayLater[^.]*?(?:RM|MYR)\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "maybank-mae", name: "Maybank MAE", walletBrand: "maybank", short: "Maybank", country: "MY", currency: "MYR",
    packages: ["com.maybank2u.life"],
    patterns: [
      /(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:paid|sent|debited|charged)[^.]*?(?:to|at)\s+(.+?)(?:\s+on|\s*[.]|$)/i,
      TXN_TRANSFER_OUT,
    ] },
  // Banks and wallets added in 1.56.2, ids checked on Google Play (MY). Shared
  // multilingual transfer + debit grammar below also covers every listed app.
  { id: "hsbc-my", name: "HSBC", country: "MY", currency: "MYR",
    packages: ["my.com.hsbc.hsbcmalaysia"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "ocbc-my", name: "OCBC", country: "MY", currency: "MYR",
    packages: ["com.ocbc.mobilemy"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "uob-my", name: "UOB TMRW", walletName: "UOB", country: "MY", currency: "MYR",
    packages: ["com.uob.mightymy"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "scb-my", name: "Standard Chartered", country: "MY", currency: "MYR",
    packages: ["air.app.scb.breeze.android.main.my.prod"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "alliance", name: "Alliance Bank", country: "MY", currency: "MYR",
    packages: ["com.alliance.AOPMobileApp", "com.aop2023"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "affin", name: "Affin", country: "MY", currency: "MYR",
    packages: ["com.affin.mobilebanking"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "bankrakyat", name: "Bank Rakyat", country: "MY", currency: "MYR",
    packages: ["com.irakyatmob.bkrm"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "muamalat", name: "Bank Muamalat", country: "MY", currency: "MYR",
    packages: ["my.com.muamalat.mobile.rib"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "agrobank", name: "Agrobank", country: "MY", currency: "MYR",
    packages: ["com.cedarplus.agro"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "mbsb", name: "MBSB Bank", country: "MY", currency: "MYR",
    packages: ["com.MBSB.Bank.Mobile.Banking"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "gxbank", name: "GXBank", country: "MY", currency: "MYR",
    packages: ["my.com.gxbank.app"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "aeonbank", name: "AEON Bank", country: "MY", currency: "MYR",
    packages: ["com.personal.adb"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "boostbank", name: "Boost Bank", country: "MY", currency: "MYR",
    packages: ["co.myboostbank.boostberhad"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "rytbank", name: "Ryt Bank", country: "MY", currency: "MYR",
    packages: ["my.rytbank.app"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "shopeepay-my", name: "ShopeePay", walletType: "ewallet", country: "MY", currency: "MYR",
    packages: ["com.shopeepay.my"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "ambank", name: "AmBank", country: "MY", currency: "MYR",
    packages: ["com.ambank.ambankonline", "com.ambank.ambankgroup"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bankislam", name: "Bank Islam", country: "MY", currency: "MYR",
    packages: ["com.bankislam.bimbmobile", "com.bankislam.android"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bsn", name: "BSN", country: "MY", currency: "MYR",
    packages: ["com.bsn.mybsn"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "setel", name: "Setel", walletType: "ewallet", country: "MY", currency: "MYR",
    packages: ["com.setel.mobile", "com.setel.app"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:paid|spent|fueled)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Singapore -----
  { id: "dbs-sg", name: "DBS digibank SG", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.dbsmbanking"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ocbc-sg", name: "OCBC SG", country: "SG", currency: "SGD",
    packages: ["com.ocbc.mobile"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "uob-sg", name: "UOB Mighty", country: "SG", currency: "SGD",
    packages: ["sg.com.uob.mighty.app"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:charged|paid|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "paylah", name: "DBS PayLah!", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.paylah"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:paid|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Indonesia -----
  { id: "bca", name: "BCA mobile", country: "ID", currency: "IDR",
    packages: ["com.bca"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "mandiri", name: "Livin' by Mandiri", country: "ID", currency: "IDR",
    packages: ["com.bankmandiri.mandiriapp"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bni", name: "BNI Mobile", country: "ID", currency: "IDR",
    packages: ["src.com.bni"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "brimo", name: "BRImo", country: "ID", currency: "IDR",
    packages: ["id.co.bri.brimo"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "gopay", name: "GoPay", country: "ID", currency: "IDR",
    packages: ["com.gojek.app"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "ovo", name: "OVO", country: "ID", currency: "IDR",
    packages: ["com.ovo"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "dana", name: "DANA", country: "ID", currency: "IDR",
    packages: ["id.dana"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-id", name: "ShopeePay ID", country: "ID", currency: "IDR",
    packages: ["com.shopee.id"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Thailand -----
  { id: "kplus", name: "K PLUS", country: "TH", currency: "THB",
    packages: ["com.kasikorn.retail.mbanking.wap"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "scb-easy", name: "SCB Easy", country: "TH", currency: "THB",
    packages: ["com.scb.phone"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "krungthai-next", name: "Krungthai NEXT", country: "TH", currency: "THB",
    packages: ["com.ktb.netbank"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bbl-th", name: "Bangkok Bank Mobile", country: "TH", currency: "THB",
    packages: ["com.bbl.mobilebanking"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "kma-th", name: "KMA Krungsri", country: "TH", currency: "THB",
    packages: ["com.krungsri.kma"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ttb-th", name: "ttb touch", country: "TH", currency: "THB",
    packages: ["com.ttb.touch"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "truemoney", name: "TrueMoney Wallet", country: "TH", currency: "THB",
    packages: ["th.co.truemoney.wallet"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "rabbit-line-pay", name: "Rabbit LINE Pay", country: "TH", currency: "THB",
    packages: ["jp.naver.line.android"],
    patterns: [/Rabbit\s+LINE\s+Pay[^.]*?(?:฿|THB)\s*([\d,]+\.?\d*)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Philippines -----
  { id: "bdo", name: "BDO Mobile", country: "PH", currency: "PHP",
    packages: ["com.bdo.unibank.mobilebanking"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bpi", name: "BPI Mobile", country: "PH", currency: "PHP",
    packages: ["com.bpi.cmpr"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "metrobank-ph", name: "Metrobank Mobile", country: "PH", currency: "PHP",
    packages: ["com.metrobank.metroclick"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "gcash", name: "GCash", country: "PH", currency: "PHP",
    packages: ["com.globe.gcash.android"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "maya-ph", name: "Maya", country: "PH", currency: "PHP",
    packages: ["com.paymaya"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-ph", name: "ShopeePay PH", country: "PH", currency: "PHP",
    packages: ["com.shopee.ph"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Vietnam -----
  { id: "vcb", name: "Vietcombank", country: "VN", currency: "VND",
    packages: ["com.VCB"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged|tr[ảa]\s+ph[íi])[^.]*?(?:at|to|t[ạa]i)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "vietinbank", name: "VietinBank iPay", country: "VN", currency: "VND",
    packages: ["com.vietinbank.ipay"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "techcombank", name: "Techcombank Mobile", country: "VN", currency: "VND",
    packages: ["vn.com.techcombank.bb.app"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bidv", name: "BIDV SmartBanking", country: "VN", currency: "VND",
    packages: ["com.vnpay.bidv"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "mbbank-vn", name: "MB Bank", country: "VN", currency: "VND",
    packages: ["com.mbmobile"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "momo", name: "MoMo", country: "VN", currency: "VND",
    packages: ["com.mservice.momotransfer"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "zalopay", name: "ZaloPay", country: "VN", currency: "VND",
    packages: ["vn.com.vng.zalopay"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-vn", name: "ShopeePay VN", country: "VN", currency: "VND",
    packages: ["com.shopee.vn"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
];

/* Locale-aware amount parsing.
   - Default (MY/SG/TH/PH): "1,234.56" — comma thousands, dot decimal.
   - ID/VN: "1.234,56" or "50.000" (dot thousands, comma decimal), AND English-
     style "50,000" / "1,234,567" (comma thousands, no decimal) used by some apps.
   Returns a Number, or NaN if unparseable. */
function parseAmount(raw, currency) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  if (currency === "IDR" || currency === "VND") {
    if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s)) return Number(s.replace(/,/g, ""));
    if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
  return Number(s.replace(/,/g, ""));
}

function providerForPackage(pkg) {
  if (!pkg) return null;
  return TXN_PROVIDERS.find((p) => p.packages.some((q) => pkg === q || pkg.startsWith(q))) || null;
}

/* Deny-list of promotional / non-transactional phrases across EN, MS, ID, ZH,
   TH, FIL, VI. If any show up in the text, skip parsing — not a transaction. */
const PROMO_DENY = [
  /\b(promo(?:tion)?|offer|deal|voucher|coupon|sale|discount|rebate|cashback\s+(?:earned|reward))\b/i,
  /\b(reward(?:s)?|points?\b(?!\s*$)|bonus(?:\s+points)?|loyalty)\b/i,
  /\b(you\s+(?:earned|got|have\s+(?:got|won)|received|are\s+eligible))\b/i,
  /\b(congrat(?:ulation)?s?|you\s+won|win(?:ner)?|free(?:\s+gift)?|gift)\b/i,
  /\b(statement|bill\s+is\s+ready|due\s+(?:in|on|tomorrow|today)|reminder|upcoming\s+payment|upcoming\s+bill)\b/i,
  /\b(referral|invite|limited\s+time|exclusive|new\s+feature|app\s+update)\b/i,
  /\b(earn\s+\d|get\s+\d+%|\d+%\s+off|save\s+up\s+to)\b/i,
  // Bahasa Melayu & Bahasa Indonesia
  /\b(promosi|baucar|kupon|diskaun|diskon|ganjaran|mata\s+ganjaran|tahniah|menang|hadiah\s+percuma|jemput\s+rakan|undang\s+teman)\b/i,
  /\b(penyata\s+(?:anda|bulanan)\s+(?:kini\s+)?sedia|bil\s+(?:anda\s+)?(?:akan\s+)?tamat|peringatan\s+bayaran|pulangan\s+tunai\s+(?:sehingga|hingga)|dapatkan\s+sehingga|jimat\s+sehingga|kongsikan\s+maklum\s+balas)\b/i,
  // Chinese (Simplified & Traditional)
  /(?:[优優]惠|折扣|代金券|[优優]惠券|抽[奖獎]|恭喜(?:[您你])?(?:[获獲]得|中[奖獎])|免[费費][领領]取|[积積]分|[账賬][单單]已(?:生成|出)|[还還]款提醒|邀[请請]好友|限[时時]|最高可享|满\d+减)/,
  // Thai
  /(?:โปรโมชั่?น|ส่วนลด|คูปอง|รับเครดิตเงินคืนสูงสุด|สะสมคะแนน|ยินดีด้วย|แจ้งเตือนครบกำหนด|ใบแจ้งยอดพร้อมแล้ว|ชวนเพื่อน)/,
  // Vietnamese & Filipino
  /(?:khuyến\s*mãi|ưu\s*đãi|mã\s*giảm\s*giá|hoàn\s*tiền\s*lên\s*đến|chúc\s*mừng|tích\s*điểm|nhắc\s*nhở\s*thanh\s*toán|sao\s*kê\s*đã\s*sẵn\s*sàng|giới\s*thiệu\s*bạn\s*bè)/i,
  /\b(promosyon|diskwento|manalo|paalala\s+sa\s+bayad)\b/i,
];
function isLikelyPromo(text) {
  if (!text) return false;
  return PROMO_DENY.some((re) => re.test(text));
}

// Stage 2: shared multilingual outbound transfer patterns (transfer: true).
const TXN_TRANSFER_OUT_RULES = [
  // EN: "transferred/sent <amt> to <who>" | "transfer of <amt> to <who>" | "<amt> transferred to <who>"
  new RegExp(`\\b(?:transferred|sent|remitted)\\s+(?<amt>${TXN_AMT_SRC})\\s+to\\s+(?<who>[^\\n.…]+)`, "i"),
  new RegExp(`\\b(?:(?:duitnow|instant|ibft|paynow|fast|instapay|promptpay|fund)\\s+)?transfer\\s+of\\s+(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\bto\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:has\\s+been\\s+|was\\s+)?(?:transferred|sent|remitted)\\s+to\\s+(?<who>[^\\n.…]+)`, "i"),
  // MS: "memindahkan/menghantar <amt> kepada <who>" | "pindahan <amt> kepada <who>" | "<amt> telah dipindahkan kepada <who>"
  new RegExp(`\\b(?:(?:telah|berjaya)\\s+)*(?:memindahkan|pindahkan|menghantar)\\s+(?:sebanyak\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:kepada|ke)\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`\\b(?:pindahan|pemindahan)(?:\\s+(?:duitnow|segera|wang|dana))?\\s+(?:sebanyak\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:kepada|ke)\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+)?(?:dipindahkan|dihantar)\\s+(?:kepada|ke)\\s+(?<who>[^\\n.…]+)`, "i"),
  // ZH: "向/给 <who> 转账 <amt>" | "转账 <amt> 至/给 <who>" | "<amt> 已转出至 <who>"
  new RegExp(`(?:向|[给給])(?<who>[^，。,\\n]{1,50}?)(?:[转轉][账賬]|[汇匯]款)\\s*(?<amt>${TXN_AMT_SRC})`, "i"),
  new RegExp(`(?:[转轉][账賬]|[汇匯]款)(?:成功)?\\s*(?<amt>${TXN_AMT_SRC})(?:(?:\\s*(?:至|[给給]|到))\\s*(?<who>[^，。,\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s*(?:已)?(?:[转轉]出|[转轉][账賬])(?:(?:至|[给給]|到)\\s*(?<who>[^，。,\\n]+))?`, "i"),
  // ID: "transfer / kirim <amt> ke <who>" | "<amt> berhasil ditransfer ke <who>"
  new RegExp(`\\b(?:mentransfer|transfer|kirim(?:\\s+(?:uang|dana))?)\\s+(?:berhasil\\s+)?(?:sebesar\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+ke\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:berhasil\\s+|telah\\s+)?(?:ditransfer|dikirim)\\s+ke\\s+(?<who>[^\\n.…]+)`, "i"),
  // TH: "โอนเงิน [สำเร็จ] [จำนวน] <amt> [ไปยัง/ให้/ถึง <who>]"
  new RegExp(`โอนเงิน(?:\\s*สำเร็จ)?(?:\\s*จำนวน)?\\s*(?<amt>${TXN_AMT_SRC})(?:\\s*(?:ไปยัง|ให้|ถึง)\\s*(?<who>[^\\n.…]+))?`, "i"),
  // FIL: "nagpadala / nag-transfer ng <amt> kay/sa <who>"
  new RegExp(`\\b(?:nagpadala|ipinadala|nag-?transfer)\\s+(?:ka\\s+)?(?:ng\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:kay|sa)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // VI: "chuyển tiền/khoản <amt> đến/tới/cho <who>"
  new RegExp(`(?:chuyển(?:\\s*tiền|\\s*khoản)?)\\s+(?:thành\\s*công\\s+)?(?:số\\s*tiền\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:đến|tới|cho)\\s+(?<who>[^\\n.…]+))?`, "i"),
];

// Stage 3: shared multilingual debit / spend patterns (transfer: false).
const TXN_DEBIT_RULES = [
  // EN amount-first: "<amt> (has been / was) charged/debited/deducted/paid/spent ... at/to/for <who>"
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:charged|debited|deducted|paid|spent|used|authori[sz]ed|withdrawn)(?:[^.\\n]{0,50}?\\b(?:at|to|for)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // EN verb-first: "Paid / Spent / Payment of / DuitNow QR payment of / Purchase / Card spend <amt> at/to/for <who>"
  new RegExp(`\\b(?:paid|spent|charged|debited|deducted|purchased|purchase|payment|duitnow\\s*qr(?:\\s+payment)?|qr\\s*pay(?:ment)?|card\\s+(?:spend|purchase|transaction)|e-?commerce\\s+transaction|bill\\s+payment|auto[- ]?debit|top[- ]?up|reload|transaction)\\s+(?:of\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,40}?\\b(?:at|to|for)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // MS amount-first: "<amt> telah dibayar/ditolak/didebitkan/dibelanjakan/dipotong ... di/kepada/ke <who>"
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+|berjaya\\s+|berhasil\\s+)?(?:dibayar|ditolak|didebitkan|didebet|dibelanjakan|dipotong|dikenakan)(?:[^.\\n]{0,50}?\\b(?:di|kepada|ke|untuk)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // MS/ID verb-first: "Pembayaran / Bayaran / Pembelian / Transaksi / QRIS <amt> di/kepada/ke <who>"
  new RegExp(`\\b(?:membayar|bayar|pembayaran|bayaran|pembelian|beli|belanja|potongan|transaksi|debit|tarik\\s+tunai|qris|duitnow\\s*qr(?:\\s+bayaran)?)\\s+(?:berjaya\\s+|berhasil\\s+)?(?:sebanyak\\s+|sebesar\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,40}?\\b(?:di|kepada|ke|untuk)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // ZH: "在<who>支付/付款/消费/刷卡 <amt>" | "支付/付款/消费/扣款 <amt> [商户/至/在 <who>]" | "<amt> 已扣款/支付"
  new RegExp(`(?:在(?<who1>[^，。,\\n]{1,40}?))?(?:支付|付款|消[费費]|刷卡|扣款|扣除|[缴繳][费費]|[购購][买買])(?:了)?(?:成功)?\\s*(?<amt>${TXN_AMT_SRC})(?:[，,\\s]*(?:商[户戶]|商家|至|[给給]|在|[于於])[:：\\s]*(?<who2>[^，。,\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s*(?:已)?(?:扣款|扣除|支付|付款|消[费費]|刷卡)(?:[，,\\s]*(?:商[户戶]|商家|至|[给給]|在|[于於])[:：\\s]*(?<who>[^，。,\\n]+))?`, "i"),
  // TH: "ชำระเงิน/จ่าย/หักบัญชี/ใช้จ่าย/ซื้อสินค้า/รูดบัตร [สำเร็จ] [จำนวน] <amt> [ที่/ให้/ร้าน <who>]"
  new RegExp(`(?:ชำระ(?:เงิน|ค่า)?|จ่าย(?:เงิน|ค่า)?|หัก(?:เงิน|บัญชี)|ใช้จ่าย|ซื้อสินค้า|รูดบัตร)(?:สำเร็จ)?(?:\\s*จำนวน)?\\s*(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?(?:ที่|ให้|ไปยัง|ร้าน)\\s*(?<who>[^\\n.…]+))?`, "i"),
  // FIL: "nagbayad / binayaran / gumastos / binawas ng <amt> sa/kay <who>"
  new RegExp(`\\b(?:nagbayad|binayaran|gumastos|bayad|binawas)\\s+(?:ka\\s+)?(?:ng\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\b(?:sa|kay|para\\s+sa)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // VI: "thanh toán / chi tiêu / trừ tiền / giao dịch <amt> tại/cho <who>" | "Biến động số dư: -<amt>"
  new RegExp(`(?:thanh\\s*toán|chi\\s*tiêu|trừ\\s*tiền|giao\\s*dịch|trả\\s*tiền|mua\\s*hàng|rút\\s*tiền)(?:\\s+thành\\s*công)?(?:\\s+số\\s*tiền)?\\s*(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\b(?:tại|cho|ở|đến)\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?:biến\\s*động\\s*số\\s*dư|tài\\s*khoản)[^.\\n]{0,40}-\\s*(?<amt>${TXN_AMT_SRC})(?:[^\\n]{0,40}?(?:tại|cho|nội\\s*dung\\s*[:：])\\s*(?<who>[^\\n.…]+))?`, "i"),
];

// Structured / labelled alert fields (multi-line or colon-separated).
const TXN_LABEL_AMT = new RegExp(`(?:^|[\\n.;,])\\s*(?:amount|amaun|jumlah|nominal|[金總总][额額]|จำนวน(?:เงิน)?|số\\s*tiền)\\s*[:：]\\s*(?<amt>${TXN_AMT_SRC})`, "i");
const TXN_LABEL_WHO = /(?:^|[\n.;,])\s*(?:merchant|payee|recipient|to|shop|store|pedagang|penerima|kepada|商[户戶]|商家|收款人|ร้านค้า|người\s*nhận)\s*[:：]\s*([^\n;]+)/i;
// Bare "<amt> at/to <who>" when title+body already carries a debit cue.
const TXN_BARE_AT = new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:at|to|di|kepada|ke|ที่|tại)\\s+(?<who>[^\\n.…]+)`, "i");

function parseBankText(text, pkg) {
  const norm = normNotifText(text);
  if (!norm) return null;
  if (CAPTURE_DENY.test(norm) || TXN_FAILED_DENY.test(norm) || isLikelyPromo(norm)) return null;
  // Money coming to the reader is never a spend, even when parseBankText is called directly.
  if (TXN_CREDIT_CUE.test(norm) && !TXN_SELF_OUT_CUE.test(norm)) return null;

  const pkgProvider = providerForPackage(pkg);
  const provider = pkgProvider
    || TXN_PROVIDERS.find((p) => p.patterns.some((re) => re.test(norm)));
  if (!provider) return null;

  const build = (amount, currency, merchantRaw, transfer) => {
    const rawM = String(merchantRaw || "").trim();
    if (rawM && TXN_PAYEE_IS_YOU.test(rawM)) return null;
    const merchant = cleanTxnMerchant(rawM);
    return {
      amount: Math.round(amount * 100) / 100,
      merchant,
      providerId: provider.id,
      providerName: provider.name,
      country: provider.country,
      currency: currency || provider.currency,
      // A person-to-person transfer can be money moving between your own
      // wallets; a card spend at a shop never is.
      transfer: !!transfer,
    };
  };

  // Stage 1: provider-specific patterns (highest priority).
  for (const re of provider.patterns) {
    const m = norm.match(re);
    if (!m) continue;
    const amount = parseAmount(m[1], provider.currency);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const rawM = m[2] ? m[2].trim().replace(/\s{2,}/g, " ") : "";
    if (rawM && TXN_PAYEE_IS_YOU.test(rawM)) continue;
    const res = build(amount, provider.currency, rawM, re === TXN_TRANSFER_OUT);
    if (res) return res;
  }

  // Stages 2 & 3 run only when the app itself is on the whitelist (pkgProvider),
  // so unknown apps never get a fabricated provider.
  if (!pkgProvider) return null;

  // Stage 2: shared multilingual transfer-out rules.
  for (const re of TXN_TRANSFER_OUT_RULES) {
    const m = norm.match(re);
    if (!m || !m.groups) continue;
    const hit = parseTxnAmtFragment(m.groups.amt, provider.currency);
    if (!hit) continue;
    if (m.groups.who && TXN_PAYEE_IS_YOU.test(m.groups.who.trim())) return null;
    const res = build(hit.amount, hit.currency, m.groups.who || "", true);
    if (res) return res;
  }

  // Stage 3a/3b: shared multilingual debit rules (amount-first & verb-first).
  for (const re of TXN_DEBIT_RULES) {
    const m = norm.match(re);
    if (!m || !m.groups) continue;
    const hit = parseTxnAmtFragment(m.groups.amt, provider.currency);
    if (!hit) continue;
    const who = m.groups.who || m.groups.who2 || m.groups.who1 || "";
    if (who && TXN_PAYEE_IS_YOU.test(who.trim())) return null;
    const res = build(hit.amount, hit.currency, who, false);
    if (res) return res;
  }

  // Stage 3c/3d: structured labels or title-cue + "<amt> at/to <merchant>".
  if (TXN_DEBIT_CUE.test(norm)) {
    const lblAmt = norm.match(TXN_LABEL_AMT);
    const lblWho = norm.match(TXN_LABEL_WHO);
    if (lblAmt && lblAmt.groups) {
      const hit = parseTxnAmtFragment(lblAmt.groups.amt, provider.currency);
      if (hit) {
        const res = build(hit.amount, hit.currency, lblWho ? lblWho[1] : "", false);
        if (res) return res;
      }
    }
    const bare = norm.match(TXN_BARE_AT);
    if (bare && bare.groups) {
      const hit = parseTxnAmtFragment(bare.groups.amt, provider.currency);
      if (hit) {
        const res = build(hit.amount, hit.currency, bare.groups.who || "", false);
        if (res) return res;
      }
    }
    const nonBal = extractTxnAmounts(norm, provider.currency).filter((x) => !x.isBalance);
    if (nonBal.length === 1) {
      const res = build(nonBal[0].amount, nonBal[0].currency, lblWho ? lblWho[1] : "", false);
      if (res) return res;
    }
  }
  return null;
}

/* ---------- Incoming transfers (credits), for split auto-match & income ----------
   Everything above parses money LEAVING the account. Incoming transfers and
   credits across EN, MS, ZH, ID, TH, FIL and VI land here: MYR credits are
   checked against open split requests first; any other credit from a listed
   app becomes a pending income entry for the user to confirm. */

const TXN_INCOMING_PATTERNS = [
  // EN sender-first: "ALI BIN ABU has transferred RM 1.00 to you." (TNG / PayNow / etc.)
  new RegExp(`(?:^|[.!\\n]\\s*)(?:hi[,!]?\\s+)?(?<who>[^.!\\n]{2,60}?)\\s+(?:has\\s+|have\\s+)?(?:transferred|sent|paid)\\s+(?:you\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+to\\s+(?:you|your\\s+(?:account|e-?wallet|wallet)))?(?=[\\s.!,]|$)`, "i"),
  // MS sender-first: "ALI telah memindahkan RM 1.00 kepada anda"
  new RegExp(`(?:^|[.!\\n]\\s*)(?<who>[^.!\\n]{2,60}?)\\s+(?:telah\\s+)?(?:memindahkan|menghantar|membayar)\\s+(?<amt>${TXN_AMT_SRC})\\s+kepada\\s+anda`, "i"),
  // ZH sender-first: "ALI已向您转账RM10.00" / "ALI转给您RM10.00"
  new RegExp(`(?:^|[。！!\\n]\\s*)(?<who>[^，。！!\\n]{1,40}?)\\s*(?:已|刚刚|剛剛)?(?:向[您你]|[给給][您你])?(?:[转轉][账賬]|[汇匯]款|支付了?|[转轉]了)(?:[给給][您你])?\\s*(?<amt>${TXN_AMT_SRC})`, "i"),
  // TH sender-first: "ALI โอนเงิน 50.00 บาท ให้คุณ"
  new RegExp(`(?:^|[.!\\n]\\s*)(?<who>[^.!\\n]{2,50}?)\\s*โอนเงิน\\s*(?<amt>${TXN_AMT_SRC})\\s*ให้คุณ`, "i"),
  // EN receiver-first: "You have received RM23.50 from AHMAD ALI"
  new RegExp(`(?:you(?:'|’)?(?:ve| have)?\\s+)?(?:just\\s+)?received\\s+(?:(?:money|funds|a\\s+transfer|a\\s+payment)\\s+(?:of\\s+)?)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,40}?\\bfrom\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // EN passive: "RM23.50 has been credited to your account from ALI"
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:received|credited|deposited)(?:[^.\\n]*?\\bfrom\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // EN labelled: "Incoming DuitNow / PayNow / FAST / InstaPay transfer RM23.50 from ALI"
  new RegExp(`(?:incoming|duitnow|instant|paynow|fast|instapay|promptpay)[^.\\n]{0,40}?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,20}?\\bfrom\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // MS receiver-first & passive: "Anda telah menerima RM23.50 daripada ALI" | "RM23.50 telah dikreditkan ... daripada ALI"
  new RegExp(`(?:menerima|diterima|masuk)(?:\\s+(?:wang|dana|pindahan|bayaran))?\\s*(?:sebanyak\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\b(?:daripada|dari)\\s+(?<who>[^.,;\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+)?(?:dikreditkan|dimasukkan|diterima)(?:[^.\\n]*?\\b(?:daripada|dari)\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // ZH receiver-first & passive: "您已收到来自ALI的RM23.50" | "收到RM23.50，来自ALI" | "RM23.50已入账"
  new RegExp(`(?:[您你])?(?:已|刚刚|剛剛)?收到(?:[来來]自)?(?:(?<who1>[^，。,\\n]{1,40}?)(?:的|[转轉][来來]的|支付的))?\\s*(?<amt>${TXN_AMT_SRC})(?:[，,\\s]*(?:[来來]自|付款人[:：]?)\\s*(?<who2>[^，。,\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s*(?:已)?(?:入[账賬]|存入|[转轉]入)(?:(?:您的|你的)?(?:[账賬][户戶]|[钱錢]包))?`, "i"),
  // ID: "Dana/Uang/Transfer/Saldo masuk Rp 50.000 dari BUDI" | "menerima transfer Rp 50.000 dari BUDI"
  new RegExp(`(?:(?:dana|uang|transfer|saldo)\\s+masuk|menerima(?:\\s+(?:transfer|dana|uang|pembayaran))?)\\s*(?:sebesar\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\bdari\\s+(?<who>[^.,;\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+|berhasil\\s+)?(?:masuk|diterima|dikreditkan)(?:[^.\\n]*?\\bdari\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // TH: "ได้รับเงินโอน 100.00 บาท จาก SOMCHAI" | "เงินเข้าบัญชี 100.00 บาท"
  new RegExp(`(?:(?:คุณ)?ได้รับ(?:เงินโอน|เงิน|โอน|ชำระ)?|(?:มี)?เงินเข้า(?:บัญชี)?|รับโอนเงิน)(?:\\s*จำนวน)?\\s*(?<amt>${TXN_AMT_SRC})(?:\\s*จาก\\s*(?<who>[^.,;\\n]+))?`, "i"),
  // FIL: "Nakatanggap ka ng PHP 500.00 mula kay JUAN"
  new RegExp(`\\b(?:nakatanggap\\s+ka\\s+ng|natanggap\\s+mo\\s+ang)\\s+(?<amt>${TXN_AMT_SRC})(?:\\s+mula\\s+(?:kay|sa)\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // VI: "Bạn vừa nhận được 100.000đ từ NGUYEN" | "Biến động số dư: +100.000đ"
  new RegExp(`(?:nhận\\s+(?:được\\s+)?|cộng\\s+)(?:số\\s*tiền\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+từ\\s+(?<who>[^.,;\\n]+))?`, "i"),
  new RegExp(`(?:biến\\s*động\\s*số\\s*dư|tài\\s*khoản)[^.\\n]{0,40}\\+\\s*(?<amt>${TXN_AMT_SRC})(?:[^\\n]{0,40}?(?:từ|nội\\s*dung\\s*[:：])\\s*(?<who>[^.,;\\n]+))?`, "i"),
];

// Words that turn a "received" into something that is not money landing in
// your account: a request, a statement, a reward, or a merchant confirming your spend.
const INCOMING_DENY = [
  /\b(request(?:ed|s)?|reminder|invoice|bill\s+is\s+ready|statement)\b/i,
  /\b(refund(?:ed)?\s+request|pending|failed|unsuccessful|declined|reversed)\b/i,
  // "We have received your payment of RM120" — a merchant confirming money
  // you SENT. Same verb, opposite direction.
  /\breceived\s+your\s+payment\b/i,
  /\byour\s+payment\s+(?:of|has been)\b/i,
  /\b(?:kami\s+telah\s+menerima\s+bayaran\s+anda|permintaan\s+bayaran)\b/i,
  /(?:已收到您的付款|付款[请請]求|收款[请請]求)/,
];

function parseIncomingTransfer(text, pkg) {
  const raw = normNotifText(text);
  if (!raw) return null;
  if (CAPTURE_DENY.test(raw) || TXN_FAILED_DENY.test(raw) || isLikelyPromo(raw)) return null;
  if (INCOMING_DENY.some((re) => re.test(raw))) return null;
  // A credit verb or cue has to be present somewhere — "RM50 to ALI" is a
  // payment going the other way and must never look like a repayment.
  const hasCreditVerb = /\b(received|credited|deposited|incoming|menerima|diterima|dikreditkan|dimasukkan|masuk|nakatanggap|natanggap)\b|(?:收到|入[账賬]|存入|[转轉]入|ได้รับ|เงินเข้า|รับโอน|nhận\s+(?:được|tiền)|cộng\s+vào|ghi\s+có)/i.test(raw);
  if (!hasCreditVerb && !TXN_CREDIT_CUE.test(raw)) return null;
  const provider = providerForPackage(pkg);
  const defCur = provider ? provider.currency : "MYR";
  for (let i = 0; i < TXN_INCOMING_PATTERNS.length; i++) {
    const re = TXN_INCOMING_PATTERNS[i];
    const m = raw.match(re);
    if (!m) continue;
    const g = m.groups || {};
    // The first 4 patterns are sender-first shapes: only count when the text
    // explicitly says it came TO you (credit cue).
    if (i < 4 && !TXN_CREDIT_CUE.test(raw)) continue;
    const hit = g.amt ? parseTxnAmtFragment(g.amt, defCur) : null;
    const amount = hit ? hit.amount : parseAmount(m[1], defCur);
    const currency = hit ? hit.currency : defCur;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const whoRaw = String(g.who || g.who2 || g.who1 || m[2] || "").trim().replace(/\s{2,}/g, " ");
    if (i < 4 && (/^(?:you|i|we|anda|saya|kami)\b/i.test(whoRaw) || /\b(?:you|have)$/i.test(whoRaw) || /^(?:您|你|我|คุณ|bạn)$/.test(whoRaw))) continue;
    const who = cleanTxnMerchant(whoRaw);
    return {
      amount: Math.round(amount * 100) / 100,
      sender: who.slice(0, 60),
      currency,
      raw,
      providerId: provider ? provider.id : "",
      providerName: provider ? provider.name : "",
    };
  }
  return null;
}

/* Queues the "RM 23.50 received — settle Ali's share?" pending action.
   Returns false (and queues nothing) unless the matcher found something,
   because a bank credit that matches no open request is not Duitful's
   business — the user did not ask for their salary to be commented on. */
function queueIncomingTransfer(data) {
  let parsed = null;
  for (const text of captureTexts(data)) { parsed = parseIncomingTransfer(text, data.package || ""); if (parsed) break; }
  if (!parsed) return false;
  if (typeof splitMatchIncoming !== "function") return false;
  const res = splitMatchIncoming(parsed);
  if (!res || res.status === "none" || !res.matches.length) return false;

  const now = captureTime(data);
  state.pendingTxns = state.pendingTxns || [];
  // Same amount, same first candidate, inside two minutes: the bank fired
  // twice (lock screen + drawer), not two people paying the same sum.
  const dupe = state.pendingTxns.find((p) => p.kind === "split-match"
    && Math.abs(Number(p.amount) - parsed.amount) < 0.005
    && p.matches && p.matches[0] && res.matches[0] && p.matches[0].personId === res.matches[0].personId
    && Math.abs(now - p.createdAt) < 120000);
  if (dupe) return false;

  state.pendingTxns.push({
    id: uid(),
    kind: "split-match",
    createdAt: now,
    raw: String(data.text || ""),
    pkg: String(data.package || ""),
    amount: parsed.amount,
    sender: parsed.sender,
    currency: parsed.currency || "MYR",
    providerId: parsed.providerId,
    providerName: parsed.providerName,
    match: res.status,
    via: res.via || "amount",
    matches: res.matches.map((m) => ({
      personId: m.personId, name: m.name, title: m.title, remaining: m.remaining,
    })),
  });
  save();
  if (typeof renderAll === "function") renderAll();
  return true;
}

// The body says what happened on most banks; a few put it in the title
// ("DuitNow Transfer is successful"). Try the body, then title + body.
function captureTexts(data) {
  const text = String((data && data.text) || "");
  const title = String((data && data.title) || "").trim();
  return title && !text.includes(title) ? [text, `${title}. ${text}`] : [text];
}

// When a captured notification was posted: drained ones carry it, live ones are now.
function captureTime(data) {
  const t = Number(data && data.postedAt);
  return Number.isFinite(t) && t > 0 && t <= Date.now() + 60000 ? t : Date.now();
}

function queuePendingTxn(data) {
  // Direction first, on title + body together: money coming to the reader is
  // never booked as a spend, whatever debit pattern happens to match.
  const whole = normNotifText(captureTexts(data).join(" "));
  if (TXN_FAILED_DENY.test(whole)) return false;
  if (TXN_CREDIT_CUE.test(whole) && !TXN_SELF_OUT_CUE.test(whole)) return false;
  let parsed = null;
  for (const text of captureTexts(data)) { parsed = parseBankText(text, data.package || ""); if (parsed) break; }
  if (!parsed) return false;
  // de-dupe: ignore exact (provider, amount, merchant) within 2 minutes of each other
  const now = captureTime(data);
  state.pendingTxns = state.pendingTxns || [];
  const dupe = pendingSpends().find((p) => p.providerId === parsed.providerId
    && p.amount === parsed.amount
    && p.merchant === parsed.merchant
    && Math.abs(now - p.createdAt) < 120000);
  if (dupe) return false;
  queueDebit({
    id: uid(),
    createdAt: now,
    raw: String(data.text || ""),
    pkg: String(data.package || ""),
    amount: parsed.amount,
    merchant: parsed.merchant,
    providerId: parsed.providerId,
    providerName: parsed.providerName,
    country: parsed.country,
    currency: parsed.currency,
    transfer: !!parsed.transfer,
  });
  return true;
}

/* ---------- Money in, and money moving between your own accounts ----------
   A credit that settles a split is handled above and goes no further. Any
   other credit from a listed app becomes a pending income entry. A transfer
   out in one app and a credit of the same amount in another, within
   PAIR_WINDOW_MS of each other (either order), is one move: confirming it
   books nothing. A transfer to a name saved with "This is my account" is a
   move on its own. */
const PAIR_WINDOW_MS = 10 * 60 * 1000;
// A lone transfer out waits this long, out of sight, for its other half.
const PENDING_HOLD_MS = 60 * 1000;
// OTPs and security codes are never money, whatever figures they contain (EN, MS, ID, ZH, TH, FIL, VI).
const CAPTURE_DENY = new RegExp([
  "\\b(?:OTP|TAC|one[- ]time\\s+(?:password|passcode|pin|code)|verification\\s+code|security\\s+code|authori[sz]ation\\s+code|do\\s+not\\s+share|your\\s+PAC\\s+is|PAC\\s+(?:code|number|no\\.?))\\b",
  "\\b(?:kod\\s+(?:pengesahan|keselamatan)|kode\\s+(?:otp|verifikasi|keamanan)|jangan\\s+(?:kongsi|berikan|bagikan)|kata\\s+laluan\\s+sekali|huwag\\s+ibahagi)\\b",
  "(?:[验驗][证證][码碼]|[动動][态態]密[码碼]|一次性密[码碼]|安全[码碼]|[请請]勿[泄洩]露|切勿告知)",
  "(?:รหัสยืนยัน|รหัสผ่านใช้ครั้งเดียว|ห้ามบอก|อย่าเปิดเผย)",
  "(?:mã\\s+xác\\s+(?:thực|nhận)|mã\\s+bảo\\s+mật|không\\s+chia\\s+sẻ|tuyệt\\s+đối\\s+không)",
].join("|"), "i");

function normOwnName(s) { return String(s || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 60); }
function coerceOwnAccounts(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(normOwnName).filter(Boolean))].slice(0, 30);
}
function isOwnName(name) {
  const n = normOwnName(name);
  return !!n && (state.ownAccounts || []).includes(n);
}
function providerShort(id, fallback) {
  const p = TXN_PROVIDERS.find((x) => x.id === id);
  return (p && (p.short || p.name)) || fallback || "Bank";
}
function pendingSource(p) { return (p && (p.providerId || p.pkg)) || ""; }
function sameAmount(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }
function pendingSpends() {
  const out = [];
  for (const p of state.pendingTxns || []) {
    if (!p.kind) out.push(p);
    else if (p.kind === "move" && p.from) out.push(p.from);
  }
  return out;
}
function pendingCredits() {
  const out = [];
  for (const p of state.pendingTxns || []) {
    if (p.kind === "income") out.push(p);
    else if (p.kind === "move" && p.to) out.push(p.to);
  }
  return out;
}
function makeMove(from, to, own) {
  const parts = [from, to].filter(Boolean);
  return {
    id: uid(), kind: "move", createdAt: Math.min(...parts.map((x) => x.createdAt)),
    amount: parts[0].amount, currency: parts[0].currency || "MYR",
    from: from || null, to: to || null, own: !!own,
  };
}
// The other half of a move: opposite direction, same amount, a different
// app, close in time, and not split apart by the user before.
function findPairPartner(item, wantKind) {
  const list = state.pendingTxns || [];
  return list.findIndex((p) => !p.noPair
    && (wantKind === "income" ? (p.kind === "income" && !p.label) : (!p.kind && p.transfer))
    && sameAmount(p.amount, item.amount)
    && pendingSource(p) !== pendingSource(item)
    && Math.abs(p.createdAt - item.createdAt) <= PAIR_WINDOW_MS);
}
function commitPending() {
  save();
  if (typeof renderAll === "function") renderAll();
}
function queueDebit(item) {
  state.pendingTxns = state.pendingTxns || [];
  if (item.transfer && !item.noPair) {
    if (isOwnName(item.merchant)) { state.pendingTxns.push(makeMove(item, null, true)); commitPending(); return; }
    const at = findPairPartner(item, "income");
    if (at >= 0) { state.pendingTxns[at] = makeMove(item, state.pendingTxns[at], false); commitPending(); return; }
  }
  state.pendingTxns.push(item);
  commitPending();
}
function queueCredit(item) {
  state.pendingTxns = state.pendingTxns || [];
  if (!item.label && !item.noPair) {
    if (isOwnName(item.sender)) { state.pendingTxns.push(makeMove(null, item, true)); commitPending(); return; }
    const at = findPairPartner(item, "spend");
    if (at >= 0) { state.pendingTxns[at] = makeMove(state.pendingTxns[at], item, false); commitPending(); return; }
  }
  state.pendingTxns.push(item);
  commitPending();
}

// Refunds, reversals and cashback are labelled, so they are never booked as
// if they were pay.
function creditLabel(text) {
  if (/\b(?:refund|bayaran\s+balik|pengembalian\s+dana)\b|(?:退款|คืนเงิน|hoàn\s*tiền)/i.test(text)) return "Refund";
  if (/\b(?:revers|pembalikan)\b|(?:冲正|沖正|回冲)/i.test(text)) return "Reversal";
  if (/\b(?:cashback|pulangan\s+tunai)\b|(?:返[现現]|เครดิตเงินคืน)/i.test(text)) return "Cashback";
  return "";
}
const CREDIT_REFUND_PAT = new RegExp(`(?:\\b(?:refund(?:ed)?|reversal|reversed|cashback|bayaran\\s+balik|pengembalian\\s+dana|pulangan\\s+tunai)\\b|(?:退款|返[现現]|冲正|沖正|คืนเงิน|เครดิตเงินคืน|hoàn\\s*tiền))[^.\\n]{0,40}?(?<amt>${TXN_AMT_SRC})`, "i");
function parseIncomingCredit(text, pkg) {
  const raw = normNotifText(text);
  if (!raw || CAPTURE_DENY.test(raw) || TXN_FAILED_DENY.test(raw)) return null;
  const label = creditLabel(raw);
  let parsed = parseIncomingTransfer(raw, pkg);
  if (!parsed && label && !isLikelyPromo(raw) && !/\b(?:request(?:ed)?|pending|failed|unsuccessful|declined)\b/i.test(raw)) {
    const provider = providerForPackage(pkg);
    const defCur = provider ? provider.currency : "MYR";
    const m = raw.match(CREDIT_REFUND_PAT);
    const hit = m && m.groups ? parseTxnAmtFragment(m.groups.amt, defCur) : null;
    if (hit && hit.amount > 0) {
      parsed = { amount: hit.amount, sender: "", currency: hit.currency, raw, providerId: provider ? provider.id : "", providerName: provider ? provider.name : "" };
    }
  }
  return parsed ? { ...parsed, label } : null;
}
function queueIncomingCredit(data) {
  const pkg = String(data.package || "");
  if (!providerForPackage(pkg)) return false;
  let parsed = null;
  for (const text of captureTexts(data)) { parsed = parseIncomingCredit(text, pkg); if (parsed) break; }
  if (!parsed) return false;
  const now = captureTime(data);
  const item = {
    id: uid(), kind: "income", createdAt: now, raw: String(data.text || ""), pkg,
    amount: parsed.amount, sender: parsed.sender || "", label: parsed.label || "",
    providerId: parsed.providerId, providerName: parsed.providerName, currency: parsed.currency || "MYR",
  };
  // The bank firing twice, or the same credit already offered to settle a split.
  const dup = pendingCredits().some((p) => pendingSource(p) === pendingSource(item) && sameAmount(p.amount, item.amount) && Math.abs(now - p.createdAt) < 120000)
    || (state.pendingTxns || []).some((p) => p.kind === "split-match" && sameAmount(p.amount, item.amount) && Math.abs(now - p.createdAt) < 120000);
  if (dup) return false;
  queueCredit(item);
  return true;
}

/* "This is my account": remember the name (vault only), and turn this and
   any other waiting transfer to it into a move. */
function markOwnAccount(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  const name = p && normOwnName(p.kind === "income" ? p.sender : p.merchant);
  if (!name) return;
  state.ownAccounts = coerceOwnAccounts([...(state.ownAccounts || []), name]);
  state.pendingTxns = state.pendingTxns.map((x) => {
    if (!x.kind && x.transfer && normOwnName(x.merchant) === name) return makeMove(x, null, true);
    if (x.kind === "income" && !x.label && normOwnName(x.sender) === name) return makeMove(null, x, true);
    return x;
  });
  commitPending();
  toast(tr("Saved. Transfers to {name} count as moves.", { name }));
}
function removeOwnAccount(name) {
  state.ownAccounts = (state.ownAccounts || []).filter((n) => n !== name);
  commitPending();
}
// Confirm a move: nothing is booked anywhere.
function acceptMove(id) {
  // Between two wallets (from the apps its halves came from): a wallet move,
  // still neither spending nor income.
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (p && typeof walletBookCaptureMove === "function") walletBookCaptureMove(p);
  state.pendingTxns = (state.pendingTxns || []).filter((x) => x.id !== id);
  commitPending();
  toast(tr("Moved between your accounts — not counted as spending or income."));
}
// "Not a move": back to the spend and/or income it was made of, kept apart.
function splitMove(id) {
  const list = state.pendingTxns || [];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0 || list[i].kind !== "move") return;
  const m = list[i];
  const parts = [m.from, m.to].filter(Boolean).map((x) => ({ ...x, noPair: true }));
  list.splice(i, 1, ...parts);
  commitPending();
}
function acceptIncomePending(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (!p) return;
  const d = new Date(p.createdAt || Date.now());
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const from = providerShort(p.providerId, p.providerName);
  // Booked like a split repayment: a one-off row in that month's income,
  // never copied into next month.
  state.income.push({
    id: uid(),
    name: p.label ? `${p.label}${p.sender ? ` — ${p.sender}` : ` · ${from}`}` : (p.sender ? `From ${p.sender}` : `Money in · ${from}`),
    amount: p.amount,
    month: iso.slice(0, 7),
    day: Number(iso.slice(8, 10)),
    repeatNext: false,
    category: p.label || "Money in",
    note: p.providerName || "",
    ...(typeof walletForPkg === "function" && walletForPkg(p.pkg) ? { walletId: walletForPkg(p.pkg).id } : {}),
  });
  state.pendingTxns = state.pendingTxns.filter((x) => x.id !== id);
  commitPending();
  toast(tr("{a} added to income", { a: fmtMoney(p.amount) }));
}

/* ---------- Quick add: the widget and the shade ----------

   A tap on the widget's +RM 10, or an amount typed into the quick-add
   notification, happens while the app is closed — so it cannot reach the
   vault. The key is derived from the passcode and only exists in memory
   while Duitful is open.

   So native appends a small plain entry to a queue and we drain it here, the
   moment there IS a key. Each one becomes an ordinary pending transaction,
   reviewed in the same card as a captured bank notification: nothing lands in
   the ledger without a tap. That queue is the only Duitful data that ever
   sits outside the encryption, and it holds an amount and a category — never
   a balance, never a total.

   Note this is strictly better than the bank-notification capture beside it,
   which drops anything arriving while the app is closed because
   NotificationListenerPlugin.emit() no-ops without a live instance. */
function quickAddPlugin() {
  try {
    if (!isNative()) return null;
    // Android: the notification-listener plugin owns the queue. iOS: the
    // Siri & Shortcuts intents write it and DuitfulKit drains it.
    const p = window.Capacitor?.Plugins?.NotificationListener;
    if (p && typeof p.drainQuickAdd === "function") return p;
    const kit = window.Capacitor?.Plugins?.DuitfulKit;
    return kit && typeof kit.drainQuickAdd === "function" ? kit : null;
  } catch { return null; }
}

// Pure: one queued entry → one pending transaction. Separated so the shape
// can be tested without a device, and so a malformed entry is dropped rather
// than poisoning the drain.
function quickAddToPending(entry) {
  const amount = Number(entry && entry.a);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const category = typeof entry.c === "string" && entry.c.trim() ? entry.c.trim() : "";
  const ts = Number(entry && entry.t);
  return {
    id: uid(),
    createdAt: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    raw: "",
    pkg: "",
    amount: Math.round(amount * 100) / 100,
    merchant: category,
    providerId: "quick-add",
    // "s": "shortcut" comes from the iOS Siri & Shortcuts intent, where "c"
    // is the merchant (a Wallet automation passes the shop's name).
    providerName: entry.s === "shortcut"
      ? (category ? `${tr("Shortcut")} · ${category}` : "Siri & Shortcuts")
      : (category ? `${tr("Quick add")} · ${category}` : tr("Quick add")),
    country: "MY",
    currency: typeof currentCurrency === "function" ? currentCurrency() : "MYR",
  };
}

async function drainQuickAdd() {
  const plugin = quickAddPlugin();
  if (!plugin || !aesKey) return 0;
  let items = [];
  try {
    const res = await plugin.drainQuickAdd();
    items = (res && Array.isArray(res.items)) ? res.items : [];
  } catch (err) {
    console.warn("quick-add drain failed:", err);
    return 0;
  }
  if (!items.length) return 0;
  state.pendingTxns = state.pendingTxns || [];
  let added = 0;
  for (const entry of items) {
    const p = quickAddToPending(entry);
    if (!p) continue;
    // The queue is drained-and-cleared natively, so a duplicate here means a
    // genuine double-tap rather than a re-read. Same 2-minute window the
    // bank capture uses.
    const dupe = state.pendingTxns.find((x) => x.providerId === "quick-add"
      && x.amount === p.amount && x.merchant === p.merchant
      && Math.abs(p.createdAt - x.createdAt) < 120000);
    if (dupe) continue;
    state.pendingTxns.push(p);
    added += 1;
  }
  if (!added) return 0;
  save();
  renderAll();
  toast(trn(added, "{n} quick entry to review", "{n} quick entries to review"));
  return added;
}

/* Bridge: the Android NotificationListenerPlugin calls this.
   Also exposed so you can test in the devtools console:
     duitfulIncoming({ package: "com.mbb.malaysia.android", text: "RM50.00 charged to card ending 1234 at STARBUCKS on 19-Apr-26" })
*/
// The rules: split settling, money in, money out. True when one queued.
function captureByRules(data) {
  if (captureTexts(data).some((t) => CAPTURE_DENY.test(t) || TXN_FAILED_DENY.test(t))) return false;
  // Credits first: a transfer landing is never also a card spend, and the
  // debit patterns would only ever mis-read it. A credit that settles a
  // split goes no further.
  if (queueIncomingTransfer(data)) return true;
  if (queueIncomingCredit(data)) return true;
  return queuePendingTxn(data);
}
window.duitfulIncoming = (data) => {
  try {
    if (captureByRules(data || {})) return true;
    // No bank pattern matched (banks reword their alerts): let ML Kit's
    // entity reader find the amount. Async, so this call reports false.
    queuePendingTxnFromEntities(data || {}).catch(() => {});
    return false;
  } catch (e) { console.warn("duitfulIncoming failed", e); return false; }
};

/* ---------- On-device AI, only where the rules are unsure ----------
   Same kit as the receipt second opinion (Gemini Nano via ML Kit's Prompt
   API, DuitfulKit.aiReadAlert; iOS has no capture). Run only from the drain,
   never in the background service. The AI labels; it never sets an amount:
   the amount is the one figure the alert prints, found by rule. It may
   say an unknown-format alert is a spend, income or a move, name the other
   side (only if that name is in the text) and pick a category from the
   app's list. Promo or security means drop. A confident rule always wins. */
const CAPTURE_AI_TIMEOUT_MS = 6000;
const CAPTURE_AI_MAX = 8;
// Exactly one supported-currency figure in the text, or null: the only amount
// an AI-labelled alert can ever carry.
function captureRuleAmount(text, defaultCurrency) {
  const set = new Set();
  for (const h of extractTxnAmounts(text, defaultCurrency || "MYR")) {
    if (h.amount > 0 && h.amount < 1e9) set.add(h.amount);
  }
  return set.size === 1 ? [...set][0] : null;
}
// Pure: the model's JSON → { direction, counterparty, category, promo }, or null.
function parseAiAlertReply(reply) {
  if (!reply || typeof reply !== "object") return null;
  let f = reply;
  if (typeof reply.json === "string") {
    const m = reply.json.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { f = JSON.parse(m[0]); } catch { return null; }
  }
  const dir = String(f.direction || "").toLowerCase();
  return {
    direction: ["spend", "income", "move", "ignore"].includes(dir) ? dir : "",
    counterparty: typeof f.counterparty === "string" ? f.counterparty.trim().slice(0, 60) : "",
    category: typeof f.category === "string" ? f.category.trim().slice(0, 40) : "",
    promo: f.is_promo_or_security === true || f.is_promo_or_security === "true",
  };
}
async function captureAiKit() {
  const kit = aiAllowed() ? duitfulKit("aiReadAlert") : null;
  if (!kit || typeof kit.aiStatus !== "function") return null;
  try {
    const st = await withTimeout(kit.aiStatus(), 2000);
    return st && st.available ? kit : null;
  } catch { return null; }
}
async function askAiAboutAlert(kit, text, categories) {
  try {
    return parseAiAlertReply(await withAiThinking(() => withTimeout(kit.aiReadAlert({ text: String(text).slice(0, 600), categories }), CAPTURE_AI_TIMEOUT_MS)));
  } catch { return null; }
}
// A name or category the model offers counts only if the alert says it /
// the app already has it.
function aiNameInText(name, text) {
  const n = String(name || "").trim();
  return n.length >= 2 && String(text || "").toLowerCase().includes(n.toLowerCase()) ? n : "";
}
function aiCategoryIn(cat, cats) {
  const c = String(cat || "").trim().toLowerCase();
  return (cats || []).find((x) => x.toLowerCase() === c) || "";
}
/* An alert the rules could not place: a listed app, no OTP / promo words, and
   exactly one currency figure. The AI decides direction; the rest is rule-made. */
function queueFromAi(data, ai, cats) {
  const pkg = String(data.package || "");
  const provider = providerForPackage(pkg);
  const text = captureTexts(data).slice(-1)[0];
  const amount = captureRuleAmount(text, provider && provider.currency);
  if (!provider || amount == null || !ai || ai.promo || !ai.direction || ai.direction === "ignore") return false;
  if (CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text) || isLikelyPromo(text)) return false;
  const now = captureTime(data);
  const who = aiNameInText(ai.counterparty, text);
  const base = { id: uid(), createdAt: now, raw: String(data.text || ""), pkg, amount, providerId: provider.id, providerName: provider.name, currency: provider.currency, ai: true };
  if (ai.direction === "income") {
    if (pendingCredits().some((p) => pendingSource(p) === provider.id && sameAmount(p.amount, amount) && Math.abs(now - p.createdAt) < 120000)) return false;
    queueCredit({ ...base, kind: "income", sender: who, label: creditLabel(text) });
    return true;
  }
  if (pendingSpends().some((p) => p.providerId === provider.id && sameAmount(p.amount, amount) && Math.abs(now - p.createdAt) < 120000)) return false;
  const spend = { ...base, merchant: who, country: provider.country, category: aiCategoryIn(ai.category, cats), transfer: ai.direction === "move" };
  if (ai.direction === "move") {
    // AI only supplies the direction; pairing stays rule-based. Unpaired, it
    // is shown as a move to confirm, with "It was a spend" to undo.
    state.pendingTxns = state.pendingTxns || [];
    const at = findPairPartner(spend, "income");
    if (at >= 0) state.pendingTxns[at] = makeMove(spend, state.pendingTxns[at], false);
    else state.pendingTxns.push(makeMove(spend, null, false));
    commitPending();
    return true;
  }
  queueDebit({ ...spend, transfer: false });
  return true;
}

/* Fallback for a notification from a known bank or wallet app whose wording
   none of the patterns above recognise. Narrow on purpose: the app must be on
   the whitelist, the text must say money went out and nothing about money
   coming in, and the entity reader must find exactly one amount (a "spent X,
   balance Y" alert is ambiguous, so it is skipped rather than guessed). Like
   every capture, it only queues a pending entry to confirm, with no shop
   name, since none was parsed. */
const ENTITY_DEBIT_WORDS = /\b(?:paid|spent|charged|debited|deducted|transferred|purchase|payment|transaction|dibayar|ditolak|pembelian|pembayaran|transaksi|didebet|dipotong|nagbayad|binayaran|gumastos)\b|(?:支付|付款|消[费費]|刷卡|扣款|扣除|ชำระ|จ่าย|หักบัญชี|ใช้จ่าย|thanh\s*toán|chi\s*tiêu|trừ\s*tiền|chuyển\s*tiền)/i;
const ENTITY_CREDIT_WORDS = /\b(?:received|credited|refund(?:ed)?|reversal|cashback|menerima|diterima|dikreditkan|nakatanggap|natanggap)\b|(?:收到|入[账賬]|退款|返[现現]|ได้รับ|เงินเข้า|คืนเงิน|nhận\s+(?:được|tiền)|hoàn\s*tiền)/i;
function entityDebitAmount(text, provider, money) {
  if (!provider || !text || isLikelyPromo(text) || CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text)) return null;
  if (!ENTITY_DEBIT_WORDS.test(text) || ENTITY_CREDIT_WORDS.test(text)) return null;
  const amounts = new Set();
  for (const m of money || []) {
    const cur = String((m && m.currency) || "").trim();
    if (cur && !/^(?:rm|myr|s\$|sgd|rp\.?|idr|฿|thb|₱|php|₫|vnd|đ|\$)$/i.test(cur)) continue;
    const digits = String((m && m.text) || "").replace(/[^\d.,]/g, "");
    const v = parseAmount(digits, provider.currency);
    if (Number.isFinite(v) && v > 0 && v < 1e9) amounts.add(Math.round(v * 100) / 100);
  }
  return amounts.size === 1 ? [...amounts][0] : null;
}
async function queuePendingTxnFromEntities(data) {
  const text = String(data.text || "");
  const provider = providerForPackage(String(data.package || ""));
  if (!provider || !aesKey) return false;
  if (!ENTITY_DEBIT_WORDS.test(text) || ENTITY_CREDIT_WORDS.test(text) || isLikelyPromo(text) || CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text)) return false;
  const kit = duitfulKit("extractEntities");
  if (!kit) return false;
  let res;
  try { res = await withTimeout(kit.extractEntities({ text }), 8000); } catch { return false; }
  const amount = entityDebitAmount(text, provider, res && res.money);
  if (amount == null) return false;
  const now = captureTime(data);
  state.pendingTxns = state.pendingTxns || [];
  if (state.pendingTxns.some((p) => p.providerId === provider.id && p.amount === amount && Math.abs(now - p.createdAt) < 120000)) return false;
  state.pendingTxns.push({
    id: uid(), createdAt: now, raw: text, pkg: String(data.package || ""),
    amount, merchant: "", providerId: provider.id, providerName: provider.name,
    country: provider.country, currency: provider.currency,
  });
  save();
  if (typeof renderAll === "function") renderAll();
  return true;
}
