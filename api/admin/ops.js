// Seven admin endpoints behind one Vercel Function, addressed as
// /api/admin/ops?op=<name>.
//
// Two constraints meet here. Vercel's Hobby plan builds at most 12 functions
// per deployment, and one file per endpoint had taken api/ past it - the build
// failed outright, so a merged change never went live while the previously
// deployed endpoints kept answering. And a dynamic route (api/admin/[op].js)
// is not a way out: with "trailingSlash": true every request is redirected to
// its slashed form first, which the generated dynamic pattern does not match,
// so the whole admin surface returned Vercel's own NOT_FOUND.
//
// A plain filename plus a query parameter is the shape that demonstrably
// routes here - api/admin/billplz-bill.js has been reading req.query.id in
// production all along. The five endpoints that predate the budget keep their
// own files and their own URLs; these seven share this one.

const ROUTES = {
  "config-check": require("../_lib/admin/config-check.js"),
  "duplicate-payments": require("../_lib/admin/duplicate-payments.js"),
  "mark-refunded": require("../_lib/admin/mark-refunded.js"),
  "native-attributions": require("../_lib/admin/native-attributions.js"),
  "payout-collection": require("../_lib/admin/payout-collection.js"),
  refund: require("../_lib/admin/refund.js"),
  "test-redirect": require("../_lib/admin/test-redirect.js"),
};

module.exports = async function handler(req, res) {
  const raw = (req.query && req.query.op) || "";
  const op = String(Array.isArray(raw) ? raw[0] : raw).trim();
  const route = ROUTES[op];

  if (!route) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({
      error: op ? `Unknown admin op: ${op}` : "Missing ?op=",
      known: Object.keys(ROUTES).sort(),
    });
    return;
  }

  return route(req, res);
};
