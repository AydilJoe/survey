// Every admin endpoint, behind one Vercel Function.
//
// Vercel's Hobby plan builds at most 12 functions per deployment, and one file
// per endpoint under api/ had quietly taken us to 16 — the whole deployment
// failed to build, so a merged change simply never went live while the older
// endpoints kept answering. The handlers now live in api/_lib/admin/ (the
// leading underscore keeps Vercel from building them as functions of their
// own) and this dynamic route dispatches to them.
//
// The URLs are unchanged: /api/admin/<name> still reaches <name>.js.

const ROUTES = {
  "billplz-bill": require("../_lib/admin/billplz-bill.js"),
  bills: require("../_lib/admin/bills.js"),
  "config-check": require("../_lib/admin/config-check.js"),
  coupons: require("../_lib/admin/coupons.js"),
  "duplicate-payments": require("../_lib/admin/duplicate-payments.js"),
  "issue-license": require("../_lib/admin/issue-license.js"),
  "mark-refunded": require("../_lib/admin/mark-refunded.js"),
  "native-attributions": require("../_lib/admin/native-attributions.js"),
  refund: require("../_lib/admin/refund.js"),
  "test-redirect": require("../_lib/admin/test-redirect.js"),
  verify: require("../_lib/admin/verify.js"),
};

// Vercel fills req.query.op from the [op] segment. Fall back to the path so a
// direct invocation (or a rewrite that drops the param) still routes.
function opFrom(req) {
  const fromQuery = req.query && req.query.op;
  if (fromQuery) return String(Array.isArray(fromQuery) ? fromQuery[0] : fromQuery).trim();
  const path = String(req.url || "").split("?")[0].replace(/\/+$/, "");
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)).trim();
}

module.exports = async function handler(req, res) {
  const op = opFrom(req);
  const route = ROUTES[op];

  if (!route) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({
      error: "Unknown admin endpoint",
      op: op || null,
      known: Object.keys(ROUTES).sort(),
    });
    return;
  }

  return route(req, res);
};
