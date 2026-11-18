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
];
