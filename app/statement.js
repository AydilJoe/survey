/* Duitful — bank statement import (PDF), read on the phone.
 *
 * pdf.js (vendor/pdfjs, Apache-2.0, loaded only when a statement is picked)
 * turns the PDF into positioned text; the per-bank rules below turn that text
 * into rows; reconcileStatement() checks the rows add up to the balances the
 * statement prints. Nothing is uploaded, nothing is guessed: a row that
 * doesn't parse is left out and the check says so.
 *
 * Layouts supported (each learnt from a real statement, tested only with
 * synthetic ones — real statements never enter the repo):
 *   maybank-card   Maybank credit card ("STATEMENT OF CREDIT CARD ACCOUNT")
 *   pbb-card       Public Bank credit card ("CARD STATEMENT")
 *   alliance-card  Alliance Bank credit card (several accounts per statement)
 *   cimb-card      CIMB credit card transaction history (Clicks / OCTO PDF)
 *   generic        any statement with dated rows, amounts and a balance column
 *
 * Rows come out as { date: "YYYY-MM-DD", desc, payee, amount (> 0),
 * dir: "debit" | "credit", balance?, page }. On a card, debit = spending
 * (the balance owed goes up); on a bank account, debit = money out. */

const STMT_MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const STMT_PDFJS = "vendor/pdfjs/pdf.min.js?v=978fd1b2";
const STMT_PDFJS_WORKER = "vendor/pdfjs/pdf.worker.min.js?v=38cde531";

/* ---------- reading the PDF ---------- */

let _stmtPdfjs = null;
function stmtLoadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_stmtPdfjs) return _stmtPdfjs;
  _stmtPdfjs = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = STMT_PDFJS;
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) { reject(new Error("pdf.js did not load")); return; }
      lib.GlobalWorkerOptions.workerSrc = STMT_PDFJS_WORKER;
      resolve(lib);
    };
    s.onerror = () => { _stmtPdfjs = null; reject(new Error("pdf.js did not load")); };
    document.head.appendChild(s);
  });
  return _stmtPdfjs;
}

/* Text items → lines. Items on the same baseline (±2.5pt) form a line; the
   gaps between them become runs of spaces roughly in proportion to the
   distance, so columns stay apart ("desc     12.50") while words in a phrase
   keep single spaces. */
const STMT_COL = 3;
function stmtLinesFromItems(items, page) {
  const pts = items
    .filter((it) => it && typeof it.str === "string" && it.str.trim() !== "")
    .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: it.str }));
  return stmtLinesFromPoints(pts, page, 2.5);
}
/* Points {x, y (up), w, s} in A4 points → lines; tol is how far apart two
   baselines can be and still be one line. */
function stmtLinesFromPoints(points, page, tol) {
  const pts = points.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of pts) {
    let line = lines.length ? lines[lines.length - 1] : null;
    if (!line || Math.abs(line.y - p.y) > tol) { line = { y: p.y, items: [], page }; lines.push(line); }
    line.items.push(p);
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = "";
    let end = null;
    for (const it of line.items) {
      if (end != null) {
        const gap = it.x - end;
        const col = Math.round(it.x / STMT_COL);
        if (gap > 4 && text.length < col) text += " ".repeat(Math.max(2, col - text.length));
        else if (gap > 4) text += "  ";
        else if (gap > 0.8 && !/\s$/.test(text)) text += " ";
      } else {
        text = " ".repeat(Math.round(it.x / STMT_COL));
      }
      text += it.s;
      end = it.x + it.w;
    }
    line.text = text.replace(/\s+$/, "");
  }
  return lines;
}

/* Reads a PDF's text. Resolves { pages: [[line…]…], lines: [line…] } or
   throws an Error with .code: "password" (needs one), "wrong-password",
   "scanned" (no text layer), "unreadable". The password is used for this one
   open and never kept. */
async function readStatementPdf(data, password) {
  const lib = await stmtLoadPdfjs();
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(data.slice(0)), password: password || undefined, isEvalSupported: false, useSystemFonts: true }).promise;
  } catch (e) {
    const err = new Error("unreadable");
    if (e && e.name === "PasswordException") err.code = e.code === 2 ? "wrong-password" : "password";
    else err.code = "unreadable";
    throw err;
  }
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      pages.push(stmtLinesFromItems(tc.items, n));
    }
  } finally {
    try { doc.destroy(); } catch {}
  }
  const lines = pages.flat();
  if (!lines.length) { const err = new Error("scanned"); err.code = "scanned"; throw err; }
  return { pages, lines };
}

/* ---------- scanned statements: OCR on the phone ----------
   A PDF with no text layer, or photos of the pages, are read with the same
   on-device OCR as receipts (ML Kit in the phone shells, Tesseract
   otherwise). Each word's box becomes a point on an A4-wide page, so the
   lines come out spaced like a text PDF's and the same layout rules parse
   them. OCR misreads digits, so such a statement only imports when its
   figures add up (statementImportNow). Every picture is read in memory and
   dropped. */
const STMT_SCAN_MAX_PAGES = 12;
const STMT_SCAN_SCALE = 2.5;     // PDF points → pixels for OCR (~180 dpi)
const STMT_SCAN_MAX_SIDE = 2600; // photos are scaled down to this

/* OCR words ({text, x0, y0, x1, y1} or Tesseract's {text, bbox}) in image
   pixels → lines, as if the page were 595pt wide. */
function stmtLinesFromWords(words, page, width) {
  const k = 595 / (width > 0 ? width : 595);
  const pts = [];
  const hs = [];
  for (const w of words || []) {
    const s = w && String(w.text == null ? "" : w.text).trim();
    if (!s) continue;
    const b = w.bbox && typeof w.bbox === "object" ? w.bbox : w;
    const x0 = Number(b.x0), x1 = Number(b.x1), y0 = Number(b.y0), y1 = Number(b.y1);
    if (![x0, x1, y0, y1].every(Number.isFinite)) continue;
    pts.push({ x: x0 * k, y: -((y0 + y1) / 2) * k, w: Math.max(0, x1 - x0) * k, s });
    hs.push(Math.max(0, y1 - y0) * k);
  }
  if (!pts.length) return [];
  hs.sort((a, b) => a - b);
  return stmtLinesFromPoints(pts, page, Math.max(1.5, hs[hs.length >> 1] * 0.5));
}

/* One picture → its words. ML Kit first where the phone has it, Tesseract
   otherwise; the receipts' adapters turn either into word boxes. */
async function stmtOcrImage(canvas) {
  let words = null;
  // ML Kit on Android, Vision on iOS (same result shape); null on the web.
  const plugin = typeof nativeTextReader === "function" ? nativeTextReader() : null;
  if (plugin) {
    try {
      const b64 = mlkitBase64FromDataUrl(canvas.toDataURL("image/jpeg", 0.92));
      const res = b64 ? await plugin.detectText({ base64Image: b64, rotation: 0 }) : null;
      if (res) words = mlkitWordsFromResult(res);
    } catch { words = null; }
  }
  const tessOk = typeof tesseractAllowed !== "function" || tesseractAllowed();
  if ((!words || !words.length) && tessOk) {
    const worker = await getTesseractWorker(() => {});
    const res = await worker.recognize(canvas);
    words = collectOcrWords(res && res.data);
  }
  return { words: words || [], width: canvas.width };
}

async function stmtCanvasFromImage(src) {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image"));
      i.src = url;
    });
    const k = Math.min(1, STMT_SCAN_MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    if (typeof src !== "string") URL.revokeObjectURL(url);
  }
}

/* Pages one at a time: get the picture, read it, drop it. say(n, of) shows
   progress. Resolves { pages, lines, scanned: true } or throws "no-text". */
async function stmtReadScanPages(count, canvasFor, say) {
  const pages = [];
  for (let n = 1; n <= count; n++) {
    if (say) say(n, count);
    const canvas = await canvasFor(n);
    if (!canvas) continue;
    try {
      const { words, width } = await stmtOcrImage(canvas);
      pages.push(stmtLinesFromWords(words, n, width));
    } finally {
      canvas.width = 0; canvas.height = 0;       // the picture is not kept
    }
  }
  const lines = pages.flat();
  if (!lines.length) { const err = new Error("no-text"); err.code = "no-text"; throw err; }
  return { pages, lines, scanned: true };
}

/* A PDF with no text layer: render each page and read it. */
async function readStatementScanPdf(data, password, say) {
  const lib = await stmtLoadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(data.slice(0)), password: password || undefined, isEvalSupported: false, useSystemFonts: true }).promise;
  try {
    return await stmtReadScanPages(Math.min(doc.numPages, STMT_SCAN_MAX_PAGES), async (n) => {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: STMT_SCAN_SCALE });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      return c;
    }, say);
  } finally {
    try { doc.destroy(); } catch {}
  }
}

/* Photos of the pages (or the phone's document scanner), in order. */
function readStatementPhotos(sources, say) {
  const list = Array.from(sources || []).slice(0, STMT_SCAN_MAX_PAGES);
  return stmtReadScanPages(list.length, (n) => stmtCanvasFromImage(list[n - 1]), say);
}

/* ---------- small helpers ---------- */

