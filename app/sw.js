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

const VERSION = "h-aafb35e8";
const CACHE = `duitful-${VERSION}`;

const SHELL = [
  "/app/",
  "/app/index.html",
  "/app/styles.css?v=7476f1eb",
  "/app/script.js?v=ffaa185c",
  // Languages: registry + boot loader run at startup; packs are precached so
  // switching languages still works offline, without parsing unused packs at boot.
  "/app/i18n-langs.js?v=f1ab937e",
  "/app/i18n-boot.js?v=e8f35f1d",
  "/app/i18n-ms.js?v=85e5f020",
  "/app/i18n-zh.js?v=54d71ee2",
  "/app/i18n.js?v=e94f1821",
  "/app/drive-config.js?v=9aaf242d",
  "/app/drive-sync.js?v=08041907",
  "/app/icloud-sync.js?v=90136797",
  "/app/investments.js?v=39cf34a0",
  "/app/split.js?v=556eb5d9",
  "/app/split-recurring.js?v=05bbaca7",
  "/app/receipt-extract.js?v=20e13371",
  "/app/region.js?v=a54b250e",
  "/app/ea-extract.js?v=0036c413",
  "/app/tax-data.js?v=a4c433a4",
  "/app/tax.js?v=160e7c7a",
  "/app/statement.js?v=746ab802",
  "/app/wallets.js?v=39628be9",
  "/app/recap.js?v=e4c2c931",
  // pdf.js (Apache-2.0) for statement import: injected only when a PDF is
  // picked, precached so it works offline like jsQR.
  "/app/vendor/pdfjs/pdf.min.js?v=978fd1b2",
  "/app/vendor/pdfjs/pdf.worker.min.js?v=38cde531",
  "/app/brands.js?v=73d9f7dc",
  "/app/search.js?v=f1248d18",
  "/app/csv.js?v=82d51210",
  "/app/reports.js?v=6b3b772b",
  "/app/onboarding.js?v=15cab168",
  "/app/kira.js?v=5723febf",
  "/app/streak.js?v=ce95b7ab",
  "/app/voice.js?v=7b834a3c",
  "/app/cloud.js?v=fcd02ad8",
  "/app/capture.js?v=dad0b98c",
  "/app/ai-redact.js?v=e6257012",
  "/app/ai-cloud.js?v=012a9c56",
  "/app/pro.js?v=e947fe52",
  "/app/ocr.js?v=0fe4028c",
  "/app/analytics.js?v=01a6bc4a",
  "/app/theme-boot.js?v=68fa9ffd",
  // Brand marks: tiny (0.3–3 KB each) and drawn on the Debts tab, so they are
  // precached rather than fetched on first paint. Add a line when a new logo
  // ships — an unlisted one still works online, it just pops in offline.
  "/app/brand-logos/spaylater.svg",
  "/app/brand-logos/grabpay.svg",
  "/app/brand-logos/hsbc.svg",
  "/app/vendor/qr/qrcode.js?v=79ec86f8",
  // Precached even though split.js injects it on demand — that is what
  // keeps QR scanning working offline without paying 250 KB on every boot.
  "/app/vendor/qr/jsQR.js?v=aa04ddc2",
  // Pastel theme's rounded font (Nunito, OFL). styles.css only fetches it
  // while Pastel is on; precached so Pastel looks the same offline.
  "/app/vendor/fonts/nunito-latin.woff2?v=ba344451",
  "/app/horizon-light.webp?v=98dc3c9f",
  "/app/horizon-dark.webp?v=56def057",
  "/app/horizon-pastel.webp?v=5db55906",
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
