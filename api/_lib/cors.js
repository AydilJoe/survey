// CORS for endpoints the native apps call. The Capacitor shells load the app
// from a local origin, not duitful.app: capacitor://localhost on iOS,
// https://localhost on Android. A WebView enforces CORS like a browser, so an
// endpoint that answers only APP_BASE_URL (or sends no header at all) is
// unreachable from the phone apps, and fetch just fails quietly.
//
// cors(req, res, methods) sets the headers and returns true when it has
// answered an OPTIONS preflight, so the handler can return straight away.
const NATIVE_ORIGINS = ["capacitor://localhost", "ionic://localhost", "https://localhost", "http://localhost"];

function allowedOrigin(origin, base) {
  if (!base) return "*";
  if (origin && (origin === base || NATIVE_ORIGINS.includes(origin))) return origin;
  return base;
}

function cors(req, res, methods) {
  const origin = (req.headers && req.headers.origin) || "";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin(origin, process.env.APP_BASE_URL));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

module.exports = { cors, allowedOrigin, NATIVE_ORIGINS };