function stmtMoney(s) {
  const v = Number(String(s || "").replace(/[,\s]/g, ""));
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}
const stmtRound = (n) => Math.round(n * 100) / 100;
function stmtIso(y, m, d) {
  if (!(y > 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// A row's year when the statement prints only day and month: the statement's
// year, or the one before for months after the statement month.
function stmtYearFor(month, stmt) {
  if (!stmt) return new Date().getFullYear();
  return month > stmt.m ? stmt.y - 1 : stmt.y;
}
function stmtYear2(yy) { const n = Number(yy); return n < 100 ? 2000 + n : n; }
function stmtClean(desc) { return String(desc || "").replace(/\s+/g, " ").trim(); }
// The payee: the description up to the first wide gap (where the location
// column starts), without trailing card-scheme markers.
function stmtPayee(desc) {
  const first = String(desc || "").trim().split(/\s{3,}/)[0] || "";
  return stmtClean(first).replace(/\s+\b(?:AP|EC)$/i, "").slice(0, 60);
}
function stmtFindStatementDate(lines) {
  const text = lines.map((l) => l.text).join("\n");
  const parseMatch = (m) => {
    if (!m) return null;
    const d = Number(m[1]);
    const mon = /^\d+$/.test(m[2]) ? Number(m[2]) : STMT_MONTHS[m[2].toUpperCase()];
    const y = stmtYear2(m[3]);
    if (!(d >= 1 && d <= 31 && mon >= 1 && mon <= 12 && y >= 2000 && y <= 2099)) return null;
    const iso = stmtIso(y, mon, d);
    return iso ? { y, m: mon, d, iso } : null;
  };
  // 1. After "STATEMENT DATE" / "TARIKH PENYATA" (allow up to 200 chars in case
  //    a multi-column PDF interleaves customer name/address between label and date).
  //    Numeric months require "/" or "-" (never bare spaces) so random numbers
  //    don't match as dates.
  const labelRe = /(?:statement\s+date|tarikh\s+penyata)[\s\S]{0,200}?(?:\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b|\b(\d{1,2})[\s/-](JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[\s/-](\d{2,4})\b)/i;
  let m = labelRe.exec(text);
  if (m) {
    const res = parseMatch(m[1] ? [m[0], m[1], m[2], m[3]] : [m[0], m[4], m[5], m[6]]);
    if (res) return res;
  }
  // 2. Named-month date anywhere in the header (e.g. "31 OCT 2026").
  m = /\b(\d{1,2}) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) (\d{2,4})\b/i.exec(text);
  if (m) {
    const res = parseMatch(m);
    if (res) return res;
  }
  // 3. Fallback: DD/MM/YY(YY) in the top header lines (before transaction table),
  //    e.g. Maybank Islamic where "31/10/26" sits above "STATEMENT DATE".
  const headerLines = [];
  for (const l of lines.slice(0, 30)) {
    const t = String(l.text || "");
    if (/URUSNIAGA\s+AKAUN|ACCOUNT\s+TRANSACTIONS|BEGINNING\s+BALANCE/i.test(t)) break;
    headerLines.push(t);
  }
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(headerLines.join("\n"));
  return parseMatch(m);
}
const STMT_AMT = "([\\d,]+\\.\\d{2})";

/* ---------- per-bank layouts ---------- */

const STATEMENT_LAYOUTS = [
  {
    id: "maybank-card", bank: "Maybank", kind: "card",
    detect: (t) => /STATEMENT OF CREDIT CARD ACCOUNT/i.test(t) && /Malayan Banking Berhad|maybank\.com\.my|TreatsPoints/i.test(t),
    parse(lines) {
      const stmt = stmtFindStatementDate(lines);
      const rows = [];
      const sections = [];
      let cur = null;
      for (const l of lines) {
        let m;
        if ((m = new RegExp(`YOUR PREVIOUS STATEMENT BALANCE\\s+${STMT_AMT}(CR)?`, "i").exec(l.text))) {
          cur = { opening: stmtMoney(m[1]) * (m[2] ? -1 : 1), rows: [], page: l.page };
          sections.push(cur);
          continue;
        }
        if ((m = new RegExp(`SUB TOTAL\\s*/\\s*JUMLAH\\s+${STMT_AMT}(CR)?`, "i").exec(l.text)) && cur && cur.closing == null) {
          cur.closing = stmtMoney(m[1]) * (m[2] ? -1 : 1);
          continue;
        }
        if ((m = new RegExp(`TOTAL CREDIT THIS MONTH\\s+${STMT_AMT}`, "i").exec(l.text)) && cur) { cur.totalCredit = stmtMoney(m[1]); continue; }
        if ((m = new RegExp(`TOTAL DEBIT THIS MONTH\\s+${STMT_AMT}`, "i").exec(l.text)) && cur) { cur.totalDebit = stmtMoney(m[1]); continue; }
        m = new RegExp(`^\\s*(\\d{2})/(\\d{2})\\s+(\\d{2})/(\\d{2})\\s+(.+?)\\s+${STMT_AMT}(CR)?\\s*$`).exec(l.text);
        if (m && cur) {
          const d = Number(m[3]), mo = Number(m[4]);
          const row = { date: stmtIso(stmtYearFor(mo, stmt), mo, d), desc: stmtClean(m[5]), payee: stmtPayee(m[5]), amount: stmtMoney(m[6]), dir: m[7] ? "credit" : "debit", page: l.page };
          rows.push(row); cur.rows.push(row);
        }
      }
      return { stmt, rows, sections };
    },
  },
  {
    id: "pbb-card", bank: "Public Bank", kind: "card",
    detect: (t) => /PUBLIC BANK BERHAD/i.test(t) && /CARD STATEMENT/i.test(t),
    parse(lines) {
      const stmt = stmtFindStatementDate(lines);
      const rows = [];
      const sections = [];
      let cur = null;
      let last = null;
      const mon = (s) => STMT_MONTHS[String(s).toUpperCase()];
      for (const l of lines) {
        let m;
        if ((m = new RegExp(`^\\s*\\d{2} [A-Z]{3}\\s+Previous Balance\\s+${STMT_AMT}(CR)?`, "i").exec(l.text))) {
          cur = { opening: stmtMoney(m[1]) * (m[2] ? -1 : 1), rows: [], page: l.page };
          sections.push(cur); last = null;
          continue;
        }
        if (!cur) continue;
        if ((m = new RegExp(`This month total credit\\s+${STMT_AMT}`, "i").exec(l.text))) { cur.totalCredit = stmtMoney(m[1]); last = null; continue; }
        if ((m = new RegExp(`This month total debit\\s+${STMT_AMT}`, "i").exec(l.text))) { cur.totalDebit = stmtMoney(m[1]); last = null; continue; }
        if ((m = new RegExp(`Grand total for this account\\s+${STMT_AMT}(CR)?`, "i").exec(l.text))) { cur.closing = stmtMoney(m[1]) * (m[2] ? -1 : 1); cur = null; last = null; continue; }
        // Posting date, transaction date, description, amount.
        m = new RegExp(`^\\s*(\\d{2}) ([A-Z]{3})\\s+(\\d{2}) ([A-Z]{3})\\s+(.+?)\\s+${STMT_AMT}(CR)?\\s*$`).exec(l.text);
        // Or a posting date only (charges, interest).
        const m2 = m ? null : new RegExp(`^\\s*(\\d{2}) ([A-Z]{3})\\s{2,}(.+?)\\s+${STMT_AMT}(CR)?\\s*$`).exec(l.text);
        if (m || m2) {
          const dd = m ? Number(m[3]) : Number(m2[1]);
          const mo = m ? mon(m[4]) : mon(m2[2]);
          if (!mo) continue;
          const desc = m ? m[5] : m2[3];
          const row = { date: stmtIso(stmtYearFor(mo, stmt), mo, dd), desc: stmtClean(desc), payee: stmtPayee(desc), amount: stmtMoney(m ? m[6] : m2[4]), dir: (m ? m[7] : m2[5]) ? "credit" : "debit", page: l.page };
          rows.push(row); cur.rows.push(row); last = row;
          continue;
        }
        // A wrapped second line of the description (indented, no amount).
        if (last && /^\s{20,}\S/.test(l.text) && !new RegExp(`${STMT_AMT}(CR)?\\s*$`).test(l.text)) {
          last.desc = stmtClean(`${last.desc} ${l.text}`);
        }
      }
      return { stmt, rows, sections };
    },
  },
  {
    id: "alliance-card", bank: "Alliance Bank", kind: "card",
    detect: (t) => /alliance ?bank/i.test(t) && /PREVIOUS STATEMENT BALANCE/i.test(t),
    parse(lines) {
      const stmt = stmtFindStatementDate(lines);
      const rows = [];
      const sections = [];
      let cur = null;
      let closing = null;
      let inTable = false;
      // The dates and the description of one row can sit a few points apart,
      // so they arrive as two lines in either order: hold the dates (and an
      // amount if it came with them) until the description line.
      let held = null;
      const DATES = /^\s*(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\/(\d{2})/;
      const push = (d, desc, amt, cr, page) => {
        const row = { date: stmtIso(stmtYear2(d[3]), Number(d[2]), Number(d[1])), desc: stmtClean(desc), payee: stmtPayee(desc), amount: stmtMoney(amt), dir: cr ? "credit" : "debit", page };
        rows.push(row); cur.rows.push(row);
      };
      for (const l of lines) {
        let m;
        if (/Transaction Description/i.test(l.text) && /Amount/i.test(l.text)) { inTable = true; continue; }
        if (!inTable) continue;
        if ((m = new RegExp(`PREVIOUS STATEMENT BALANCE\\s+${STMT_AMT}\\s?(CR)?`, "i").exec(l.text))) {
          cur = { opening: stmtMoney(m[1]) * (m[2] ? -1 : 1), rows: [], page: l.page };
          sections.push(cur);
          continue;
        }
        if ((m = /CURRENT BALANCE\s+(-?[\d,]+\.\d{2})\s?(CR)?/i.exec(l.text))) { closing = stmtMoney(m[1]) * (m[2] ? -1 : 1); inTable = false; continue; }
        if (!cur) continue;
        m = new RegExp(`^\\s*(\\d{2})/(\\d{2})/(\\d{2})\\s+(\\d{2})/(\\d{2})/(\\d{2})\\s+(.+?)\\s+${STMT_AMT}\\s?(CR)?\\s*$`).exec(l.text);
        if (m) { held = null; push(m, m[7], m[8], m[9], l.page); continue; }
        const dOnly = DATES.exec(l.text);
        if (dOnly) {
          const rest = l.text.slice(dOnly[0].length);
          const a = new RegExp(`^\\s*${STMT_AMT}\\s?(CR)?\\s*$`).exec(rest);
          held = { d: dOnly, amt: a ? a[1] : null, cr: a ? a[2] : null, page: l.page };
          continue;
        }
        if (held) {
          const a = new RegExp(`^(.*?)\\s+${STMT_AMT}\\s?(CR)?\\s*$`).exec(l.text);
          if (held.amt && !a) { push(held.d, l.text, held.amt, held.cr, held.page); held = null; continue; }
          if (!held.amt && a) { push(held.d, a[1], a[2], a[3], held.page); held = null; continue; }
          held = null;
        }
        // Undated charges (interest) dated on the statement date. Labels
        // with a colon ("CHARGES THIS MONTH: …", card headers) are not rows.
        m = new RegExp(`^\\s{10,}([A-Z][A-Z0-9 .,&'/@%()-]+?)\\s{2,}${STMT_AMT}\\s?(CR)?\\s*$`).exec(l.text);
        if (m && !/:|MINIMUM PAYMENT|CURRENT BALANCE|PREVIOUS STATEMENT/i.test(m[1])) {
          const row = { date: stmt ? stmt.iso : "", desc: stmtClean(m[1]), payee: stmtPayee(m[1]), amount: stmtMoney(m[2]), dir: m[3] ? "credit" : "debit", page: l.page };
          rows.push(row); cur.rows.push(row);
        }
      }
      // One printed closing for the whole statement: check the sum of all accounts.
      const merged = sections.length ? [{ opening: stmtRound(sections.reduce((a, s) => a + s.opening, 0)), rows, closing, page: sections[0].page }] : [];
      return { stmt, rows, sections: merged };
    },
  },
  {
    id: "cimb-card", bank: "CIMB", kind: "card",
    detect: (t) => /Account Details and Transaction History/i.test(t) && /Transaction Details/i.test(t),
    parse(lines) {
      // Columns from the header line; rows are blocks of lines around one
      // "dd Mon yyyy  dd Mon yyyy" line, separated by wide vertical gaps.
      let creditX = null, debitX = null;
      const rows = [];
      let blocks = [];
      let block = null;
      let prevY = null, prevPage = null;
      for (const l of lines) {
        const hd = l.items.find((i) => /^Debit$/i.test(i.s.trim()));
        const hc = l.items.find((i) => /^Credit$/i.test(i.s.trim()));
        if (hd && hc && /Transaction Details/i.test(l.text)) { debitX = hd.x; creditX = hc.x; block = null; prevY = null; continue; }
        if (creditX == null) continue;
        const gap = prevY == null || prevPage !== l.page ? Infinity : prevY - l.y;
        if (!block || gap > 18) { block = []; blocks.push(block); }
        block.push(l);
        prevY = l.y; prevPage = l.page;
      }
      const dateRe = /(\d{2}) ([A-Za-z]{3}) (\d{4})\s+(\d{2}) ([A-Za-z]{3}) (\d{4})/;
      for (const b of blocks) {
        const dl = b.find((l) => dateRe.test(l.text));
        if (!dl) continue;
        const dm = dateRe.exec(dl.text);
        const mo = STMT_MONTHS[dm[5].toUpperCase()];
        // The amount: "MYR 1,234. 56", whichever column it sits in.
        let amount = NaN, x = null;
        for (const l of b) {
          const am = /MYR\s*([\d,]+)\.\s*(\d{2})/.exec(l.text);
          if (!am) continue;
          amount = stmtMoney(`${am[1]}.${am[2]}`);
          const it = l.items.find((i) => /MYR/.test(i.s)) || l.items.find((i) => /\d/.test(i.s) && i.x > 200);
          x = it ? it.x : null;
          break;
        }
        if (!(amount > 0) || !mo) continue;
        // Description: text in the details column, minus dates, amounts and labels.
        const desc = stmtClean(b.map((l) => l.items
          .filter((i) => i.x > 60 && i.x < debitX - 20 && !/^\d{2} [A-Za-z]{3} \d{4}$/.test(i.s.trim()) && !/MYR/.test(i.s))
          .map((i) => i.s).join(" "))
          .join(" ")
          .replace(dateRe, "")
          .replace(/\bPayment Desc\b/gi, ""));
        rows.push({ date: stmtIso(Number(dm[6]), mo, Number(dm[4])), desc, payee: stmtPayee(desc), amount, dir: "", x, page: dl.page });
      }
      // Debit or credit by column. The header gives the columns on its page;
      // later pages print no header and may sit at other offsets, so there
      // the amounts are split into a left (debit) and a right (credit) group.
      const headerPage = lines.find((l) => l.items.some((i) => /^Credit$/i.test(i.s.trim())))?.page;
      const byPage = new Map();
      for (const r of rows) { if (!byPage.has(r.page)) byPage.set(r.page, []); byPage.get(r.page).push(r); }
      for (const [pg, list] of byPage) {
        if (pg === headerPage) {
          for (const r of list) r.dir = r.x != null && Math.abs(r.x - creditX) < Math.abs(r.x - debitX) ? "credit" : "debit";
          continue;
        }
        const xs = list.map((r) => r.x).filter((v) => v != null);
        const lo = Math.min(...xs), hi = Math.max(...xs);
        for (const r of list) {
          if (hi - lo > 30 && r.x != null) r.dir = r.x - lo > (hi - lo) / 2 ? "credit" : "debit";
          else r.dir = STMT_CARD_PAYMENT.test(r.desc) || STMT_REBATE.test(r.desc) ? "credit" : "debit";
        }
      }
      for (const r of rows) delete r.x;
      // A transaction history prints no opening or closing balance.
      return { stmt: null, rows, sections: [] };
    },
  },
  // Maybank & Maybank Islamic Current / Savings / Mudharabah account statements
  // (e.g. M2U CA / Premier Mudharabah / Savings-i): DD/MM entry date (year from
  // TARIKH PENYATA / STATEMENT DATE), trailing +/- amounts including ".01+",
  // overdrawn balances marked "DR", and indented multi-line payee descriptions.
  {
    id: "maybank-account", bank: "Maybank", kind: "account",
    detect: (t) => /(?:URUSNIAGA\s+AKAUN|ACCOUNT\s+TRANSACTIONS)/i.test(t)
      && /Maybank|MUDHARABAH|M2U|Malayan\s+Banking/i.test(t)
      && !/STATEMENT OF CREDIT CARD ACCOUNT/i.test(t),
    parse(lines) {
      const stmt = stmtFindStatementDate(lines);
      const rows = [];
      let opening = null, closing = null, totalDebit = null, totalCredit = null;
      const AMT = "((?:[\\d,]+)?\\.\\d{2})\\s?(CR|DR|-|\\+)?";
      const rowRe = new RegExp(`^\\s*(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?(?:\\s+\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)?\\s+(.+?)\\s+${AMT}\\s+${AMT}\\s*$`, "i");
      const balRe = new RegExp(`${AMT}\\s*$`, "i");
      const stopRe = /^(?:BAKI\s+LEGAR|LEDGER\s+BALANCE|ENDING\s+BALANCE|TOTAL\s+DEBIT|TOTAL\s+CREDIT|PROFIT\s+OUTSTANDING|PERHATIAN|MUKA|PAGE|TARIKH\s+PENYATA|STATEMENT\s+DATE|NOMBOR\s+AKAUN|NOT\s+PROTECTED|URUSNIAGA\s+AKAUN|TARIKH\s+MASUK|ENTRY\s+DATE|FCN\b|EXCHANGE\s+YOUR|PLEASE\s+BE\s+REMINDED|CREDIT\s+TO\s+MULTIPLE|NOT\s+A\s+M2U|KINI,\s+ANDA|WANG\s+YANG\s+KELUAR|OVERDRAWN\s+BALANCES|Maybank\s+Islamic)/i;
      const signedBal = (numStr, mk) => {
        const v = stmtMoney(numStr);
        if (!Number.isFinite(v)) return null;
        return /^(?:DR|-)$/i.test(mk || "") ? -Math.abs(v) : v;
      };
      const GENERIC_HEAD = /^(?:TRANSFER\s+(?:FR|TO)\s+A\/C|PAYMENT\s+FR\s+A\/C|DUITNOW\s+PAYMENT|DEBIT\s+ACCOUNT(?:\s*-\s*SI)?|ESI\s+PAYMENT\s+DEBIT|AUTODEBIT|PAYMENT\s+CREDIT\s*-?\s*APS\/OTHERS|CMS\s*-\s*CR\s+PYMT\s+MARS)$/i;
      let cur = null;
      for (const l of lines) {
        const txt = String(l.text || "").trim();
        if (!txt) continue;
        if (/^BEGINNING\s+BALANCE\b/i.test(txt)) {
          const a = balRe.exec(txt);
          if (a && opening == null) opening = signedBal(a[1], a[2]);
          cur = null;
          continue;
        }
        if (/^ENDING\s+BALANCE\b/i.test(txt)) {
          const a = balRe.exec(txt);
          if (a) closing = signedBal(a[1], a[2]);
          cur = null;
          continue;
        }
        if (/^TOTAL\s+DEBIT\b/i.test(txt)) {
          const a = balRe.exec(txt);
          if (a) totalDebit = Math.abs(stmtMoney(a[1]));
          cur = null;
          continue;
        }
        if (/^TOTAL\s+CREDIT\b/i.test(txt)) {
          const a = balRe.exec(txt);
          if (a) totalCredit = Math.abs(stmtMoney(a[1]));
          cur = null;
          continue;
        }
        const m = rowRe.exec(txt);
        if (m) {
          const d = Number(m[1]), mo = Number(m[2]);
          const y = m[3] ? stmtYear2(m[3]) : stmtYearFor(mo, stmt);
          const date = stmtIso(y, mo, d);
          if (!date) continue;
          const head = stmtClean(m[4]);
          const amt = Math.abs(stmtMoney(m[5]));
          const mk1 = (m[6] || "").toUpperCase();
          const bal = signedBal(m[7], m[8]);
          const dir = mk1 === "+" || mk1 === "CR" ? "credit" : mk1 === "-" || mk1 === "DR" ? "debit" : "";
          cur = { date, desc: head, payee: stmtPayee(head), amount: amt, dir, balance: bal, page: l.page, _head: head, _sub: [] };
          rows.push(cur);
          continue;
        }
        if (stopRe.test(txt)) { cur = null; continue; }
        // Continuation lines right under a Maybank row (e.g. merchant/person name).
        if (cur && cur.page === l.page && cur._sub.length < 3 && !balRe.test(txt)) {
          const cleaned = txt.replace(/\*+$/, "").trim();
          if (cleaned && !/^\d{2}$/.test(cleaned)) cur._sub.push(cleaned);
        }
      }
      // Build cleaner payee & description from continuation lines, and infer any missing dir.
      let prev = opening;
      for (const r of rows) {
        if (r._sub.length) {
          r.desc = stmtClean([r._head, ...r._sub].join(" · "));
          if (GENERIC_HEAD.test(r._head)) {
            const nice = r._sub.find((s) => /[A-Za-z]{3,}/.test(s) && !/^(?:XXXX|MBBQR|QR\d|DUITNOW|QR PAY|\d{6,})/i.test(s)) || r._sub[0];
            if (nice) r.payee = stmtClean(nice).slice(0, 60);
          }
        }
        delete r._head;
        delete r._sub;
        if (!r.dir && r.balance != null && prev != null) r.dir = r.balance >= prev ? "credit" : "debit";
        if (!r.dir) r.dir = "debit";
        if (r.balance != null) prev = r.balance;
      }
      const sec = opening != null ? [{
        opening, closing, rows, page: rows[0] ? rows[0].page : 1,
        ...(totalDebit != null ? { totalDebit } : {}),
        ...(totalCredit != null ? { totalCredit } : {}),
      }] : [];
      return { stmt, rows, sections: sec };
    },
  },
];

/* Any other statement: dated rows ending in one or two amounts (amount and
   balance), DR/CR markers or signed amounts, opening/closing balance labels.
   Direction comes from the marker, the sign, or the balance moving. */
function parseGenericStatement(lines) {
  const stmt = stmtFindStatementDate(lines);
  const rows = [];
  let opening = null, closing = null;
  const DATE = "(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?|(\\d{1,2}) ([A-Za-z]{3})(?: (\\d{2,4}))?";
  const AMT = "(-?(?:[\\d,]+)?\\.\\d{2})\\s?(CR|DR|-|\\+)?";
  const rowRe = new RegExp(`^\\s*(?:${DATE})\\s+(.+?)\\s+${AMT}(?:\\s+${AMT})?\\s*$`, "i");
  const signedBal = (numStr, mk) => {
    const v = stmtMoney(numStr);
    if (!Number.isFinite(v)) return null;
    return /^(?:DR|-)$/i.test(mk || "") ? -Math.abs(v) : v;
  };
  for (const l of lines) {
    let m;
    if ((m = new RegExp(`(?:opening|beginning|previous)\\s+balance|balance\\s+b/?f|baki\\s+(?:awal|dibawa|legar)`, "i").exec(l.text))) {
      const a = new RegExp(`${AMT}\\s*$`, "i").exec(l.text);
      if (a && opening == null) opening = signedBal(a[1], a[2]);
      continue;
    }
    if ((m = /(?:closing|ending)\s+balance|balance\s+c\/?f|baki\s+akhir/i.exec(l.text))) {
      const a = new RegExp(`${AMT}\\s*$`, "i").exec(l.text);
      if (a) closing = signedBal(a[1], a[2]);
      continue;
    }
    m = rowRe.exec(l.text);
    if (!m) continue;
    let y, mo, d;
    if (m[1]) { d = Number(m[1]); mo = Number(m[2]); y = m[3] ? stmtYear2(m[3]) : stmtYearFor(mo, stmt); }
    else { d = Number(m[4]); mo = STMT_MONTHS[String(m[5]).toUpperCase()]; y = m[6] ? stmtYear2(m[6]) : stmtYearFor(mo, stmt); }
    if (!mo) continue;
    const desc = m[7];
    const a1 = stmtMoney(m[8]), mk1 = (m[9] || "").toUpperCase();
    const hasBal = m[10] != null;
    const bal = hasBal ? signedBal(m[10], m[11]) : null;
    let dir = mk1 === "CR" || mk1 === "+" ? "credit" : mk1 === "DR" || mk1 === "-" || a1 < 0 ? "debit" : "";
    rows.push({ date: stmtIso(y, mo, d), desc: stmtClean(desc), payee: stmtPayee(desc), amount: Math.abs(a1), dir, balance: bal, page: l.page });
  }
  // Direction from the balance where no marker said it.
  let prev = opening;
  for (const r of rows) {
    if (!r.dir && r.balance != null && prev != null) r.dir = r.balance >= prev ? "credit" : "debit";
    if (r.balance != null) prev = r.balance;
  }
  for (const r of rows) if (!r.dir) r.dir = "debit";
  const kind = rows.some((r) => r.balance != null) ? "account" : "card";
  return { stmt, rows, sections: opening != null ? [{ opening, closing, rows, page: rows[0] ? rows[0].page : 1 }] : [], kind };
}

/* Header-only bank / e-wallet detection for generic statements & first-time
   wallet matching. Specific sub-brands sit before broader names so "Boost Bank"
   never collapses into "Boost" e-wallet. Never stores account numbers or PII. */
const STMT_BANK_DETECTORS = [
  { bank: "Boost Bank",         provider: "boostbank",    providers: ["boostbank"],              re: /\bboost\s+bank\b/i,                                                   aliases: /\bboost\s+bank\b/i },
  { bank: "Maybank",            provider: "maybank",      providers: ["maybank", "maybank-mae"], re: /\b(?:maybank|malayan\s+banking|maybank2u|m2u|mae\s+by\s+maybank)\b/i, aliases: /\b(?:maybank|mbb|m2u|mae)\b/i },
  { bank: "CIMB",               provider: "cimb",         providers: ["cimb"],                   re: /\b(?:cimb\s+bank|cimb\s+islamic|cimb\s+clicks|cimb\s+octo|cimb)\b/i,  aliases: /\b(?:cimb|octo)\b/i },
  { bank: "Public Bank",        provider: "publicbank",   providers: ["publicbank"],             re: /\b(?:public\s+bank|public\s+islamic\s+bank|pb\s+engage|pbe\s+bank)\b/i, aliases: /\b(?:public\s+bank|pbb|pb\s+card|pbe)\b/i },
  { bank: "Alliance Bank",      provider: "alliance",     providers: ["alliance"],               re: /\b(?:alliance\s+bank|alliance\s+islamic)\b/i,                         aliases: /\balliance\b/i },
  { bank: "Hong Leong",         provider: "hlb",          providers: ["hlb"],                    re: /\b(?:hong\s+leong|hlb\s+connect)\b/i,                                 aliases: /\b(?:hong\s+leong|hlb)\b/i },
  { bank: "RHB",                provider: "rhb",          providers: ["rhb"],                    re: /\b(?:rhb\s+bank|rhb\s+islamic|rhb\s+banking|rhb\s+now)\b/i,           aliases: /\brhb\b/i },
  { bank: "AmBank",             provider: "ambank",       providers: ["ambank"],                 re: /\b(?:ambank|amislamic|amonline)\b/i,                                  aliases: /\b(?:ambank|amislamic)\b/i },
  { bank: "Bank Islam",         provider: "bankislam",    providers: ["bankislam"],              re: /\bbank\s+islam\b/i,                                                   aliases: /\b(?:bank\s+islam|bimb)\b/i },
  { bank: "BSN",                provider: "bsn",          providers: ["bsn"],                    re: /\b(?:bank\s+simpanan\s+nasional|mybsn|bsn\s+malaysia)\b/i,            aliases: /\b(?:bsn|mybsn)\b/i },
  { bank: "Affin",              provider: "affin",        providers: ["affin"],                  re: /\b(?:affin\s+bank|affin\s+islamic|affin\s+hwang)\b/i,                 aliases: /\baffin\b/i },
  { bank: "Bank Rakyat",        provider: "bankrakyat",   providers: ["bankrakyat"],             re: /\b(?:bank\s+rakyat|irakyat)\b/i,                                      aliases: /\b(?:bank\s+rakyat|irakyat)\b/i },
  { bank: "Bank Muamalat",      provider: "muamalat",     providers: ["muamalat"],               re: /\bbank\s+muamalat\b/i,                                                aliases: /\bmuamalat\b/i },
  { bank: "Agrobank",           provider: "agrobank",     providers: ["agrobank"],               re: /\bagrobank\b/i,                                                       aliases: /\bagrobank\b/i },
  { bank: "MBSB Bank",          provider: "mbsb",         providers: ["mbsb"],                   re: /\bmbsb\s+bank\b/i,                                                    aliases: /\bmbsb\b/i },
  { bank: "GXBank",             provider: "gxbank",       providers: ["gxbank"],                 re: /\b(?:gxbank|gx\s+bank)\b/i,                                           aliases: /\b(?:gxbank|gx\s+bank|gx)\b/i },
  { bank: "AEON Bank",          provider: "aeonbank",     providers: ["aeonbank"],               re: /\baeon\s+bank\b/i,                                                    aliases: /\baeon\s+bank\b/i },
  { bank: "Ryt Bank",           provider: "rytbank",      providers: ["rytbank"],                re: /\bryt\s+bank\b/i,                                                     aliases: /\bryt\b/i },
  { bank: "HSBC",               provider: "hsbc-my",      providers: ["hsbc-my", "hsbc"],        re: /\b(?:hsbc\s+bank|hsbc\s+amanah|hsbc\s+malaysia|hsbc\s+singapore|hsbc\s+hong\s+kong)\b/i, aliases: /\bhsbc\b/i },
  { bank: "OCBC",               provider: "ocbc-my",      providers: ["ocbc-my", "ocbc-sg", "ocbc"], re: /\b(?:ocbc\s+bank|ocbc\s+al-?amin|ocbc\s+malaysia|ocbc\s+singapore)\b/i, aliases: /\bocbc\b/i },
  { bank: "UOB",                provider: "uob-my",       providers: ["uob-my", "uob-sg", "uob"], re: /\b(?:united\s+overseas\s+bank|uob\s+malaysia|uob\s+singapore|uob\s+tmrw|uob\s+mighty)\b/i, aliases: /\buob\b/i },
  { bank: "Standard Chartered", provider: "scb-my",       providers: ["scb-my", "scb"],          re: /\bstandard\s+chartered\b/i,                                           aliases: /\b(?:standard\s+chartered|scb)\b/i },
  { bank: "TNG eWallet",        provider: "tng",          providers: ["tng"],        walletKind: "ewallet", re: /\b(?:touch\s*'?n\s*go\s+e-?wallet|tng\s+digital|tng\s+e-?wallet)\b/i, aliases: /\b(?:touch\s*'?n\s*go|tng)\b/i },
  { bank: "GrabPay",            provider: "grabpay",      providers: ["grabpay"],    walletKind: "ewallet", re: /\b(?:grabpay|grabfin)\b/i,                                           aliases: /\bgrabpay\b/i },
  { bank: "BigPay",             provider: "bigpay",       providers: ["bigpay"],     walletKind: "ewallet", re: /\bbigpay\b/i,                                                        aliases: /\bbigpay\b/i },
  { bank: "Boost",              provider: "boost",        providers: ["boost"],      walletKind: "ewallet", re: /\b(?:boost\s+e-?wallet|axiata\s+digital)\b/i,                        aliases: /\bboost\b/i },
  { bank: "ShopeePay",          provider: "shopeepay-my", providers: ["shopeepay-my", "shopeepay"], walletKind: "ewallet", re: /\bshopeepay\b/i,                                      aliases: /\bshopeepay\b/i },
  { bank: "Setel",              provider: "setel",        providers: ["setel"],      walletKind: "ewallet", re: /\b(?:setel\s+wallet|setel\s+statement)\b/i,                          aliases: /\bsetel\b/i },
  { bank: "Wise",               provider: "wise",         providers: ["wise"],       walletKind: "ewallet", re: /\b(?:wise\s+payments|wise\s+malaysia|wise\s+asia|transferwise)\b/i,  aliases: /\b(?:wise|transferwise)\b/i },
  { bank: "DBS",                provider: "dbs-sg",       providers: ["dbs-sg", "dbs"],          re: /\b(?:dbs\s+bank|posb\s+bank|dbs\s+digibank)\b/i,                      aliases: /\b(?:dbs|posb)\b/i },
  { bank: "Hang Seng",          provider: "hangseng",     providers: ["hangseng"],               re: /\bhang\s+seng\s+bank\b/i,                                             aliases: /\bhang\s+seng\b/i },
  { bank: "Citibank",           provider: "citi",         providers: ["citi"],                   re: /\bcitibank\b/i,                                                       aliases: /\b(?:citibank|citi)\b/i },
];

const STMT_HEADER_KW_RE = /\b(visa|mastercard|master|amex|american\s+express|islamic|ikhwan|mae|octo|platinum|signature|world|gold|savings|simpanan|current|semasa|mudharabah|ewallet|e-wallet)\b/gi;

function stmtHeaderText(lines) {
  if (!Array.isArray(lines)) return String(lines || "").slice(0, 2400);
  const head = [];
  let chars = 0;
  const txnStartRe = /^(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\s+\d{2,4})?)\s+\S/i;
  for (let i = 0; i < lines.length && i < 35 && chars < 2400; i++) {
    const t = String((lines[i] && lines[i].text) || "").trim();
    if (!t) continue;
    // Stop before the first dated transaction row so payees ("Transfer to Maybank") never match as the issuer.
    if (head.length && txnStartRe.test(t) && /\d+\.\d{2}/.test(t)) break;
    head.push(t);
    chars += t.length + 1;
  }
  return head.join("\n");
}

function stmtDetectBank(linesOrText, forcedBank) {
  if (forcedBank) {
    const byName = STMT_BANK_DETECTORS.find((d) => d.bank.toLowerCase() === String(forcedBank).toLowerCase());
    if (byName) return byName;
  }
  const head = stmtHeaderText(linesOrText);
  if (!head) return null;
  return STMT_BANK_DETECTORS.find((d) => d.re.test(head)) || null;
}

function stmtExtractHeaderKeywords(linesOrText) {
  const head = stmtHeaderText(linesOrText);
  if (!head) return [];
  const found = new Set();
  let m;
  STMT_HEADER_KW_RE.lastIndex = 0;
  while ((m = STMT_HEADER_KW_RE.exec(head)) !== null) {
    let k = m[1].toLowerCase().replace(/\s+/g, " ");
    if (k === "american express") k = "amex";
    else if (k === "master") k = "mastercard";
    else if (k === "simpanan") k = "savings";
    else if (k === "semasa") k = "current";
    else if (k === "e-wallet") k = "ewallet";
    found.add(k);
  }
  return [...found];
}

/* Text → { layout, bank, kind, stmt, rows, sections, provider?, walletKind?, headerKeywords? }. */
function parseStatement(read) {
  const text = read.lines.map((l) => l.text).join("\n");
  const layout = STATEMENT_LAYOUTS.find((L) => L.detect(text));
  const scanned = !!read.scanned;
  const headerKeywords = stmtExtractHeaderKeywords(read.lines);
  if (layout) {
    const out = layout.parse(read.lines);
    const meta = stmtDetectBank(read.lines, layout.bank);
    return {
      layout: layout.id, bank: layout.bank, kind: layout.kind,
      provider: meta ? meta.provider : "", walletKind: meta ? (meta.walletKind || "") : "",
      headerKeywords, ...out, scanned,
    };
  }
  const out = parseGenericStatement(read.lines);
  const meta = stmtDetectBank(read.lines);
  const head = stmtHeaderText(read.lines);
  let kind = out.kind;
  if (meta && meta.walletKind === "ewallet") kind = "account";
  else if (!out.rows.some((r) => r.balance != null) && /\b(?:credit\s+card|card\s+statement)\b/i.test(head)) kind = "card";
  return {
    layout: "generic", bank: meta ? meta.bank : "",
    provider: meta ? meta.provider : "", walletKind: meta ? (meta.walletKind || "") : "",
    headerKeywords, ...out, kind, scanned,
  };
}

/* ---------- reconciliation ---------- */

/* Opening ± rows must equal the printed closing (card: + debits − credits;
   account: + credits − debits), totals must match where printed, and each
   running balance must follow from the one before. Never adjusts a figure:
   it reports what doesn't add up, by row and page.
   → { status: "ok" | "mismatch" | "none", problems: [..], badRows: Set<row> } */
function reconcileStatement(parsed) {
  const problems = [];
  const badRows = new Set();
  const sign = (r) => (parsed.kind === "account" ? (r.dir === "credit" ? 1 : -1) : (r.dir === "debit" ? 1 : -1));
  let checked = 0;
  for (const s of parsed.sections || []) {
    const debit = stmtRound(s.rows.filter((r) => r.dir === "debit").reduce((a, r) => a + r.amount, 0));
    const credit = stmtRound(s.rows.filter((r) => r.dir === "credit").reduce((a, r) => a + r.amount, 0));
    if (s.totalDebit != null) { checked++; if (Math.abs(s.totalDebit - debit) > 0.005) problems.push({ page: s.page, what: "debits", printed: s.totalDebit, found: debit }); }
    if (s.totalCredit != null) { checked++; if (Math.abs(s.totalCredit - credit) > 0.005) problems.push({ page: s.page, what: "credits", printed: s.totalCredit, found: credit }); }
    if (s.opening != null && s.closing != null) {
      checked++;
      const end = stmtRound(s.rows.reduce((a, r) => a + sign(r) * r.amount, s.opening));
      if (Math.abs(end - s.closing) > 0.005) problems.push({ page: s.page, what: "closing", printed: s.closing, found: end });
    }
  }
  // Running balances (accounts).
  let prev = (parsed.sections && parsed.sections[0] && parsed.sections[0].opening != null) ? parsed.sections[0].opening : null;
  for (const r of parsed.rows) {
    if (r.balance == null) continue;
    if (prev != null) {
      checked++;
      if (Math.abs(stmtRound(prev + sign(r) * r.amount) - r.balance) > 0.005) { badRows.add(r); problems.push({ page: r.page, what: "balance", row: r }); }
    }
    prev = r.balance;
  }
  if (!parsed.rows.length) return { status: "mismatch", problems: [{ what: "no rows" }], badRows };
  if (!checked) return { status: "none", problems, badRows };
  // A Duitful AI+ read checks out only against a printed opening and closing
  // balance: without the opening, the first balance row (its amount and
  // direction) is never checked, so it could be a figure that isn't a row.
  if (parsed.aiPlus && !problems.length && !(parsed.sections || []).some((s) => s.opening != null && s.closing != null && s.rows.length)) {
    return { status: "none", problems, badRows };
  }
  return { status: problems.length ? "mismatch" : "ok", problems, badRows };
}

/* ---------- rows → things to import ---------- */

const STMT_CARD_PAYMENT = /\b(?:PAYMENT\s*-?\s*THANK YOU|THANK YOU|PAYMENT RECEIVED|FUNDS TRANSFER|IBFT|IBG|TOP-?UP|RPP|AUTO\s*DEBIT|BAYARAN)\b/i;
const STMT_REBATE = /\b(?:CASH ?REBATE|REBATE|CASHBACK|CASH BACK|REFUND|REVERSAL)\b/i;
const STMT_DEBT_HINT = /\b(?:LOAN|HIRE PURCHASE|HP\b|FINANCING|PEMBIAYAAN|CARD|KAD|PTPTN|INSTALL?MENT|ANSURAN|AUTO\s*DEBIT|STANDING\s*INSTRUCTION|SI\s+PYMT|BAYARAN|PAYMENT|REPAYMENT)\b/i;
const STMT_BILLER_ALIASES = [
  ["TNB", "TENAGA NASIONAL", "TENAGA"],
  ["TM", "UNIFI", "TELEKOM", "STREAMYX"],
  ["SYABAS", "AIR SELANGOR", "PENGURUSAN AIR", "SAJ", "PBA", "SADA", "LAP", "PAIP", "SAMB", "SATU", "AKSB", "SAINS"],
  ["IWK", "INDAH WATER"],
  ["MAXIS", "HOTLINK"],
  ["CELCOM", "DIGI", "CELCOMDIGI"],
  ["UMOBILE", "U MOBILE"],
  ["TIME", "TIME DOTCOM", "TIME FIBRE"],
  ["PTPTN", "PERBADANAN TABUNG"],
  ["MAYBANK", "MBB", "MAE", "MALAYAN BANKING"],
  ["CIMB", "CIMB BANK", "CIMB ISLAMIC"],
  ["PUBLIC BANK", "PBB", "PBE"],
  ["RHB", "RHB BANK"],
  ["HONG LEONG", "HLB", "HLBB"],
  ["AMBANK", "AMISLAMIC"],
  ["BANK ISLAM", "BIMB"],
  ["AFFIN", "AFFIN BANK"],
  ["BSN", "BANK SIMPANAN"],
  ["STANDARD CHARTERED", "SCB"],
  ["ATOME"],
  ["SPAYLATER", "SHOPEE PAYLATER"],
  ["GRAB PAYLATER", "PAYLATER"],
  ["ICLOUD", "APPLE COM BILL"],
];
const STMT_STOP_WORDS = new Set(["BANK", "SDN", "BHD", "BERHAD", "PAYMENT", "PAY", "BILL", "AUTO", "DEBIT", "TRANSFER", "DUITNOW", "JOMPAY", "ONLINE", "MYR", "MALAYSIA", "CARD", "LOAN", "PLAN", "MONTHLY"]);

function stmtNorm(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
function stmtTokens(s) {
  return stmtNorm(s).split(" ").filter((w) => w.length >= 3 && !STMT_STOP_WORDS.has(w) && !/^\d+$/.test(w));
}
function stmtAliasGroups(s) {
  const n = ` ${stmtNorm(s)} `;
  const out = [];
  for (let g = 0; g < STMT_BILLER_ALIASES.length; g++) {
    if (STMT_BILLER_ALIASES[g].some((a) => n.includes(` ${a} `))) out.push(g);
  }
  return out;
}
function stmtNameMatch(haystack, target) {
  const H = stmtNorm(haystack), T = stmtNorm(target);
  if (!H || !T) return false;
  if (T.length >= 3 && H.includes(T)) return true;
  if (H.length >= 4 && T.includes(H)) return true;
  const gH = stmtAliasGroups(H), gT = stmtAliasGroups(T);
  if (gH.length && gT.some((g) => gH.includes(g))) return true;
  const tH = new Set(stmtTokens(H));
  const tT = stmtTokens(T);
  return tT.length > 0 && tT.some((w) => w.length >= 3 && tH.has(w));
}
function stmtSimilar(a, b) {
  const A = stmtNorm(a), B = stmtNorm(b);
  if (!A || !B) return false;
  if (A.includes(B) || B.includes(A)) return true;
  const tb = new Set(B.split(" ").filter((w) => w.length >= 4));
  return A.split(" ").some((w) => w.length >= 4 && tb.has(w));
}
function stmtDayDiff(a, b) { return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000); }
function stmtDomDiff(isoDate, dueDay) {
  if (!isoDate || !Number.isFinite(Number(dueDay))) return Infinity;
  const d = Number(isoDate.slice(8, 10));
  const dd = Number(dueDay);
  if (!d || !dd) return Infinity;
  const raw = Math.abs(d - dd);
  return Math.min(raw, 30 - raw);
}

function stmtDebtExpectedPay(d) {
  if (!d) return 0;
  if (typeof isIslamic === "function" && isIslamic(d) && typeof islamicInstalment === "function") {
    return islamicInstalment(d) || Number(d.minPayment) || 0;
  }
  return Number(d.installment) || Number(d.minPayment) || 0;
}

function stmtMatchDebt(r, debts, usedDebtKeys) {
  const active = (debts || []).filter((d) => (Number(d.balance) || 0) > 0);
  if (!active.length || !r.date) return null;
  const ym = r.date.slice(0, 7);
  const text = `${r.payee || ""} ${r.desc || ""}`;
  const hasHint = STMT_DEBT_HINT.test(text);
  let best = null;
  let bestScore = 0;

  for (const d of active) {
    const key = `${d.id}|${ym}`;
    // Allow multiple payments on revolving cards, but avoid double-matching fixed instalments.
    if (usedDebtKeys.has(key) && (d.kind === "installment" || (typeof isIslamic === "function" && isIslamic(d)))) continue;
    const min = stmtDebtExpectedPay(d);
    const bal = Number(d.balance) || 0;
    const nameHit = stmtNameMatch(text, d.name);
    const exactMin = min > 0 && Math.abs(r.amount - min) <= Math.max(0.5, min * 0.01);
    const closeMin = min > 0 && Math.abs(r.amount - min) <= Math.max(5, min * 0.05);
    const exactBal = bal > 0 && Math.abs(r.amount - bal) <= Math.max(1, bal * 0.01);
    const nearDue = stmtDomDiff(r.date, d.dueDay) <= 4;

    let score = 0;
    if (nameHit && (exactMin || exactBal)) score = 100;
    else if (nameHit && closeMin) score = 88;
    else if (nameHit && hasHint && r.amount <= bal * 1.15) score = 78;
    else if (exactMin && nearDue) {
      // Cryptic bank ref (e.g. "AUTODEBIT 88219"): require unique amount match across active debts.
      const sameAmt = active.filter((x) => {
        const m = stmtDebtExpectedPay(x);
        return m > 0 && Math.abs(r.amount - m) <= 0.5;
      });
      if (sameAmt.length === 1) score = 72;
    }

    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return bestScore >= 70 ? best : null;
}

function stmtBillsForMonth(expenses, ym) {
  const list = expenses || [];
  const inMonth = list.filter((x) => x.month === ym);
  if (inMonth.length) return { bills: inMonth, isTemplate: false };
  // Statement for a month not yet rolled over: fall back to latest repeating bills.
  const months = [...new Set(list.map((x) => x.month).filter(Boolean))].sort();
  const latest = months[months.length - 1];
  if (!latest) return { bills: [], isTemplate: false };
  return { bills: list.filter((x) => x.month === latest && x.repeatNext !== false), isTemplate: true };
}

function stmtMatchBill(r, expenses, usedBillIds) {
  if (!r.date || !(expenses && expenses.length)) return null;
  const ym = r.date.slice(0, 7);
  const { bills, isTemplate } = stmtBillsForMonth(expenses, ym);
  if (!bills.length) return null;
  const text = `${r.payee || ""} ${r.desc || ""}`;
  let best = null;
  let bestScore = 0;

  for (const ex of bills) {
    if (usedBillIds.has(`${ex.id}|${ym}`)) continue;
    const baseAmt = Number(ex.plannedAmount ?? ex.amount) || 0;
    const nameHit = stmtNameMatch(text, ex.name);
    const exactAmt = baseAmt > 0 && Math.abs(r.amount - baseAmt) <= 0.5;
    // Utilities (TNB, water, phone) vary month to month: allow ±35% or ±RM 50 on a name match.
    const varAmt = baseAmt > 0 && (Math.abs(r.amount - baseAmt) <= Math.max(50, baseAmt * 0.35));
    const nearDue = stmtDomDiff(r.date, ex.day) <= 4;

    let score = 0;
    if (nameHit && exactAmt) score = 96;
    else if (nameHit && varAmt && nearDue) score = 86;
    else if (nameHit && varAmt) score = 76;
    else if (exactAmt && nearDue && !ex.paidDate) {
      const sameAmt = bills.filter((x) => Math.abs(r.amount - (Number(x.plannedAmount ?? x.amount) || 0)) <= 0.5);
      if (sameAmt.length === 1) score = 72;
    }

    if (score > bestScore) {
      bestScore = score;
      best = { ex, isTemplate, ym };
    }
  }
  return bestScore >= 70 ? best : null;
}

/* Each parsed row → a review item: { kind: "spend" | "debt" | "bill" | "income" | "move",
   on (ticked), note }. Card payments are money moving from your own account,
   so they import as nothing; a row naming a saved own-account name is a move
   too. Debit rows matching an active debt or recurring bill auto-link to
   reconcile instead of double-counting (with 1-tap override to New Spend or
   Skip). Rows already in Duitful start unticked. */
function statementItems(parsed, recon) {
  const own = (typeof state !== "undefined" && state.ownAccounts) || [];
  const isOwn = (desc) => own.some((n) => n && stmtNorm(desc).includes(stmtNorm(n)));
  const dailyAll = (typeof state !== "undefined" && state && state.dailyExpenses) || [];
  const spends = dailyAll.filter((e) => e.kind === "expense");
  const debtPays = dailyAll.filter((e) => e.kind === "debt");
  const pend = (typeof state !== "undefined" && state && state.pendingTxns) || [];
  const debts = (typeof state !== "undefined" && state && state.debts) || [];
  const expenses = (typeof state !== "undefined" && state && state.expenses) || [];
  const cats = typeof scanAllCategories === "function" ? scanAllCategories() : [];
  const usedDebtKeys = new Set();
  const usedBillIds = new Set();

  return parsed.rows.map((r, i) => {
    let kind = "spend", note = "", label = "";
    let debtId = "", billId = "", billName = "", billPlanned = null, autoMatched = "";

    if (parsed.kind === "card") {
      if (r.dir === "credit") {
        if (STMT_CARD_PAYMENT.test(r.desc) && !STMT_REBATE.test(r.desc)) { kind = "move"; note = tr("Card payment · not counted"); }
        else { kind = "income"; label = STMT_REBATE.test(r.desc) ? (/REFUND|REVERSAL/i.test(r.desc) ? "Refund" : "Cashback") : ""; }
      }
    } else if (r.dir === "credit") kind = "income";
    if (kind !== "move" && isOwn(r.desc)) { kind = "move"; note = tr("Between your accounts"); }

    // Auto-match debit rows against active debts & recurring bills before classifying as a plain spend.
    if (kind === "spend" && r.date) {
      const mDebt = stmtMatchDebt(r, debts, usedDebtKeys);
      if (mDebt) {
        kind = "debt";
        debtId = mDebt.id;
        autoMatched = "debt";
        usedDebtKeys.add(`${mDebt.id}|${r.date.slice(0, 7)}`);
      } else {
        const mBill = stmtMatchBill(r, expenses, usedBillIds);
        if (mBill) {
          kind = "bill";
          billId = mBill.ex.id;
          billName = mBill.ex.name;
          billPlanned = Number(mBill.ex.plannedAmount ?? mBill.ex.amount) || 0;
          autoMatched = "bill";
          usedBillIds.add(`${mBill.ex.id}|${mBill.ym}`);
        }
      }
    }

    let dup = false;
    if (kind === "debt") {
      dup = debtPays.some((e) => e.debtId === debtId && Math.abs(Number(e.amount) - r.amount) < 0.005 && e.date && stmtDayDiff(e.date, r.date) <= 2);
    } else if (kind === "bill") {
      const ym = r.date.slice(0, 7);
      const existing = expenses.find((x) => x.id === billId && x.month === ym);
      dup = !!(existing && existing.paidDate && stmtDayDiff(existing.paidDate, r.date) <= 2 && Math.abs(Number(existing.amount) - r.amount) < 0.005);
    } else if (kind === "spend") {
      dup = spends.some((e) => Math.abs(Number(e.amount) - r.amount) < 0.005 && e.date && stmtDayDiff(e.date, r.date) <= 1 && (stmtSimilar(e.note, r.payee) || stmtSimilar(e.category, r.payee) || stmtDayDiff(e.date, r.date) === 0))
        || pend.some((p) => !p.kind && Math.abs(Number(p.amount) - r.amount) < 0.005 && stmtDayDiff(new Date(p.createdAt).toISOString().slice(0, 10), r.date) <= 1);
    } else if (kind === "income") {
      dup = ((typeof state !== "undefined" && state && state.income) || []).some((x) => Math.abs(Number(x.amount) - r.amount) < 0.005 && x.month === r.date.slice(0, 7) && Math.abs(Number(x.day || 0) - Number(r.date.slice(8, 10))) <= 1)
        || pend.some((p) => p.kind === "income" && Math.abs(Number(p.amount) - r.amount) < 0.005 && stmtDayDiff(new Date(p.createdAt).toISOString().slice(0, 10), r.date) <= 1);
    }
    if (dup) note = tr("Already in Duitful");

    let category = "";
    if (kind === "spend") {
      try { category = (typeof scanGuessCategory === "function" ? scanGuessCategory(r.payee, r.desc) : "") || ""; } catch { category = ""; }
      if (category && cats.length && !cats.includes(category)) category = "";
    }
    return {
      id: `stmt-${i}`, row: r, date: r.date, payee: r.payee || r.desc.slice(0, 40), amount: r.amount,
      kind, label, category, note, dup, flagged: !!(recon && recon.badRows && recon.badRows.has(r)),
      debtId, billId, billName, billPlanned, autoMatched,
      on: kind !== "move" && !dup && !!r.date,
    };
  });
}

/* On-device AI (only if allowed and present): suggests a category from the
   app's own list and a cleaner payee (only words the description contains),
   for spends that have no category yet. Never reads or writes an amount or a
   date. Short timeouts; failure changes nothing.
   It runs as a background batch (aiBatchStart in script.js): the sheet shows
   briefly, tucks into the header badge, and the badge fills as answers land.
   The review stays usable throughout — each answer fills its row in place
   (opts.onAnswer), what you changed yourself is never overwritten, and Import
   never waits. The phone's AI runs inside the app, so the batch pauses while
   the app is in the background and picks up the rows left when it returns,
   if the review is still open (opts.alive). Rows never asked keep the rules'
   guess. */
async function statementAiSuggest(items, opts) {
  if (typeof aiAllowed === "function" && !aiAllowed()) return 0;
  const kit = typeof duitfulKit === "function" ? duitfulKit("aiReadAlert") : null;
  if (!kit || typeof kit.aiStatus !== "function") return 0;
  try { const st = await withTimeout(kit.aiStatus(), 2000); if (!st || !st.available) return 0; } catch { return 0; }
  const cats = typeof scanAllCategories === "function" ? scanAllCategories() : [];
  const max = (opts && opts.max) || 20;
  const alive = (opts && opts.alive) || (() => true);
  const todo = items.filter((it) => it.kind === "spend" && !it.category && !it.aiAsked).slice(0, max);
  if (!todo.length) return 0;
  const runAi = typeof withAiThinking === "function" ? withAiThinking : (fn) => fn();
  const batch = typeof aiBatchStart === "function"
    ? aiBatchStart({ label: "Sorting your statement", say: "AI is sorting your statement", total: todo.length, overlay: !(opts && opts.quiet) }) : null;
  let n = 0;
  try {
    for (let k = 0; k < todo.length; k++) {
      if (typeof aiUntilForeground === "function") await aiUntilForeground();
      if (!alive()) break;
      const it = todo[k];
      if (it.kind === "spend" && !it.category && !it.userCat) {
        n++;
        let reply = null;
        try { reply = parseAiAlertReply(await runAi(() => withTimeout(kit.aiReadAlert({ text: it.row.desc.slice(0, 300), categories: cats }), 5000))); } catch { reply = null; }
        it.aiAsked = true;
        if (reply && !reply.promo && alive()) {
          const cat = typeof aiCategoryIn === "function" ? aiCategoryIn(reply.category, cats) : "";
          const who = typeof aiNameInText === "function" ? aiNameInText(reply.counterparty, it.row.desc) : "";
          let changed = false;
          if (cat && !it.category && !it.userCat) { it.category = cat; it.ai = true; changed = true; }
          if (who && !it.userPayee && !it.aiPlus) { it.payee = who; it.ai = true; changed = true; }
          if (changed && opts && typeof opts.onAnswer === "function") opts.onAnswer(it);
        }
      }
      if (typeof aiBatchStep === "function") aiBatchStep(batch, k + 1);
    }
  } finally {
    if (typeof aiBatchEnd === "function") aiBatchEnd(batch);
  }
  return n;
}

// A row the AI just filled: change it where it stands (never re-render the
// list under someone's thumb), and tag it.
function stmtShowAiRow(it) {
  const i = stmtUi.items.indexOf(it);
  const li = i < 0 ? null : stmtEl("stmt-list")?.querySelector(`[data-stmt-on="${i}"]`)?.closest(".stmt-row");
  if (!li) return;
  const sel = li.querySelector("[data-stmt-cat]");
  if (sel && document.activeElement !== sel) sel.value = it.category || "";
  const pay = li.querySelector("[data-stmt-payee]");
  if (pay && document.activeElement !== pay) pay.value = it.payee;
  // Beside the payee, so nothing below moves when it lands. A name from AI+
  // (cloud) swaps the phone-AI tag for the "AI+" one.
  const tag = li.querySelector(".stmt-ai");
  if (tag && it.aiPlus && !tag.classList.contains("ai-plus-badge")) tag.remove();
  if (!li.querySelector(".stmt-ai")) pay?.insertAdjacentHTML("afterend", stmtAiTag(it));
  li.classList.remove("is-ai-new");
  void li.offsetWidth;
  li.classList.add("is-ai-new");
}
function stmtAiTag(it) {
  if (it && it.aiPlus) {
    const t = escapeHtml(tr("Suggested by Duitful AI+ (cloud)"));
    return `<span class="ai-plus-badge stmt-ai" title="${t}" aria-label="${t}" translate="no">AI+</span>`;
  }
  const t = escapeHtml(tr("Suggested by your phone's AI"));
  return `<span class="stmt-tag stmt-ai" title="${t}" aria-label="${t}" translate="no">AI</span>`;
}

/* ---------- Duitful AI+ (cloud), only when aiCloudAllowed() ----------
   Two tasks, both optional: "statement-read" offers to read the rows when the
   on-device read doesn't add up, "payee-clean" tidies payee names. Each runs
   after the redacted-text preview (first send), and any failure leaves the
   review exactly as the phone read it. Amounts always come from the statement:
   rows are re-checked against its text here, then through reconcileStatement
   and the same scan rule (a read imports only when it checks out). */
function stmtCloudOn() {
  return typeof aiCloudAllowed === "function" && aiCloudAllowed();
}
function stmtReadText(read) {
  return ((read && read.lines) || []).map((l) => l.text).join("\n").slice(0, 20000);
}
// AI+ answer -> a parsed statement, keeping only what the text itself prints.
function stmtParsedFromCloud(res, text, prev) {
  if (!res || !Array.isArray(res.rows)) return null;
  const inText = (n) => typeof aiAmountInText === "function" ? aiAmountInText(n, text) : false;
  const rows = [];
  for (const r of res.rows.slice(0, 200)) {
    if (!r || typeof r !== "object") continue;
    const amount = stmtRound(Number(r.amount));
    const desc = stmtClean(r.desc).slice(0, 140);
    const date = String(r.date || "");
    const dir = r.dir === "in" ? "credit" : r.dir === "out" ? "debit" : "";
    if (!(amount > 0) || !desc || !dir || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !inText(amount)) continue;
    const row = { date, desc, payee: desc.slice(0, 60), amount, dir, page: 1 };
    const bal = Number(r.balance);
    if (r.balance != null && Number.isFinite(bal) && (bal === 0 || inText(Math.abs(bal)))) row.balance = stmtRound(bal);
    rows.push(row);
  }
  if (!rows.length) return null;
  const fig = (v) => { const n = Number(v); return v != null && Number.isFinite(n) && (n === 0 || inText(Math.abs(n))) ? stmtRound(n) : null; };
  const opening = fig(res.opening), closing = fig(res.closing);
  const kind = prev && prev.rows && prev.rows.length && prev.kind ? prev.kind : rows.some((r) => r.balance != null) ? "account" : "card";
  const sections = opening != null && closing != null ? [{ opening, closing, rows, page: 1 }] : [];
  const meta = stmtDetectBank(text, prev && prev.bank);
  const headerKeywords = (prev && Array.isArray(prev.headerKeywords) && prev.headerKeywords.length)
    ? prev.headerKeywords
    : stmtExtractHeaderKeywords(text);
  return {
    layout: "generic",
    bank: (prev && prev.bank) || (meta ? meta.bank : ""),
    provider: (prev && prev.provider) || (meta ? meta.provider : ""),
    walletKind: (prev && prev.walletKind) || (meta ? (meta.walletKind || "") : ""),
    headerKeywords,
    kind,
    stmt: (prev && prev.stmt) || null,
    rows,
    sections,
    scanned: true,
    aiPlus: true,
  };
}

// The offer: shown while the phone's read doesn't check out.
function stmtCloudRefresh() {
  const box = stmtEl("stmt-cloud");
  if (!box) return;
  const p = stmtUi.parsed, r = stmtUi.recon;
  box.hidden = !(stmtUi.read && p && !p.aiPlus && r && r.status !== "ok" && stmtCloudOn() && typeof aiCloudReadStatement === "function" && stmtReadText(stmtUi.read));
}

async function statementCloudRead() {
  if (!stmtUi.read || !stmtUi.parsed || stmtUi.cloudBusy || !stmtCloudOn() || typeof aiCloudReadStatement !== "function") return false;
  const read = stmtUi.read, prev = stmtUi.parsed;
  const text = stmtReadText(read);
  if (!text) return false;
  const btn = stmtEl("stmt-cloud-read");
  stmtUi.cloudBusy = true;
  if (btn) btn.disabled = true;
  stmtSay(tr("Reading with Duitful AI+ (cloud)…"));
  let parsed = null, recon = null;
  try {
    const res = await aiCloudReadStatement({ text, bankName: prev.bank || "" });
    parsed = stmtParsedFromCloud(res, text, prev);
    recon = parsed ? reconcileStatement(parsed) : null;
  } catch { parsed = null; }
  stmtUi.cloudBusy = false;
  if (btn) btn.disabled = false;
  if (stmtUi.read !== read || !stmtEl("stmt-dialog")?.open) return false;
  // Never worse than today: a read that doesn't check out replaces nothing
  // that had rows (and shows, but can't import, when the phone found none).
  const usable = parsed && (recon.status === "ok" || !prev.rows.length);
  if (!usable) {
    stmtSay(tr("Duitful AI+ couldn't read this one. Your review is unchanged."));
    return false;
  }
  const before = stmtUi.items;
  stmtUi.parsed = parsed; stmtUi.recon = recon;
  if (!stmtUi.fixed && !stmtUi.wallet) stmtResolveWallet(parsed);
  stmtUi.items = statementItems(parsed, recon);
  for (const it of stmtUi.items) it.aiPlus = true;
  stmtCarryEdits(before, stmtUi.items);
  stmtSay("");
  stmtEl("stmt-review").hidden = false;
  stmtEl("stmt-import").hidden = false;
  renderStatementReview();
  stmtRunAi(stmtUi.items);
  return true;
}

/* What the person already changed on the phone's rows survives an AI+ re-read:
   each edited row is matched to a new row with the same date, direction and
   amount (their corrected amount, if they fixed one), and its payee, category,
   type and tick come along. Rows with no match keep the new read's defaults. */
function stmtCarryEdits(prev, next) {
  const used = new Set();
  for (const old of prev || []) {
    if (!(old.userPayee || old.userCat || old.userOn || old.userKind || old.userTarget)) continue;
    const dir = old.row && old.row.dir;
    const hit = next.find((n) => !used.has(n) && n.date === old.date && n.row.dir === dir && Math.abs(n.amount - Number(old.amount)) < 0.005);
    if (!hit) continue;
    used.add(hit);
    if (old.userPayee) { hit.payee = old.payee; hit.userPayee = true; hit.aiPlus = false; }
    if (old.userCat) { hit.category = old.category; hit.userCat = true; }
    if (old.userKind) { hit.kind = old.kind; hit.userKind = true; if (hit.kind === "move") hit.on = false; }
    if (old.userTarget) { hit.debtId = old.debtId; hit.billId = old.billId; hit.billName = old.billName; hit.billPlanned = old.billPlanned; hit.userTarget = true; }
    if (old.userOn) { hit.on = hit.kind === "move" ? false : old.on; hit.userOn = true; }
  }
}

// Tidies payees one call at a time. Same promises as statementAiSuggest: rows
// fill in place, rows you changed (userPayee / userCat) are never asked or
// overwritten, Import never waits.
async function statementCloudPayees(items, opts) {
  if (!stmtCloudOn() || typeof aiCloudCleanPayee !== "function") return 0;
  const alive = (opts && opts.alive) || (() => true);
  const todo = items.filter((it) => it.kind !== "move" && !it.userPayee && !it.userCat && !it.cloudAsked && it.row && it.row.desc).slice(0, (opts && opts.max) || 20);
  if (!todo.length) return 0;
  const batch = typeof aiBatchStart === "function"
    ? aiBatchStart({ label: "Tidying payee names", say: "AI+ is tidying payee names", total: todo.length, overlay: false }) : null;
  let n = 0, misses = 0;
  try {
    for (let k = 0; k < todo.length; k++) {
      if (typeof aiUntilForeground === "function") await aiUntilForeground();
      if (!alive() || !stmtCloudOn()) break;
      const it = todo[k];
      it.cloudAsked = true;
      let res = null;
      try { res = await aiCloudCleanPayee(it.row.desc); } catch { res = null; }
      n++;
      if (res && typeof res.payee === "string") {
        misses = 0;
        const who = stmtClean(res.payee).slice(0, 60);
        if (who && alive() && !it.userPayee && !it.userCat && who !== it.payee) {
          it.payee = who; it.ai = true; it.aiPlus = true;
          if (opts && typeof opts.onAnswer === "function") opts.onAnswer(it);
        }
      } else if (++misses >= 3 || !(state.aiPlusPreviewedKinds && state.aiPlusPreviewedKinds.payee)) break;   // declined, offline or at the cap
      if (typeof aiBatchStep === "function") aiBatchStep(batch, k + 1);
    }
  } finally {
    if (typeof aiBatchEnd === "function") aiBatchEnd(batch);
  }
  return n;
}

// Both helpers for the open review: AI+ names first (when on), then the
// phone's own suggestions, which never overwrite an AI+ name.
async function stmtRunAi(items) {
  const opts = { alive: () => stmtUi.items === items && !!stmtEl("stmt-dialog")?.open, onAnswer: stmtShowAiRow };
  try { await statementCloudPayees(items, opts); } catch { /* the review stays as it is */ }
  try { await statementAiSuggest(items, opts); } catch { /* ditto */ }
}

/* Books the ticked items. Spends go where daily spending goes; debt matches
   record a real debt payment and lower the debt balance; bill matches mark
   that month's recurring bill paid (updating this month's actual while keeping
   the template amount for future months); income goes to state.income like
   captured income; moves book nothing. Every row is marked from a statement. */
function importStatementItems(items, bankName, walletId) {
  let spends = 0, incomes = 0, debts = 0, bills = 0;
  // One wallet for the whole statement (picked once, or none).
  const w = walletId && typeof walletById === "function" && walletById(walletId) ? { walletId } : {};
  const debtPool = typeof findSystemDebtPool === "function" ? findSystemDebtPool() : null;

  for (const it of items) {
    if (!it.on || it.kind === "move" || !it.date || !(it.amount > 0)) continue;

    if (it.kind === "debt") {
      const debt = (state.debts || []).find((d) => d.id === it.debtId);
      if (debt) {
        const applied = Math.min(it.amount, Number(debt.balance) || 0);
        debt.balance = Math.max(0, +((Number(debt.balance) || 0) - applied).toFixed(2));
        const entry = {
          id: uid(), createdAt: Date.now(), kind: "debt", date: it.date, amount: it.amount,
          debtId: debt.id, debtName: debt.name, note: it.payee || "", source: "statement", ...w,
        };
        if (debtPool) { entry.budgetPoolId = debtPool.id; entry.budgetPoolName = debtPool.name; }
        state.dailyExpenses.push(entry);
        debts++;
        continue;
      }
      // Fallback if debt was deleted mid-review: record as a plain spend.
      state.dailyExpenses.push({ id: uid(), createdAt: Date.now(), kind: "expense", date: it.date, amount: it.amount,
        category: it.category || "Others", note: it.payee || "", source: "statement", ...w });
      spends++;
    } else if (it.kind === "bill") {
      const ym = it.date.slice(0, 7);
      const list = state.expenses || [];
      let target = list.find((x) => x.id === it.billId && x.month === ym);
      if (!target) {
        const tmpl = list.find((x) => x.id === it.billId);
        if (tmpl) {
          // Check if a same-name bill already exists in this month.
          target = list.find((x) => x.month === ym && stmtNorm(x.name) === stmtNorm(tmpl.name));
          if (!target) {
            target = {
              id: uid(),
              name: tmpl.name,
              amount: Number(tmpl.plannedAmount ?? tmpl.amount) || it.amount,
              month: ym,
              day: tmpl.day ?? Number(it.date.slice(8, 10)),
              repeatNext: tmpl.repeatNext !== false,
              ...(tmpl.fx ? { fx: { ...tmpl.fx } } : {}),
              ...(tmpl.budgetPoolId ? { budgetPoolId: tmpl.budgetPoolId, budgetPoolName: tmpl.budgetPoolName } : {}),
            };
            state.expenses.push(target);
          }
        }
      }
      if (target) {
        const basePlanned = Number(target.plannedAmount ?? target.amount);
        if (Number.isFinite(basePlanned) && Math.abs(basePlanned - it.amount) >= 0.01) {
          target.plannedAmount = basePlanned;
        }
        target.amount = it.amount;
        target.paidDate = it.date;
        target.source = "statement";
        if (w.walletId) target.walletId = w.walletId;
        bills++;
        continue;
      }
      // Fallback if bill target no longer exists: record as plain spend.
      state.dailyExpenses.push({ id: uid(), createdAt: Date.now(), kind: "expense", date: it.date, amount: it.amount,
        category: it.category || "Others", note: it.payee || "", source: "statement", ...w });
      spends++;
    } else if (it.kind === "spend") {
      state.dailyExpenses.push({ id: uid(), createdAt: Date.now(), kind: "expense", date: it.date, amount: it.amount,
        category: it.category || "Others", note: it.payee || "", source: "statement", ...w });
      spends++;
    } else if (it.kind === "income") {
      state.income.push({ id: uid(), name: it.label ? `${it.label} · ${it.payee}` : (it.payee || "Money in"), amount: it.amount,
        month: it.date.slice(0, 7), day: Number(it.date.slice(8, 10)), repeatNext: false, category: it.label || "Money in",
        note: bankName ? `${bankName} statement` : "Statement", source: "statement", ...w });
      incomes++;
    }
  }
  return { spends, incomes, debts, bills };
}

/* ---------- every month ----------
   After an import, the bank and the last date the statement covered are kept
   (state.statementLast, one per bank layout, in the vault). About a month on
   (STMT_NEXT_DAYS), Home shows one quiet card, "Your Maybank card statement
   should be out", with Import and Not now, asked once per statement; phones
   also get a one-off reminder that morning. A new import moves it on. */
const STMT_NEXT_DAYS = 33;
const STMT_LAST_MAX = 6;
function coerceStatementLast(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x && typeof x === "object" && /^\d{4}-\d{2}-\d{2}$/.test(String(x.end || "")))
    .slice(-STMT_LAST_MAX)
    .map((x) => ({ key: String(x.key || "generic").slice(0, 40), bank: String(x.bank || "").slice(0, 40),
      kind: x.kind === "card" ? "card" : x.kind === "account" ? "account" : "", end: String(x.end),
      skipped: /^\d{4}-\d{2}-\d{2}$/.test(String(x.skipped || "")) ? String(x.skipped) : "",
      // The wallet this bank layout's statements go into (wallets.js).
      wallet: typeof x.wallet === "string" ? x.wallet.slice(0, 40) : "" }));
}
function stmtKeyOf(parsed) { return parsed.layout && parsed.layout !== "generic" ? parsed.layout : `generic${parsed.bank ? ":" + parsed.bank : ""}`; }
function stmtNameOf(rec) {
  return rec.bank ? tr(rec.kind === "card" ? "{bank} card" : "{bank} account", { bank: rec.bank }) : tr("bank");
}
function stmtAddDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function rememberStatement(parsed, walletId) {
  if (!parsed || !parsed.rows || typeof state === "undefined" || !state) return;
  const end = parsed.rows.map((r) => r.date).filter(Boolean).sort().pop();
  if (!end) return;
  const key = stmtKeyOf(parsed);
  const list = (state.statementLast || []).filter((x) => x.key !== key);
  const prev = (state.statementLast || []).find((x) => x.key === key);
  // An older statement imported late never winds the clock back.
  const latest = prev && prev.end > end ? prev.end : end;
  list.push({ key, bank: parsed.bank || "", kind: parsed.kind || "", end: latest, skipped: "", wallet: walletId || "" });
  state.statementLast = list.slice(-STMT_LAST_MAX);
}
// The statement that is due soonest and not skipped, or null.
function statementDue(today) {
  const t = today || (typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10));
  const due = ((typeof state !== "undefined" && state && state.statementLast) || [])
    .filter((x) => x.skipped !== x.end && stmtAddDays(x.end, STMT_NEXT_DAYS) <= t)
    .sort((a, b) => a.end.localeCompare(b.end));
  return due[0] || null;
}
function renderStatementNudge() {
  const card = stmtEl("stmt-nudge");
  if (!card) return;
  const aiCard = stmtEl("ai-intro");
  const rec = typeof state !== "undefined" && state ? statementDue() : null;
  card.hidden = !rec || !!(aiCard && !aiCard.hidden);
  if (card.hidden) return;
  stmtEl("stmt-nudge-title").textContent = tr("Your {name} statement should be out", { name: stmtNameOf(rec) });
  stmtEl("stmt-nudge-body").textContent = tr("The last one you imported ran to {date}. Import the next to catch every spend.", { date: stmtFmtDate(rec.end) });
  card.dataset.key = rec.key;
}
function statementNativeReminders() {
  const out = [];
  if (typeof state === "undefined" || !state) return out;
  const now = Date.now();
  for (const rec of state.statementLast || []) {
    if (rec.skipped === rec.end) continue;
    const at = new Date(`${stmtAddDays(rec.end, STMT_NEXT_DAYS)}T09:00:00`);
    if (!(at.getTime() > now)) continue;
    out.push({ at, title: tr("Your {name} statement should be out", { name: stmtNameOf(rec) }), body: tr("Import it in Duitful to catch every spend.") });
  }
  return out;
}

/* ---------- the screen ---------- */

/* First-time wallet auto-matcher: when a statement wasn't opened from a
   specific wallet and hasn't been imported before (state.statementLast has no
   remembered wallet for this layout), pick the matching active wallet by bank
   brand/name + card-vs-account type. Never forces a mismatch (e.g. won't drop
   a bank savings statement into a credit card wallet or a Cash wallet). */
function stmtAutoMatchWallet(parsed, wallets) {
  if (!parsed || (!parsed.bank && !parsed.provider)) return null;
  const list = Array.isArray(wallets) ? wallets : (typeof activeWallets === "function" ? activeWallets() : []);
  if (!list.length) return null;

  const meta = STMT_BANK_DETECTORS.find((d) =>
    (parsed.provider && (d.provider === parsed.provider || (d.providers || []).includes(parsed.provider)))
    || (parsed.bank && d.bank.toLowerCase() === String(parsed.bank).toLowerCase()));
  const bankLower = String(parsed.bank || (meta && meta.bank) || "").toLowerCase();
  const providerSet = new Set(meta ? (meta.providers || [meta.provider]) : (parsed.provider ? [parsed.provider] : []));
  const kws = Array.isArray(parsed.headerKeywords) ? parsed.headerKeywords : [];
  const isCardStmt = parsed.kind === "card";
  const isEwalletStmt = parsed.walletKind === "ewallet" || (meta && meta.walletKind === "ewallet");
  const cardNameRe = /\b(?:card|credit|visa|master(?:card)?|amex|kad|cc|ikhwan)\b/i;

  const scored = [];
  for (const w of list) {
    if (!w || w.archived || w.type === "cash") continue;
    const name = String(w.name || "");
    const nameLower = name.toLowerCase();

    // 1) Require a genuine bank/issuer hit via provider id or wallet name.
    let bankScore = 0;
    const prov = String(w.provider || "").toLowerCase();
    if (prov && providerSet.has(prov)) {
      bankScore = 100;
    } else if (prov && typeof walletBrandById === "function") {
      const b = walletBrandById(prov);
      if (b && bankLower && b.name.toLowerCase() === bankLower) bankScore = 100;
    }
    if (!bankScore) {
      if (meta && meta.aliases && meta.aliases.test(name)) bankScore = 90;
      else if (bankLower && bankLower.length >= 3 && nameLower.includes(bankLower)) bankScore = 90;
    }
    if (!bankScore) continue;

    // 2) Card vs account type safety: never cross-contaminate card and bank balances.
    const nameHasCard = cardNameRe.test(name);
    let typeScore = 0;
    if (isCardStmt) {
      if (w.type === "card") typeScore += 40;
      else if (nameHasCard) typeScore += 25;
      else continue;
      if (nameHasCard) typeScore += 15;
    } else {
      if (w.type === "card" || nameHasCard) continue;
      if (isEwalletStmt) typeScore += (w.type === "ewallet" ? 40 : 15);
      else typeScore += (w.type === "bank" ? 40 : (w.type === "ewallet" ? 15 : 0));
    }

    // 3) Tie-break among same-bank wallets using header product keywords & alertDefault.
    let kwScore = 0;
    for (const kw of kws) {
      if (kw && nameLower.includes(kw)) kwScore += 18;
    }
    if (w.alertDefault) kwScore += 6;

    scored.push({ wallet: w, score: bankScore + typeScore + kwScore });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return { id: scored[0].wallet.id, bank: parsed.bank || (meta ? meta.bank : ""), score: scored[0].score };
}

// wallet: the wallet the rows go into; fixed: chosen by opening the import
// from that wallet, so the question isn't asked.
const stmtUi = { items: [], parsed: null, recon: null, file: null, wallet: "", walletAuto: false, fixed: false, read: null, cloudBusy: false };
const stmtEl = (id) => document.getElementById(id);

function stmtFmtDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return "—";
  const opts = d.getFullYear() !== new Date().getFullYear()
    ? { day: "numeric", month: "short", year: "numeric" }
    : { day: "numeric", month: "short" };
  return d.toLocaleDateString((window.I18N && window.I18N.locale()) || "en-MY", opts);
}
function stmtSay(msg) { const el = stmtEl("stmt-status"); if (el) { el.textContent = msg || ""; el.hidden = !msg; } }

function openStatementImport(opts) {
  const dlg = stmtEl("stmt-dialog");
  if (!dlg) return;
  stmtUi.items = []; stmtUi.parsed = null; stmtUi.recon = null; stmtUi.file = null; stmtUi.read = null; stmtUi.cloudBusy = false;
  const cloudBtn = stmtEl("stmt-cloud-read");
  if (cloudBtn) cloudBtn.disabled = false;
  stmtCloudRefresh();
  // A click handler passes its event; only { walletId } means "from a wallet".
  const wid = opts && typeof opts.walletId === "string" ? opts.walletId : "";
  stmtUi.fixed = !!(wid && typeof walletById === "function" && walletById(wid));
  stmtUi.wallet = stmtUi.fixed ? wid : "";
  stmtUi.walletAuto = false;
  stmtEl("stmt-pick").hidden = false;
  const scan = stmtEl("stmt-scan");
  if (scan) scan.hidden = !(typeof duitfulKit === "function" && duitfulKit("scanDocument"));
  stmtEl("stmt-password").hidden = true;
  stmtEl("stmt-review").hidden = true;
  stmtEl("stmt-import").hidden = true;
  stmtSay("");
  if (typeof renderFreeCounts === "function") renderFreeCounts();
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
}

// File → text → rows → check → review. The password, if any, lives only in
// this call. A PDF with no text layer is read with OCR instead.
const stmtPageSay = (n, of) => stmtSay(tr("Reading page {n} of {m} on your phone…", { n, m: of }));
const STMT_NO_TEXT = "Couldn't read any text on these pages. Try a sharper photo, or download the statement as a PDF from your bank's app.";
async function statementFromFile(file, password) {
  stmtUi.file = file;
  stmtSay(tr("Reading on your phone…"));
  let read;
  let data = null;
  try {
    data = await file.arrayBuffer();
    read = await readStatementPdf(data, password);
  } catch (e) {
    const code = e && e.code;
    if (code === "password" || code === "wrong-password") {
      stmtEl("stmt-pick").hidden = true;
      stmtEl("stmt-password").hidden = false;
      stmtSay(code === "wrong-password" ? tr("That password didn't open it.") : "");
      setTimeout(() => stmtEl("stmt-pw")?.focus(), 30);
      return null;
    }
    if (code !== "scanned" || !data) { stmtSay(tr("Couldn't read this PDF.")); return null; }
    try {
      read = await readStatementScanPdf(data, password, stmtPageSay);
    } catch (e2) {
      stmtSay(tr(e2 && e2.code === "no-text" ? STMT_NO_TEXT : "Couldn't read this PDF."));
      return null;
    }
  }
  return showStatementReview(read);
}

// Photos of the pages, or the phone's document scanner: OCR, then the same review.
async function statementFromPhotos(sources) {
  stmtUi.file = null;
  let read;
  try {
    read = await readStatementPhotos(sources, stmtPageSay);
  } catch (e) {
    stmtSay(tr(e && e.code === "no-text" ? STMT_NO_TEXT : "Couldn't read these photos."));
    return null;
  }
  return showStatementReview(read);
}

function stmtResolveWallet(parsed) {
  if (stmtUi.fixed) return;
  const rec = (state.statementLast || []).find((x) => x.key === stmtKeyOf(parsed));
  const remembered = rec && rec.wallet && typeof walletById === "function" ? walletById(rec.wallet) : null;
  if (remembered && !remembered.archived) {
    stmtUi.wallet = remembered.id;
    stmtUi.walletAuto = false;
    return;
  }
  const auto = stmtAutoMatchWallet(parsed);
  if (auto) {
    stmtUi.wallet = auto.id;
    stmtUi.walletAuto = true;
    return;
  }
  stmtUi.wallet = "";
  stmtUi.walletAuto = false;
}

function showStatementReview(read) {
  const parsed = parseStatement(read);
  const recon = reconcileStatement(parsed);
  stmtUi.parsed = parsed; stmtUi.recon = recon; stmtUi.read = read;
  stmtUi.items = statementItems(parsed, recon);
  // Not opened from a wallet: remembered pick first, else first-time auto-match.
  stmtResolveWallet(parsed);
  stmtEl("stmt-pick").hidden = true;
  stmtEl("stmt-password").hidden = true;
  if (!parsed.rows.length) { stmtSay(tr("No transactions found in this statement.")); stmtCloudRefresh(); return parsed; }
  stmtSay("");
  stmtEl("stmt-review").hidden = false;
  stmtEl("stmt-import").hidden = false;
  renderStatementReview();
  stmtRunAi(stmtUi.items);
  return parsed;
}

function stmtSummaryText(parsed, recon) {
  const dates = parsed.rows.map((r) => r.date).filter(Boolean).sort();
  const span = dates.length ? `${stmtFmtDate(dates[0])} – ${stmtFmtDate(dates[dates.length - 1])}` : "";
  const what = parsed.bank ? tr(parsed.kind === "card" ? "{bank} card" : "{bank} account", { bank: parsed.bank }) : tr("Statement");
  const page = recon.problems[0] && recon.problems[0].page;
  const check = recon.status === "ok" ? tr("Checks out ✓")
    : recon.status === "none" ? tr(parsed.scanned ? "No balances printed to check, so a scan can't be imported" : "No balances printed to check")
    : page ? tr("Doesn't add up on page {n} — check the rows", { n: page }) : tr("Doesn't add up — check the rows");
  return [what, span, parsed.aiPlus ? tr("Read by Duitful AI+ (cloud)") : parsed.scanned ? tr("Read from a scan") : "", check].filter(Boolean).join(" · ");
}

function renderStatementReview() {
  const list = stmtEl("stmt-list");
  if (!list || !stmtUi.parsed) return;
  const sum = stmtEl("stmt-summary");
  sum.textContent = stmtSummaryText(stmtUi.parsed, stmtUi.recon);
  sum.dataset.status = stmtUi.recon.status;
  if (stmtUi.parsed.aiPlus) sum.insertAdjacentHTML("beforeend", ` <span class="ai-plus-badge" translate="no">AI+</span>`);
  stmtCloudRefresh();
  stmtRenderWallet();
  const cats = typeof scanAllCategories === "function" ? scanAllCategories() : [];
  const debts = (typeof state !== "undefined" && state && state.debts) || [];
  const expenses = (typeof state !== "undefined" && state && state.expenses) || [];

  list.innerHTML = stmtUi.items.map((it, i) => {
    const sign = it.kind === "income" ? "+" : (it.kind === "spend" || it.kind === "debt" || it.kind === "bill") ? "−" : "";
    const tag = it.note ? `<span class="stmt-tag">${escapeHtml(it.note)}</span>` : it.flagged ? `<span class="stmt-tag is-warn">${tr("Check this row")}</span>` : "";
    const catSel = it.kind === "spend"
      ? `<select data-stmt-cat="${i}" aria-label="${tr("Category")}" translate="no">${["", ...cats].map((c) => `<option value="${escapeHtml(c)}"${c === it.category ? " selected" : ""}>${c ? escapeHtml(c) : tr("Category")}</option>`).join("")}</select>` : "";

    let targetSel = "";
    let reconBar = "";
    if (it.kind === "debt" && debts.length) {
      targetSel = `<select data-stmt-target="${i}" aria-label="${tr("Debt")}">${debts.map((d) => `<option value="${escapeHtml(d.id)}"${d.id === it.debtId ? " selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}</select>`;
      const linked = debts.find((d) => d.id === it.debtId);
      const pillText = linked ? tr("Reconciles debt: {name}", { name: linked.name }) : tr("Pay debt");
      reconBar = `<div class="stmt-recon"><span class="stmt-link-pill is-debt">↓ ${escapeHtml(pillText)}</span><button type="button" class="stmt-override-btn" data-stmt-override="${i}">${tr("Log as spend")}</button></div>`;
    } else if (it.kind === "bill" && expenses.length) {
      const ym = (it.date || "").slice(0, 7);
      const { bills } = stmtBillsForMonth(expenses, ym);
      const billOpts = bills.length ? bills : expenses;
      targetSel = `<select data-stmt-target="${i}" aria-label="${tr("Recurring bill")}">${billOpts.map((b) => `<option value="${escapeHtml(b.id)}"${b.id === it.billId ? " selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}</select>`;
      const linked = billOpts.find((b) => b.id === it.billId) || expenses.find((b) => b.id === it.billId);
      const planned = linked ? Number(linked.plannedAmount ?? linked.amount) : Number(it.billPlanned);
      const diffNote = Number.isFinite(planned) && Math.abs(planned - it.amount) >= 0.01
        ? ` · ${tr("this month only (template stays {a})", { a: fmtMoney(planned) })}`
        : "";
      const pillText = linked ? `${tr("Marks bill paid: {name}", { name: linked.name })}${diffNote}` : tr("Mark bill paid");
      reconBar = `<div class="stmt-recon"><span class="stmt-link-pill is-bill">✓ ${escapeHtml(pillText)}</span><button type="button" class="stmt-override-btn" data-stmt-override="${i}">${tr("Log as spend")}</button></div>`;
    }

    const debtOpt = (debts.length || it.kind === "debt")
      ? `<option value="debt"${it.kind === "debt" ? " selected" : ""}>${tr("Pay debt")}</option>` : "";
    const billOpt = (expenses.length || it.kind === "bill")
      ? `<option value="bill"${it.kind === "bill" ? " selected" : ""}>${tr("Mark bill paid")}</option>` : "";

    return `<li class="stmt-row${it.on ? "" : " is-off"}${it.flagged ? " is-flagged" : ""}${it.kind === "debt" || it.kind === "bill" ? " is-linked" : ""}">
      <input type="checkbox" data-stmt-on="${i}" aria-label="${tr("Import {name}", { name: escapeHtml(it.payee) })}"${it.on ? " checked" : ""}${it.kind === "move" ? " disabled" : ""} />
      <div class="stmt-main">
        <div class="stmt-top">
          <input class="stmt-payee" data-stmt-payee="${i}" value="${escapeHtml(it.payee)}" aria-label="${tr("Payee")}" />${it.ai || it.aiPlus ? stmtAiTag(it) : ""}
          ${stmtUi.parsed.scanned
            ? `<input class="stmt-amt-in ${it.kind}" data-stmt-amt="${i}" inputmode="decimal" value="${it.amount.toFixed(2)}" aria-label="${tr("Amount")}" />`
            : `<span class="stmt-amt ${it.kind}">${sign}${escapeHtml(fmtMoney(it.amount))}</span>`}
        </div>
        ${reconBar}
        <div class="stmt-meta">
          <span>${escapeHtml(stmtFmtDate(it.date))}</span>
          <select data-stmt-kind="${i}" aria-label="${tr("Type")}">
            <option value="spend"${it.kind === "spend" ? " selected" : ""}>${tr("Spend")}</option>
            ${debtOpt}${billOpt}
            <option value="income"${it.kind === "income" ? " selected" : ""}>${tr("Income")}</option>
            <option value="move"${it.kind === "move" ? " selected" : ""}>${tr("Not counted")}</option>
          </select>
          ${catSel}${targetSel}${tag}
          ${stmtUi.parsed.scanned && it.flagged && it.row.balance != null
            ? `<label class="stmt-bal">${tr("Balance")} <input data-stmt-bal="${i}" inputmode="decimal" value="${it.row.balance.toFixed(2)}" /></label>` : ""}
        </div>
      </div>
    </li>`;
  }).join("");
  const on = stmtUi.items.filter((x) => x.on && x.kind !== "move").length;
  const blocked = stmtScanBlocked();
  stmtEl("stmt-count").textContent = blocked ? tr("Fix the figures that don't match the scan to import") : tr("{n} to import", { n: on });
  const btn = stmtEl("stmt-import");
  btn.disabled = !on || blocked;
  btn.textContent = on ? tr("Import {n}", { n: on }) : tr("Import");
  stmtEl("stmt-all").textContent = stmtUi.items.every((x) => x.on || x.kind === "move") ? tr("Untick all") : tr("Select all");
  if (typeof renderFreeCounts === "function") renderFreeCounts();
}

// One wallet question per import: a picker, or a line naming the wallet the
// import was opened from. No wallets: neither.
function stmtRenderWallet() {
  const field = stmtEl("stmt-wallet-field");
  const fixed = stmtEl("stmt-wallet-fixed");
  const hint = stmtEl("stmt-wallet-hint");
  if (!field || !fixed) return;
  const has = typeof activeWallets === "function" && activeWallets().length > 0;
  const w = stmtUi.wallet && typeof walletById === "function" ? walletById(stmtUi.wallet) : null;
  fixed.hidden = !(stmtUi.fixed && w);
  if (!fixed.hidden) fixed.textContent = tr("Into {name}", { name: w.name });
  field.hidden = !has || !fixed.hidden;
  if (!field.hidden) {
    const sel = stmtEl("stmt-wallet");
    sel.innerHTML = walletOptions(stmtUi.wallet);
    sel.value = w ? w.id : "";
  }
  if (hint) {
    const showHint = !field.hidden && !!stmtUi.walletAuto && !!w;
    hint.hidden = !showHint;
    if (showHint) {
      hint.textContent = tr("Matched to {bank} — change if needed", { bank: (stmtUi.parsed && stmtUi.parsed.bank) || w.name });
    }
  }
}

/* A scan imports only when its figures add up: OCR can misread a digit and
   nothing else would catch it. */
function stmtScanBlocked() {
  return !!(stmtUi.parsed && stmtUi.parsed.scanned && (!stmtUi.recon || stmtUi.recon.status !== "ok"));
}
function stmtRecheck() {
  stmtUi.recon = reconcileStatement(stmtUi.parsed);
  for (const it of stmtUi.items) it.flagged = stmtUi.recon.badRows.has(it.row);
}

function statementImportNow() {
  if (!stmtUi.parsed) return false;
  if (stmtScanBlocked()) return false;
  if (typeof canImportStatement === "function" && !canImportStatement()) { openPaywall("statements"); return false; }
  const res = importStatementItems(stmtUi.items, stmtUi.parsed.bank, stmtUi.wallet);
  const total = res.spends + res.incomes + res.debts + res.bills;
  if (!total) return false;          // nothing booked: not counted
  if (typeof trackStatementImport === "function") trackStatementImport();
  rememberStatement(stmtUi.parsed, stmtUi.wallet);
  if (typeof requestReschedule === "function") requestReschedule();
  save();
  renderAll();
  stmtEl("stmt-dialog")?.close();
  if (typeof kiraPlaySaveFeedback === "function") kiraPlaySaveFeedback();
  if (res.debts || res.bills) {
    const parts = [];
    if (res.spends) parts.push(trn(res.spends, "{n} spend", "{n} spends"));
    if (res.debts) parts.push(trn(res.debts, "{n} debt paid", "{n} debts paid"));
    if (res.bills) parts.push(trn(res.bills, "{n} bill paid", "{n} bills paid"));
    if (res.incomes) parts.push(trn(res.incomes, "{n} income", "{n} incomes"));
    toast(tr("Reconciled from statement: {summary}", { summary: parts.join(", ") }));
  } else {
    toast(trn(total, "{n} row imported from the statement", "{n} rows imported from the statement"));
  }
  return true;
}

stmtEl("btn-stmt-import")?.addEventListener("click", openStatementImport);
stmtEl("btn-stmt-import-daily")?.addEventListener("click", openStatementImport);
stmtEl("stmt-nudge-later")?.addEventListener("click", () => {
  const key = stmtEl("stmt-nudge")?.dataset.key;
  const rec = state && (state.statementLast || []).find((x) => x.key === key);
  if (rec) { rec.skipped = rec.end; save(); }
  renderStatementNudge();
  if (typeof renderCaptureIntro === "function") renderCaptureIntro();
  if (typeof requestReschedule === "function") requestReschedule();
});
stmtEl("stmt-nudge-import")?.addEventListener("click", () => openStatementImport());
stmtEl("stmt-choose")?.addEventListener("click", () => stmtEl("stmt-file")?.click());
stmtEl("stmt-file")?.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  const photos = files.filter((f) => /^image\//.test(f.type || ""));
  const pdf = files.find((f) => !/^image\//.test(f.type || ""));
  if (pdf) statementFromFile(pdf).catch(() => stmtSay(tr("Couldn't read this PDF.")));
  else if (photos.length) statementFromPhotos(photos).catch(() => stmtSay(tr("Couldn't read these photos.")));
});
stmtEl("stmt-scan")?.addEventListener("click", async () => {
  const kit = typeof duitfulKit === "function" ? duitfulKit("scanDocument") : null;
  if (!kit) { stmtEl("stmt-file")?.click(); return; }
  try {
    const res = await kit.scanDocument({
      allowGallery: true, pageLimit: STMT_SCAN_MAX_PAGES,
      labels: { title: tr("Scan pages"), camera: tr("Scan with camera"), photo: tr("Choose photo"), cancel: tr("Cancel") },
    });
    const pages = res && Array.isArray(res.images) ? res.images.filter((s) => typeof s === "string" && s.startsWith("data:image/")) : [];
    if (pages.length) await statementFromPhotos(pages);
  } catch (err) {
    if (!(err && err.code === "CANCELLED")) stmtSay(tr("Couldn't read these photos."));
  }
});
stmtEl("stmt-pw-open")?.addEventListener("click", () => {
  const pw = stmtEl("stmt-pw");
  const value = pw ? pw.value : "";
  if (pw) pw.value = "";                       // never kept
  if (stmtUi.file && value) statementFromFile(stmtUi.file, value).catch(() => stmtSay("Couldn't read this PDF."));
});
stmtEl("stmt-pw")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); stmtEl("stmt-pw-open")?.click(); } });
stmtEl("stmt-cancel")?.addEventListener("click", () => { stmtUi.file = null; stmtEl("stmt-dialog")?.close(); });
stmtEl("stmt-cloud-read")?.addEventListener("click", () => { statementCloudRead(); });
stmtEl("stmt-import")?.addEventListener("click", statementImportNow);
stmtEl("stmt-wallet")?.addEventListener("change", (e) => {
  stmtUi.wallet = e.target.value;
  stmtUi.walletAuto = false;
  const hint = stmtEl("stmt-wallet-hint");
  if (hint) hint.hidden = true;
});
stmtEl("stmt-all")?.addEventListener("click", () => {
  const all = stmtUi.items.every((x) => x.on || x.kind === "move");
  for (const it of stmtUi.items) if (it.kind !== "move" && it.date) { it.on = !all; it.userOn = true; }
  renderStatementReview();
});
stmtEl("stmt-list")?.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("[data-stmt-override]") : null;
  if (!btn) return;
  const i = Number(btn.dataset.stmtOverride);
  const it = stmtUi.items[i];
  if (!it) return;
  it.kind = "spend";
  it.userKind = true;
  it.debtId = "";
  it.billId = "";
  it.autoMatched = "";
  if (!it.dup) it.on = true;
  renderStatementReview();
});
stmtEl("stmt-list")?.addEventListener("change", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const i = Number(t.dataset.stmtOn ?? t.dataset.stmtKind ?? t.dataset.stmtCat ?? t.dataset.stmtTarget ?? t.dataset.stmtPayee ?? t.dataset.stmtAmt ?? t.dataset.stmtBal);
  const it = stmtUi.items[i];
  if (!it) return;
  if (t.dataset.stmtOn != null) { it.on = t.checked; it.userOn = true; }
  else if (t.dataset.stmtKind != null) {
    it.kind = t.value;
    it.userKind = true;
    if (it.kind === "debt" && !it.debtId && state && state.debts && state.debts.length) {
      it.debtId = state.debts[0].id;
    } else if (it.kind === "bill" && !it.billId && state && state.expenses && state.expenses.length) {
      const { bills } = stmtBillsForMonth(state.expenses, (it.date || "").slice(0, 7));
      const pick = bills[0] || state.expenses[0];
      if (pick) { it.billId = pick.id; it.billName = pick.name; it.billPlanned = Number(pick.plannedAmount ?? pick.amount) || 0; }
    }
    if (it.kind === "move") it.on = false;
    else if (!it.dup) it.on = true;
  }
  else if (t.dataset.stmtTarget != null) {
    it.userTarget = true;
    if (it.kind === "debt") {
      it.debtId = t.value;
    } else if (it.kind === "bill") {
      it.billId = t.value;
      const b = (state && state.expenses || []).find((x) => x.id === t.value);
      if (b) { it.billName = b.name; it.billPlanned = Number(b.plannedAmount ?? b.amount) || 0; }
    }
  }
  else if (t.dataset.stmtCat != null) { it.category = t.value; it.userCat = true; }
  else if (t.dataset.stmtPayee != null) { it.payee = t.value.trim().slice(0, 60); it.userPayee = true; }
  else if (t.dataset.stmtAmt != null || t.dataset.stmtBal != null) {
    // Corrections on a scan: the user's figure, then the same check again.
    const v = t.value.trim() ? stmtMoney(t.value) : NaN;
    if (Number.isFinite(v) && v >= 0) {
      if (t.dataset.stmtAmt != null) { it.amount = v; it.row.amount = v; } else it.row.balance = v;
      stmtRecheck();
    }
  }
  renderStatementReview();
});
