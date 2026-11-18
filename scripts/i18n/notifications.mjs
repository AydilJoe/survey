// Reminders: the debt, bill and pay-day notifications the phone schedules
// ahead, the browser notifications for what is due today, and the quick-add
// source labels. [English, Bahasa Melayu, Simplified Chinese]. Short enough
// to read on a lock screen.

export const ROWS = [
  // ── Scheduled reminders ─────────────────────────────────────────
  ["Min payment {a}", "Bayaran minimum {a}", "最低还款 {a}"],
  ["Payment due today", "Bayaran perlu dibuat hari ini", "今天要还款"],
  ["{name} — bill due", "{name} — bil perlu dibayar", "{name} — 账单到期"],
  ["Pay day — {name}", "Hari gaji — {name}", "发薪日 — {name}"],
  ["{a} expected", "Dijangka masuk {a}", "预计入账 {a}"],
  // ── Due today (browser) ─────────────────────────────────────────
  ["Owes you {a} — unpaid {n} day", "Berhutang {a} dengan anda — belum bayar {n} hari", "欠你 {a} — {n} 天未还"],
  ["Owes you {a} — unpaid {n} days", "Berhutang {a} dengan anda — belum bayar {n} hari", "欠你 {a} — {n} 天未还"],
  ["Owes you {a} — overdue {n} day", "Berhutang {a} dengan anda — lewat {n} hari", "欠你 {a} — 逾期 {n} 天"],
  ["Owes you {a} — overdue {n} days", "Berhutang {a} dengan anda — lewat {n} hari", "欠你 {a} — 逾期 {n} 天"],
  ["Owes you {a} — due today", "Berhutang {a} dengan anda — perlu bayar hari ini", "欠你 {a} — 今天到期"],
  ["Pay day today — {a} expected", "Hari gaji hari ini — dijangka masuk {a}", "今天发薪 — 预计入账 {a}"],
  ["Due today — {a}", "Perlu bayar hari ini — {a}", "今天到期 — {a}"],
  // ── Quick add sources ───────────────────────────────────────────
  ["Shortcut", "Pintasan", "快捷指令"],
  ["Quick add", "Tambah pantas", "快速添加"],
  // ── Native: quick-add notification (Android), sent by syncNativeStrings ──
  ["Log a spend", "Catat belanja", "记一笔开销"],
  ["Tap Add and type an amount.", "Tekan Tambah dan taip jumlahnya.", "点“添加”，输入金额。"],
  ["Filed when you next open Duitful", "Direkod bila anda buka Duitful nanti", "下次打开 Duitful 时入账"],
  ["From bank alerts · tap to check", "Daripada notifikasi bank · tekan untuk semak", "来自银行通知 · 点一下查看"],
  ["Review", "Semak", "查看"],
  ["{a} added", "{a} ditambah", "已记 {a}"],
  ["That did not look like an amount: \"{x}\". Try 12.50", "Itu bukan jumlah yang sah: \"{x}\". Cuba 12.50", "这不像金额：“{x}”。试试 12.50"],
  ["Type an amount, like 12.50", "Taip jumlah, contohnya 12.50", "输入金额，例如 12.50"],
  ["The always-there \"Log a spend\" notification you can type an amount into.", "Notifikasi \"Catat belanja\" yang sentiasa ada, untuk taip jumlah terus.", "常驻的“记一笔开销”通知，可以直接输入金额。"],
  ["Quick add confirmations", "Pengesahan tambah pantas", "快速添加确认"],
  ["Brief \"saved\" receipts with an Undo, after a quick add.", "Pengesahan ringkas dengan butang Batal, selepas tambah pantas.", "快速添加后的简短确认，可以撤销。"],
  // ── Native: iPhone scan sheet ───────────────────────────────────
  ["Scan with camera", "Imbas dengan kamera", "用相机扫描"],
  ["Choose photo", "Pilih foto", "选择照片"],
  // ── Native: "says they paid" (background check) ─────────────────
  ["{who} says they paid {a}", "{who} kata sudah bayar {a}", "{who} 说已付 {a}"],
  ["Someone", "Seseorang", "有人"],
  ["Split bill", "Bahagi bil", "分账"],
  ["{title} · Open Duitful to confirm", "{title} · Buka Duitful untuk sahkan", "{title} · 打开 Duitful 确认"],
  ["Split payments", "Bayaran bahagi bil", "分账付款"],
  ["When someone says they've paid a bill you split.", "Bila seseorang kata mereka sudah bayar bil yang anda bahagi.", "有人说已付清你分的账单时通知你。"],
];
