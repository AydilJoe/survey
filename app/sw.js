/* Duitful service worker.
 * Scope: /app/. Installed by app/script.js on first load.
 *
 * Strategy:
 *   - Network-first for HTML (so a new deploy is picked up immediately
 *     on the next reload, but we still work offline from cache).
 *   - Cache-first for versioned static assets (styles.css?v=N, script.js?v=N).
 *   - API routes (/api/*) are always bypassed — we never want stale
 *     bill-creation responses or cached license-issue errors.
 *   - Cross-origin requests (Google Fonts, Tesseract CDN) are left to
 *     the browser's HTTP cache.
 */

const VERSION = "2026-04-29-1";
const CACHE = `duitful-${VERSION}`;

const SHELL = [
  "/app/",
  "/app/index.html",
  "/app/styles.css?v=41",
  "/app/script.js?v=52",
  "/app/manifest.webmanifest",
  "/app/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Use {cache: "reload"} so a new SW doesn't pick up a stale browser
    // cache entry for the shell files.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    self.skipWaiting();
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

  const isNavigate = req.mode === "navigate" || req.destination === "document";

  if (isNavigate) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match("/app/")) || new Response("Offline", { status: 503 });
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
