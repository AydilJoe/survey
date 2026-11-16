// Synthetic bank statements for the statement-import tests.
//
// Every name, number and amount here is invented ("ALI BIN ABU",
// 1234-5678-9012 style accounts). The layouts mimic what the parsers in
// app/statement.js expect from each bank; real statements never enter the
// repo. buildPdf() writes a small uncompressed PDF (Helvetica, one text
// object per segment) and can encrypt it with the standard RC4 40-bit
// handler, so the password path is exercised without any binary fixture.

import { createHash } from "node:crypto";

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const md5 = (...parts) => createHash("md5").update(Buffer.concat(parts)).digest();
function rc4(key, data) {
  const s = [...Array(256).keys()];
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const padPw = (pw) => Buffer.concat([Buffer.from(pw || "", "latin1"), PAD]).subarray(0, 32);
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/* pages: [[ [x, y, text, size?], … ], …] in points (A4 595×842, y up). */
export function buildPdf(pages, { password } = {}) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = objs.length + 1; objs.push(null);
  const pageIds = [];
  const streams = {};
  for (const segs of pages) {
    const content = segs.map(([x, y, t, size]) => `BT /F1 ${size || 8} Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join("\n");
    const cId = add(null); streams[cId] = Buffer.from(content, "latin1");
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${cId} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const id0 = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  let encId = 0, key = null;
  if (password != null) {
    const P = -4;
    const O = rc4(md5(padPw(password)).subarray(0, 5), padPw(password));
    const p4 = Buffer.alloc(4); p4.writeInt32LE(P);
    key = md5(padPw(password), O, p4, id0).subarray(0, 5);
    const U = rc4(key, PAD);
    encId = add(`<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>`);
  }
  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((body, i) => {
    const n = i + 1;
    let buf;
    if (streams[n]) {
      let data = streams[n];
      if (key) {
        const nk = Buffer.alloc(5); nk.writeUIntLE(n, 0, 3); nk.writeUIntLE(0, 3, 2);
        data = rc4(md5(key, nk).subarray(0, 10), data);
      }
      buf = Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    } else {
      buf = Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, "latin1");
    }
    offsets.push(pos); pos += buf.length; chunks.push(buf);
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root ${catId} 0 R${encId ? ` /Encrypt ${encId} 0 R` : ""} /ID [<${id0.toString("hex")}> <${id0.toString("hex")}>] >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "latin1"));
  return Buffer.concat(chunks);
}

// Lines top-down: [[x, text], …] per line, laid out from y=800 every `lh` points.
function sheet(lines, lh = 12) {
  const segs = [];
  lines.forEach((line, i) => { for (const [x, t] of line) segs.push([x, 800 - i * lh, t]); });
  return segs;
}

/* Maybank credit card: posting dd/mm, transaction dd/mm, description, location,
   amount with "CR" for credits; previous balance, totals, SUB TOTAL. */
export function maybankCard() {
  const p1 = sheet([
    [[200, "STATEMENT OF CREDIT CARD ACCOUNT"]],
    [[200, "PENYATA AKAUN KAD KREDIT"], [420, "Malayan Banking Berhad (0000-K)"]],
    [[400, "Page/Halaman"], [500, "001 OF 002"]],
    [[30, "ALI BIN ABU"], [380, "Statement Date/"], [470, "Payment Due Date/"]],
    [[380, "15 OCT 26"], [470, "05 NOV 26"]],
    [[30, "Posting Date /"], [100, "Transaction Date /"], [230, "Transaction Description /"], [480, "Amount(RM) /"]],
    [[180, "ALI BIN ABU"]],
    [[180, "MAYBANK VISA CARD"], [330, ":"], [340, "1234 5678 9012 3456"]],
    [[180, "YOUR PREVIOUS STATEMENT BALANCE"], [500, "1,000.00"]],
    [[35, "16/09"], [100, "16/09"], [180, "RETAIL INTEREST RATE = 15.00%"]],
    [[35, "16/09"], [100, "15/09"], [180, "KEDAI RUNCIT MAJU"], [360, "KUALA LUMPUR MY"], [505, "23.40"]],
    [[35, "19/09"], [100, "17/09"], [180, "PASARAYA CONTOH AP"], [360, "KUALA LUMPUR MY"], [505, "87.15"]],
    [[35, "24/09"], [100, "24/09"], [180, "UTILITI CONTOH-EC"], [360, "BANGSAR MY"], [500, "200.00"]],
  ]);
  const p2 = sheet([
    [[200, "STATEMENT OF CREDIT CARD ACCOUNT"]],
    [[400, "Page/Halaman"], [500, "002 OF 002"]],
    [[30, "Posting Date /"], [100, "Transaction Date /"], [230, "Transaction Description /"], [480, "Amount(RM) /"]],
    [[35, "29/09"], [100, "29/09"], [180, "ALI BIN ABU"], [260, "RPP FUNDS TRANSFER"], [490, "800.00CR"]],
    [[35, "08/10"], [100, "07/10"], [180, "CASH REBATE"], [495, "5.40CR"]],
    [[35, "10/10"], [100, "09/10"], [180, "STREAMING CONTOH"], [360, "PARIS FR"], [505, "45.00"]],
    [[180, "TRANSACTED AMOUNT"], [300, "EUR"], [340, "9.00"]],
    [[35, "15/10"], [100, "15/10"], [180, "FINANCE CHARGES"], [505, "10.00"]],
    [[180, "TOTAL CREDIT THIS MONTH"], [330, "805.40"]],
    [[180, "TOTAL DEBIT THIS MONTH"], [330, "365.55"]],
    [[400, "SUB TOTAL/JUMLAH"], [500, "560.15"]],
  ]);
  // 1,000.00 + 365.55 − 805.40 = 560.15
  return [p1, p2];
}

/* Public Bank card: "DD MON" posting and transaction dates, wrapped second
   description lines, "This month total credit/debit", "Grand total". */
export function publicBankCard() {
  return [sheet([
    [[200, "PENYATA KAD / CARD STATEMENT"]],
    [[380, "TARIKH PENYATA"]],
    [[30, "ALI BIN ABU"], [380, "STATEMENT DATE"], [480, "20 OCT 2026"]],
    [[30, "Posting Date"], [100, "Transaction Date"], [250, "Transaction Description"], [480, "Amount (RM)"]],
    [[150, "VISA PLATINUM 1234 5678 9012 3456 ALI BIN ABU"]],
    [[35, "21 SEP"], [150, "Previous Balance"], [495, "1,200.00"]],
    [[35, "21 SEP"], [100, "05 JAN"], [150, "EBANK BALANCE TRANSFER BT000001 B"], [500, "400.00"]],
    [[150, "INST#3/12 $1200.00"], [270, "050126"]],
    [[35, "26 SEP"], [100, "25 SEP"], [150, "KEDAI BUKU CONTOH"], [505, "55.50"]],
    [[35, "03 OCT"], [100, "03 OCT"], [150, "IBFT PAYMENT RECEIVED - THANK YOU"], [490, "650.00CR"]],
    [[150, "ALI BIN ABU"]],
    [[35, "20 OCT"], [150, "FINANCE CHARGE-18.00%"], [505, "12.80"]],
    [[150, "This month total credit"], [300, "650.00"]],
    [[150, "This month total debit"], [300, "468.30"]],
    [[100, "Jumlah besar untuk akaun ini / Grand total for this account"], [495, "1,018.30"]],
    [[30, "PUBLIC BANK BERHAD 000000000000 (0000-H)"], [480, "PAGE 1 OF 1"]],
  ])];
  // 1,200.00 + 468.30 − 650.00 = 1,018.30
}

/* Alliance Bank card: two accounts on one statement, dd/mm/yy transaction
   then posting date, "CR" after a space, undated interest lines. */
export function allianceCard() {
  return [sheet([
    [[30, "ALI BIN ABU"]],
    [[30, "Statement Date"], [200, "Tarikh Penyata"], [300, "18/10/26"]],
    [[30, "For more info visit www.alliancebank.com.my"]],
    [[30, "Transaction Date"], [110, "Posting Date"], [250, "Transaction Description"], [470, "Amount (RM)"]],
    [[200, "BALANCE TRANSFER"]],
    [[200, "PREVIOUS STATEMENT BALANCE"], [470, "50.00 CR"]],
    [[35, "14/10/26"], [110, "14/10/26"], [200, "PAYMENT - THANK YOU"], [470, "100.00 CR"]],
    [[200, "BALANCE TRANSFER : 1234 5678 9012 0000"]],
    [[35, "02/10/26"], [110, "02/10/26"], [200, "INSTL BT @ 5.99% P.A. (36 MONTHS) 3 OF"], [480, "100.00"]],
    [[200, "CHARGES THIS MONTH: 100.00"]],
    [[200, "VISA INFINITE"]],
    [[200, "PREVIOUS STATEMENT BALANCE"], [470, "2,000.00"]],
    [[200, "INTEREST ON RETAIL TRANSACTION"], [480, "30.00"]],
    [[35, "28/09/26"], [110, "28/09/26"], [200, "PAYMENT - THANK YOU"], [470, "2,000.00 CR"]],
    [[35, "27/09/26"], [110, "29/09/26"], [200, "ONLINE SHOP CONTOH SGP USD1.00"], [485, "4.50"]],
    [[200, "CHARGES THIS MONTH: 4.50"]],
    [[200, "CURRENT BALANCE"], [480, "-15.50"]],
    [[200, "TOTAL MINIMUM PAYMENT"], [480, "0.00"]],
    [[480, "Page 1 of 1"]],
  ])];
  // (−50 + 100 − 100) + (2,000 + 30 − 2,000 + 4.50) = −50 + 34.50 = −15.50
}

/* CIMB card transaction history: multi-line blocks, "dd Mon yyyy" dates,
   amounts as "MYR 1,234. 56" in a Debit or a Credit column, no balances. */
export function cimbCard() {
  const segs = [];
  let y = 800;
  const L = (parts) => { for (const [x, t] of parts) segs.push([x, y, t]); y -= 11; };
  const gap = () => { y -= 30; };
  L([[30, "Account Details and Transaction History"]]);
  gap();
  L([[30, "Posting Date"], [100, "Transaction Date"], [180, "Transaction Details"], [400, "Debit"], [500, "Credit"]]);
  gap();
  L([[180, "TRANSFER / TOP-UP THANK YOU-CLICKS"]]);
  L([[180, "FROM ALI BIN ABU"]]);
  L([[30, "13 Oct 2026"], [100, "13 Oct 2026"], [500, "MYR 1,250. 00"]]);
  L([[180, "Payup"]]);
  L([[180, "Payment Desc"]]);
  gap();
  L([[30, "05 Oct 2026"], [100, "03 Oct 2026"], [180, "Ewallet Topup Contoh KUALA LUMPUR MY"], [400, "MYR 7. 30"]]);
  gap();
  L([[30, "03 Oct 2026"], [100, "01 Oct 2026"], [180, "Online Marketplace Contoh KUALA LUMPUR MY"], [500, "MYR 13. 05"]]);
  gap();
  L([[180, "TELCO CONTOH RPS000000 KUALA LUMPUR"]]);
  L([[30, "19 Sep 2026"], [100, "17 Sep 2026"], [400, "MYR 61. 20"]]);
  L([[180, "MY"]]);
  return [segs];
}

/* A savings account from a bank without its own rules: date, description,
   one amount and a running balance, with opening and closing balances. */
export function genericAccount() {
  return [sheet([
    [[30, "CONTOH BANK BERHAD"], [380, "STATEMENT OF ACCOUNT"]],
    [[30, "ALI BIN ABU"], [380, "Account No 1234-5678-9012"]],
    [[30, "Date"], [100, "Description"], [380, "Amount"], [480, "Balance"]],
    [[100, "OPENING BALANCE"], [480, "1,000.00"]],
    [[30, "01/10/2026"], [100, "SALARY CONTOH SDN BHD"], [380, "3,000.00"], [480, "4,000.00"]],
    [[30, "03/10/2026"], [100, "KEDAI RUNCIT MAJU"], [380, "45.20"], [480, "3,954.80"]],
    [[30, "05/10/2026"], [100, "TRANSFER TO ALI BIN ABU"], [380, "500.00"], [480, "3,454.80"]],
    [[30, "09/10/2026"], [100, "UTILITI CONTOH"], [380, "120.00"], [480, "3,334.80"]],
    [[100, "CLOSING BALANCE"], [480, "3,334.80"]],
  ])];
}

export const STATEMENT_FIXTURES = { maybankCard, publicBankCard, allianceCard, cimbCard, genericAccount };
