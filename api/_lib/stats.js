// Shared stats helpers for admin + creator dashboards.
// All numbers stay in sen internally; UI converts to RM.

const crypto = require("crypto");
const { CODES } = require("./discounts");

const DEFAULT_COMMISSION_RM = 5;

function refToCreator(ref) {
  // Match a discount entry whose referrerCode equals this ref — that
  // gives us the creator name + commission override. If no match, this
  // is a plain Pro-user referral (RM 5 default).
  for (const [codeName, rule] of Object.entries(CODES)) {
    if (rule && rule.referrerCode === ref) {
      return {
        creatorName: rule.creator || rule.description || codeName,
        code: codeName,
        commissionRm: Number.isFinite(rule.commission) ? rule.commission : DEFAULT_COMMISSION_RM,
      };
    }
  }
  return { creatorName: null, code: null, commissionRm: DEFAULT_COMMISSION_RM };
}

function groupByRef(bills) {
  const groups = new Map();
  for (const bill of bills) {
    const ref = String(bill.reference_2 || "").trim().toLowerCase();
    if (!ref) continue;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(bill);
  }
  return groups;
}

function summarizeBills(bills) {
  let salesSen = 0;
  let lastPaidAt = "";
  for (const b of bills) {
    const amt = Number(b.paid_amount || b.amount) || 0;
    salesSen += amt;
    const p = String(b.paid_at || "");
    if (p > lastPaidAt) lastPaidAt = p;
  }
  return { salesSen, lastPaidAt, count: bills.length };
}

function statsForRef(ref, bills) {
  const { creatorName, code, commissionRm } = refToCreator(ref);
  const sum = summarizeBills(bills);
  const commissionOwedSen = sum.count * Math.round(commissionRm * 100);
  return {
    ref,
    creatorName,
    code,
    commissionRm,
    paidCount: sum.count,
    totalSalesSen: sum.salesSen,
    commissionOwedSen,
    lastPaidAt: sum.lastPaidAt,
  };
}

// HMAC-SHA256(ref, ADMIN_KEY).slice(0,16). Stable per ref. Lets us
// hand out /tools/my-stats/?ref=abc&token=xxx URLs that creators can
// visit to see their own stats without needing the admin key.
function signStatsToken(ref) {
  const secret = process.env.ADMIN_KEY;
  if (!secret) throw new Error("ADMIN_KEY not set");
  return crypto.createHmac("sha256", secret).update(String(ref).toLowerCase().trim()).digest("hex").slice(0, 16);
}

function verifyStatsToken(ref, token) {
  try {
    const expected = signStatsToken(ref);
    if (!token || expected.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch { return false; }
}

module.exports = {
  DEFAULT_COMMISSION_RM,
  refToCreator,
  groupByRef,
  statsForRef,
  summarizeBills,
  signStatsToken,
  verifyStatsToken,
};
