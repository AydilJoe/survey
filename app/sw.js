/* Duitful service worker.
 * Scope: /app/. Installed by app/script.js on first load.
 *
 * Strategy:
 *   - Network-first for HTML (so a new deploy is picked up immediately
 *     on the next reload, but we still work offline from cache).
 *   - Network-first for manifest.webmanifest so PWA shortcut changes
 *     reach Chrome's periodic manifest refresh (otherwise users with an
 *     existing home-screen shortcut keep seeing the old shortcut menu
 *     until they remove and re-add the icon).
 *   - Cache-first for versioned static assets (styles.css?v=N, script.js?v=N).
 *   - API routes (/api/*) are always bypassed — we never want stale
 *     bill-creation responses or cached license-issue errors.
 *   - Cross-origin requests (Google Fonts, Tesseract CDN) are left to
 *     the browser's HTTP cache.
 */

const VERSION = "2026-08-04-2";
const CACHE = `duitful-${VERSION}`;

const SHELL = [
  "/app/",
  "/app/index.html",
  "/app/styles.css?v=92",
  "/app/script.js?v=125",
  "/app/drive-config.js?v=2",
  "/app/drive-sync.js?v=2",
  "/app/investments.js?v=3",
  "/app/split.js?v=6",
  "/app/brands.js?v=3",
  // Brand marks: tiny (0.3–3 KB each) and drawn on the Debts tab, so they are
  // precached rather than fetched on first paint. Add a line when a new logo
  // ships — an unlisted one still works online, it just pops in offline.
  "/app/brand-logos/spaylater.svg",
  "/app/brand-logos/grabpay.svg",
  "/app/brand-logos/hsbc.svg",
  "/app/vendor/qr/qrcode.js?v=1",
  // Precached even though split.js injects it on demand — that is what
  // keeps QR scanning working offline without paying 250 KB on every boot.
  "/app/vendor/qr/jsQR.js?v=1",
  "/app/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Use {cache: "reload"} so a new SW doesn't pick up a stale browser
    // cache entry for the shell files.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    // Don't skipWaiting here — the page decides when to swap in the new SW
    // so it can show a "New version" banner first. iOS standalone webclips
    // were the main motivator: without an explicit prompt, the old SW kept
    // serving stale assets when users reopened from the home screen.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Let the browser handle cross-origin and API requests.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // The announcement feed must always be fresh — never serve it cache-first.
  if (url.pathname === "/announcements.json") return;

  const isNavigate = req.mode === "navigate" || req.destination === "document";
  const isManifest = url.pathname === "/app/manifest.webmanifest";

  if (isNavigate || isManifest) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (isNavigate && await caches.match("/app/")) || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      return cached || new Response("Offline", { status: 503 });
    }
  })());
});

// Listen for a SKIP_WAITING message from the page so users can hot-swap
// to a new SW version without closing every tab.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
