// Answers one question: are the Billplz environment variables coherent?
//
// The failure this exists for is silent and looks like two unrelated bugs.
// Billplz runs sandbox and production as entirely separate worlds, each with
// its own api key and its own X-Signature key. Point BILLPLZ_BASE_URL at one
// and leave a key from the other, and you get:
//
//   - getBill returning 404 RecordNotFound for bills that genuinely exist
//   - every buyer landing on "Signature mismatch" after paying
//
// Neither error names the environment, so the two look unconnected. This
// endpoint names it, and probes the api key live so "the key is set" is not
// mistaken for "the key works here".
//
// It never returns a secret. Only booleans, lengths, and what Billplz said.

const crypto = require("crypto");
const { billplzEnv, getBill } = require("../_lib/billplz");

function requireAdmin(req, res) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(500).json({ error: "ADMIN_KEY not configured on the server" });
    return false;
  }
  const given = req.headers["x-admin-key"];
  if (!given || typeof given !== "string") {
    res.status(401).json({ error: "Missing x-admin-key header" });
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Invalid admin key" });
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!requireAdmin(req, res)) return;

  const env = billplzEnv();
  const present = (name) => {
    const v = process.env[name];
    return { set: Boolean(v), length: v ? String(v).length : 0 };
  };

  const vars = {
    BILLPLZ_BASE_URL: { ...present("BILLPLZ_BASE_URL"), value: process.env.BILLPLZ_BASE_URL || null },
    BILLPLZ_API_KEY: present("BILLPLZ_API_KEY"),
    BILLPLZ_X_SIGNATURE: present("BILLPLZ_X_SIGNATURE"),
    BILLPLZ_COLLECTION_ID: { ...present("BILLPLZ_COLLECTION_ID"), value: process.env.BILLPLZ_COLLECTION_ID || null },
    LICENSE_SIGNING_PRIVATE_KEY: present("LICENSE_SIGNING_PRIVATE_KEY"),
    APP_BASE_URL: { ...present("APP_BASE_URL"), value: process.env.APP_BASE_URL || null },
    // Only needed to issue refunds. Its absence is not a broken checkout.
    BILLPLZ_PAYOUT_COLLECTION_ID: { ...present("BILLPLZ_PAYOUT_COLLECTION_ID"), value: process.env.BILLPLZ_PAYOUT_COLLECTION_ID || null, optional: true },
  };

  const problems = [];
  for (const [name, info] of Object.entries(vars)) {
    if (!info.set && !info.optional) problems.push(`${name} is not set`);
  }
  if (!vars.BILLPLZ_PAYOUT_COLLECTION_ID.set) {
    problems.push("BILLPLZ_PAYOUT_COLLECTION_ID is not set — refunds will fail until it is (checkout is unaffected)");
  }
  if (env === "unknown" && vars.BILLPLZ_BASE_URL.set) {
    problems.push("BILLPLZ_BASE_URL is set but is neither billplz.com nor billplz-sandbox.com");
  }

  // Does the api key actually work against THIS base url? A deliberately
  // nonsense bill id is the cheapest probe: 404 proves the key authenticated
  // and the environment answered, 401 proves it did not.
  let apiKeyProbe = { ran: false };
  if (vars.BILLPLZ_API_KEY.set && vars.BILLPLZ_BASE_URL.set) {
    try {
      await getBill("duitful-config-check-nonexistent");
      apiKeyProbe = { ran: true, ok: true, note: "unexpected success — a bill with the probe id exists" };
    } catch (err) {
      const msg = String(err.message || err);
      if (/ 404 /.test(msg)) {
        apiKeyProbe = { ran: true, ok: true, note: `api key authenticated against ${env}` };
      } else if (/ 401 | 403 /.test(msg)) {
        apiKeyProbe = { ran: true, ok: false, note: `api key was REJECTED by ${env} — it likely belongs to the other environment or another account` };
        problems.push(`BILLPLZ_API_KEY is not valid for the ${env} environment`);
      } else {
        apiKeyProbe = { ran: true, ok: false, note: msg.slice(0, 300) };
        problems.push("Could not reach Billplz to check the api key");
      }
    }
  }

  res.status(200).json({
    environment: env,
    vars,
    apiKeyProbe,
    problems,
    // The one thing this endpoint cannot prove. Billplz issues a separate
    // X-Signature key per environment and offers no endpoint to test it, so
    // a wrong one is only visible when a real buyer is redirected — which is
    // the worst possible moment to find out.
    note: env === "unknown"
      ? "Set BILLPLZ_BASE_URL before anything else here can be trusted."
      : `Configured for ${env}. The X-Signature key cannot be verified from here — Billplz has no endpoint for it. If buyers are seeing "Signature mismatch" while this probe passes, BILLPLZ_X_SIGNATURE is the remaining suspect: copy it from the ${env} dashboard.`,
    ok: problems.length === 0,
  });
};
