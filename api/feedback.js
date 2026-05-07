// In-app feedback form → GitHub issue.
//
// Receives POST { kind, message, email?, url?, ua?, hp? } from the
// Duitful app and opens a labelled issue against the configured repo
// using a server-held GitHub token. Users never need a GitHub account.
//
// Rate limited per IP via Vercel KV when configured (5 / hour). KV is
// optional — without it the endpoint still works but is unrate-limited.
//
// Required env:
//   GITHUB_TOKEN          fine-scoped PAT or installation token with
//                         `issues: write` on GITHUB_FEEDBACK_REPO
//   GITHUB_FEEDBACK_REPO  e.g. "aydiljoe/duitful"
// Optional env:
//   APP_BASE_URL          for CORS allow-list (default "*")
//   FEEDBACK_LABELS       comma-separated extra labels (default "feedback")
//   KV_REST_API_URL,
//   KV_REST_API_TOKEN     enables per-IP rate limiting

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }
const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const ALLOWED_KINDS = new Set(["bug", "idea", "question", "other"]);
const KIND_LABELS = {
  bug: "bug",
  idea: "enhancement",
  question: "question",
  other: "feedback",
};
const KIND_TITLES = {
  bug: "Bug",
  idea: "Idea",
  question: "Question",
  other: "Feedback",
};

const MAX_MESSAGE = 4000;
const MAX_EMAIL = 200;
const MAX_URL = 500;
const MAX_UA = 400;
const RATE_LIMIT = 5;
const RATE_WINDOW_S = 60 * 60;

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

async function checkRateLimit(ip) {
  if (!HAS_KV) return { ok: true };
  const { kv } = kvModule;
  const key = `feedback:rl:${ip}`;
  try {
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, RATE_WINDOW_S);
    if (count > RATE_LIMIT) return { ok: false, count };
    return { ok: true, count };
  } catch (_) {
    return { ok: true };
  }
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function buildIssueBody({ kind, message, email, url, ua, ip }) {
  const lines = [];
  lines.push(message.trim());
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("<sub>Submitted via Duitful in-app feedback form.</sub>");
  lines.push("");
  if (email) lines.push(`- Reply-to: \`${email}\``);
  if (url) lines.push(`- Page: \`${url}\``);
  if (ua) lines.push(`- User-Agent: \`${ua}\``);
  lines.push(`- Submitted: \`${new Date().toISOString()}\``);
  if (ip && ip !== "unknown") {
    const masked = ip.replace(/\.\d+$/, ".x").replace(/:[0-9a-f]+$/i, ":x");
    lines.push(`- IP (masked): \`${masked}\``);
  }
  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.APP_BASE_URL || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const repo = process.env.GITHUB_FEEDBACK_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.error("feedback: GITHUB_FEEDBACK_REPO or GITHUB_TOKEN unset");
    res.status(503).json({ error: "Feedback is not configured. Please email us instead." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Honeypot: bots fill every field. A non-empty `hp` means spam.
    // Return 200 so they don't retry, but skip the GitHub call.
    if (body.hp) { res.status(200).json({ ok: true }); return; }

    const kind = String(body.kind || "other").toLowerCase();
    if (!ALLOWED_KINDS.has(kind)) {
      res.status(400).json({ error: "Invalid feedback type" });
      return;
    }

    const message = String(body.message || "").trim();
    if (message.length < 5) {
      res.status(400).json({ error: "Please describe your feedback (min 5 chars)" });
      return;
    }
    if (message.length > MAX_MESSAGE) {
      res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE} chars)` });
      return;
    }

    const email = truncate(body.email, MAX_EMAIL).trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }
    const url = truncate(body.url, MAX_URL);
    const ua = truncate(body.ua, MAX_UA);

    const ip = clientIp(req);
    const rl = await checkRateLimit(ip);
    if (!rl.ok) {
      res.status(429).json({ error: "Too many submissions. Please try again later." });
      return;
    }

    const titlePrefix = KIND_TITLES[kind];
    const firstLine = message.split(/\r?\n/)[0].trim();
    const title = `[${titlePrefix}] ${truncate(firstLine, 80)}`;

    const extraLabels = (process.env.FEEDBACK_LABELS || "feedback")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const labels = Array.from(new Set([KIND_LABELS[kind], ...extraLabels]));

    const ghBody = buildIssueBody({ kind, message, email, url, ua, ip });

    const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "duitful-feedback-proxy",
      },
      body: JSON.stringify({ title, body: ghBody, labels }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("feedback: GitHub create issue failed", r.status, detail);
      res.status(502).json({ error: "Could not submit feedback. Please try again." });
      return;
    }

    const issue = await r.json().catch(() => ({}));
    res.status(200).json({ ok: true, number: issue.number, url: issue.html_url });
  } catch (err) {
    console.error("feedback handler threw:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
