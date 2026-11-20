// Synthetic Borang EA (C.P.8A) forms for the EA scanner tests.
//
// Every name, number and amount here is invented (an employer called
// "SYARIKAT CONTOH SDN BHD", an employee "SITI CONTOH", IC 000000-00-0000).
// The lines follow the printed C.P.8A layout, in Malay and in English, so the
// labels in app/ea-extract.js are exercised; real EA forms never enter the repo.
// Pages are in buildPdf()'s shape: [[x, y, text], …] in A4 points, y up.

const L = 40, A = 470;

function lay(rows) {
  let y = 800;
  const segs = [];
  for (const r of rows) {
    if (r === null) { y -= 6; continue; }
    const [x, text, amount] = typeof r === "string" ? [L, r] : r;
    segs.push([x, y, text]);
    if (amount != null) segs.push([A, y, amount]);
    y -= 14;
  }
  return [segs];
}

export const EA_FIXTURES = {
  // Malay form, YA 2025: items add up to the printed total.
  malay: () => lay([
    [400, "(C.P.8A - Pin. 2023)"],
    [250, "BORANG EA"],
    [90, "PENYATA SARAAN DARIPADA PENGGAJIAN BAGI TAHUN BERAKHIR 31 DISEMBER 2025"],
    "Nama majikan: SYARIKAT CONTOH SDN BHD",
    "A  BUTIRAN PEKERJA",
    "1. Nama penuh pekerja: SITI CONTOH BINTI ABU      No. K.P.: 000000-00-0000",
    null,
    "B  PENDAPATAN PENGGAJIAN, MANFAAT DAN TEMPAT KEDIAMAN",
    [L, "1. (a) Gaji kasar, upah atau gaji cuti (termasuk gaji lebih masa)", "54,000.00"],
    [L, "(b) Fi (termasuk fi pengarah), komisen atau bonus", "6,000.00"],
    [L, "(c) Tip kasar, perkuisit, penerimaan sagu hati atau elaun-elaun lain", "2,400.00"],
    [L, "(d) Cukai Pendapatan yang dibayar oleh Majikan bagi pihak Pekerja", "0.00"],
    [L, "(e) Manfaat Skim Opsyen Saham Pekerja (ESOS)", "0.00"],
    [L, "(f) Ganjaran bagi tempoh dari 01/01/2025 hingga 31/12/2025", "0.00"],
    [L, "3. Manfaat berupa barangan (Nyatakan: Telefon)", "1,200.00"],
    [L, "4. Nilai tempat kediaman (Alamat: Jalan Contoh 1)", "0.00"],
    [L, "5. Bayaran balik daripada Kumpulan Wang Simpanan/Pencen yang tidak diluluskan", "0.00"],
    [L, "6. Pampasan kerana kehilangan pekerjaan", "0.00"],
    "C  PENCEN DAN LAIN-LAIN",
    [L, "1. Pencen", "0.00"],
    [L, "2. Anuiti atau Bayaran Berkala yang lain", "0.00"],
    [L, "JUMLAH", "63,600.00"],
    null,
    "D  JUMLAH POTONGAN",
    [L, "1. Potongan Cukai Bulanan (PCB) yang dibayar kepada LHDNM", "3,180.00"],
    [L, "2. Arahan Potongan CP 38", "0.00"],
    [L, "3. Zakat yang dibayar melalui potongan gaji", "240.00"],
    "4. Jumlah tuntutan potongan oleh pekerja melalui Borang TP1 berkaitan:",
    [L, "(a) Pelepasan", "0.00"],
    [L, "(b) Zakat selain yang dibayar melalui potongan gaji bulanan", "0.00"],
    [L, "5. Jumlah pelepasan bagi anak yang layak", "2"],
    null,
    "E  CARUMAN YANG DIBAYAR OLEH PEKERJA KEPADA KUMPULAN WANG SIMPANAN / PENCEN YANG DILULUSKAN DAN PERKESO",
    "1. Nama Kumpulan Wang: KWSP",
    [L, "Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja)", "6,996.00"],
    [L, "2. PERKESO: Amaun caruman yang wajib dibayar (nyatakan bahagian pekerja sahaja)", "296.25"],
    [L, "F  JUMLAH ELAUN / PERKUISIT / PEMBERIAN / MANFAAT YANG DIKECUALIKAN CUKAI", "0.00"],
  ]),
  // English form, YA 2026: the printed TOTAL is RM500 more than its items,
  // and the PCB line is missing.
  english: () => lay([
    [250, "EA FORM"],
    [70, "STATEMENT OF REMUNERATION FROM EMPLOYMENT FOR THE YEAR ENDED 31 DECEMBER 2026"],
    "Employer: CONTOH TRADING SDN BHD",
    "A  PARTICULARS OF EMPLOYEE",
    "1. Full name of employee: ALI CONTOH BIN ABU      I.C. No.: 000000-00-0000",
    null,
    "B  EMPLOYMENT INCOME, BENEFITS AND LIVING ACCOMMODATION",
    [L, "1. (a) Gross salary, wages or leave pay (including overtime pay)", "45,000.00"],
    [L, "(b) Fees (including director fees), commission or bonus", "3,000.00"],
    [L, "(c) Gross tips, perquisites, awards/rewards or other allowances", "0.00"],
    [L, "(f) Gratuity for the period from 01/01/2026 to 31/12/2026", "0.00"],
    [L, "3. Benefits in kind (Specify: -)", "0.00"],
    [L, "4. Value of living accommodation provided (Address: -)", "0.00"],
    [L, "6. Compensation for loss of employment", "0.00"],
    "C  PENSION AND OTHERS",
    [L, "1. Pension", "0.00"],
    [L, "TOTAL", "48,500.00"],
    null,
    "D  TOTAL DEDUCTION",
    [L, "2. CP 38 deductions", "0.00"],
    [L, "3. Zakat paid via salary deduction", "0.00"],
    null,
    "E  CONTRIBUTIONS PAID BY EMPLOYEE TO APPROVED PROVIDENT / PENSION FUND AND SOCSO",
    "1. Name of Provident Fund: EPF",
    [L, "Amount of compulsory contribution paid (state the employee's share only)", "5,280.00"],
    [L, "2. SOCSO: Amount of compulsory contribution paid (state the employee's share only)", "237.50"],
  ]),
};

// The same page as OCR word boxes (Tesseract's {text, bbox}) on a picture
// twice A4's size, for the photo path with a stubbed OCR engine.
export function eaOcrWords(pages) {
  const out = [];
  for (const [x, y, text] of pages[0]) {
    const x0 = x * 2, y0 = (842 - y) * 2 - 8;
    out.push({ text, bbox: { x0, x1: x0 + String(text).length * 9, y0, y1: y0 + 16 } });
  }
  return out;
}
