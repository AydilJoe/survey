// Wallets (app/wallets.js): where money sits — the card, the add / detail /
// adjust / move sheets, the pickers on the add forms, the All entries filter
// and the statement wallet pick. [English, Bahasa Melayu, Simplified Chinese].

export const ROWS = [
  // ── Card and list ───────────────────────────────────────────────
  ["Wallets", "Dompet", "钱包"],
  ["Wallet", "Dompet", "钱包"],
  ["Add a wallet", "Tambah dompet", "添加钱包"],
  ["Edit wallet", "Sunting dompet", "编辑钱包"],
  ["Cash, TNG eWallet, MAE, your bank account: add each one to see what's in it.", "Tunai, TNG eWallet, MAE, akaun bank anda: tambah setiap satu untuk lihat bakinya.", "现金、TNG eWallet、MAE、银行账户：逐个添加，就能看到各有多少钱。"],
  ["Move money", "Pindah duit", "转账"],
  ["Import statement", "Import penyata", "导入对账单"],
  ["Show archived", "Tunjuk yang diarkib", "显示已归档"],
  ["Show {n} archived", "Tunjuk {n} yang diarkib", "显示{n}个已归档"],
  ["Hide archived", "Sorok yang diarkib", "隐藏已归档"],
  ["Archived", "Diarkib", "已归档"],
  ["Archive", "Arkib", "归档"],
  ["Bring back", "Guna semula", "恢复"],
  ["{app} alerts", "Notifikasi {app}", "{app}通知"],
  ["Cash", "Tunai", "现金"],
  ["Bank", "Bank", "银行"],
  ["E-wallet", "E-dompet", "电子钱包"],
  ["No wallet", "Tiada dompet", "不指定钱包"],
  ["All wallets", "Semua dompet", "所有钱包"],
  ["Show entries from", "Tunjuk catatan daripada", "显示来自"],
  ["Unlimited wallets", "Dompet tanpa had", "无限钱包"],
  ["No entries from this wallet yet.", "Belum ada catatan daripada dompet ini.", "这个钱包还没有记录。"],

  // ── Add / edit sheet ────────────────────────────────────────────
  ["TNG eWallet, MAE, Maybank savings, Cash…", "TNG eWallet, MAE, simpanan Maybank, Tunai…", "TNG eWallet、MAE、Maybank 储蓄、现金…"],
  ["What's in it now (", "Baki sekarang (", "目前余额 ("],
  ["Entries from today on add to it or take from it.", "Catatan mulai hari ini akan tambah atau tolak baki ini.", "从今天起的记录会加进或扣除这个余额。"],
  ["Balance on", "Baki pada", "余额日期"],
  ["Pick an earlier date to count entries since then.", "Pilih tarikh lebih awal untuk kira catatan sejak itu.", "选择更早的日期，就会计算那天以来的记录。"],
  ["Bank alerts from", "Notifikasi bank daripada", "银行通知来自"],
  ["Captured alerts from this app go to this wallet.", "Notifikasi daripada aplikasi ini masuk ke dompet ini.", "这个应用的通知会记入这个钱包。"],
  ["None", "Tiada", "无"],
  ["Give the wallet a name.", "Beri dompet ini nama.", "请给钱包起个名字。"],
  ["Wallet saved", "Dompet disimpan", "钱包已保存"],
  ["{name} added", "{name} ditambah", "已添加{name}"],
  ["{name} archived. Its entries stay.", "{name} diarkib. Catatannya kekal.", "{name}已归档，记录都保留。"],
  ["{name} is back", "{name} digunakan semula", "{name}已恢复"],

  // ── Detail sheet ────────────────────────────────────────────────
  ["Adjust to actual", "Laras ikut baki sebenar", "按实际余额调整"],
  ["Opening balance", "Baki permulaan", "初始余额"],
  ["Adjusted to actual", "Dilaras ikut baki sebenar", "已按实际余额调整"],
  ["Moved to {name}", "Dipindah ke {name}", "转到{name}"],
  ["Moved from {name}", "Dipindah dari {name}", "从{name}转入"],
  ["Moved out", "Dipindah keluar", "转出"],
  ["Moved in", "Dipindah masuk", "转入"],
  ["Bill", "Bil", "账单"],

  // ── Adjust to actual ────────────────────────────────────────────
  ["What's in it now?", "Berapa bakinya sekarang?", "现在有多少？"],
  ["What's in {name} now?", "Berapa baki {name} sekarang?", "{name}现在有多少？"],
  ["Duitful has {a}.", "Duitful catat {a}.", "Duitful 记录的是 {a}。"],
  ["Actual balance (", "Baki sebenar (", "实际余额 ("],
  ["Already matches.", "Dah sama.", "已经一致。"],
  ["Books an adjustment of {a}. Your entries stay as they are.", "Satu pelarasan {a} dicatat. Catatan anda kekal seperti asal.", "会记一笔 {a} 的调整，你的记录保持不变。"],
  ["Adjusted · {a}", "Dilaras · {a}", "已调整 · {a}"],

  // ── Move money ──────────────────────────────────────────────────
  ["Not counted as spending or income.", "Tidak dikira sebagai perbelanjaan atau pendapatan.", "不算支出，也不算收入。"],
  ["From (wallet)", "Dari", "从"],
  ["To (wallet)", "Ke", "转到"],
  ["Outside your wallets", "Luar dompet anda", "钱包以外"],
  ["Pick two different wallets.", "Pilih dua dompet yang berbeza.", "请选两个不同的钱包。"],
  ["Enter an amount.", "Masukkan jumlah.", "请输入金额。"],
  ["Moved {a} · not counted as spending or income", "{a} dipindah · tidak dikira sebagai perbelanjaan atau pendapatan", "已转 {a} · 不算支出或收入"],
  ["Move", "Pindah", "转账"],

  // ── Statement import ────────────────────────────────────────────
  ["Into which wallet?", "Masuk ke dompet mana?", "记入哪个钱包？"],
  ["Into {name}", "Masuk ke {name}", "记入{name}"],

  // ── Free / Pro ──────────────────────────────────────────────────
  ["{u} of {l} free wallets used", "{u} daripada {l} dompet percuma digunakan", "已用 {u}/{l} 个免费钱包"],
  ["{u} wallets · Free adds up to {l}. Yours stay.", "{u} dompet · Percuma boleh tambah hingga {l}. Yang ada kekal.", "{u} 个钱包 · 免费版最多添加 {l} 个，已有的都保留。"],
  ["Free keeps {n} wallets. Pro keeps every one. Archived wallets don't count.", "Percuma simpan {n} dompet. Pro simpan semuanya. Dompet yang diarkib tidak dikira.", "免费版可用 {n} 个钱包，Pro 不限数量。已归档的不计算在内。"],
  ["wallet", "dompet", "钱包"],
  ["wallets", "dompet", "钱包"],
];
