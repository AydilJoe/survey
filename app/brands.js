// Brand catalogue for debts — the recognition layer on the Loans & BNPL group.
//
// Why this file exists: the thing that makes a BNPL list readable at a glance
// is not the numbers, it's recognising *which* provider each row is before you
// read anything. That job is done by colour.
//
// Three deliberate constraints:
//
// 1. NO NETWORK. Searching a logo service would ship the user's list of
//    lenders to a third party, which is the single most sensitive fact in the
//    app and flatly contradicts what /split and the landing page promise.
//    Everything here is bundled and matched locally.
//
// 2. NO LOGO ARTWORK IN THIS FILE. A brand *colour* is a weak identifier and
//    naming a service you interoperate with is ordinary descriptive use;
//    reproducing a registered mark is a different question. Rows render as a
//    coloured monogram by default. If a real logo file is dropped into
//    app/brand-logos/<id>.svg the renderer picks it up (see brandLogoUrl), and
//    a user can always attach their own image per debt — but nothing
//    trademarked ships in the repo.
//
// 3. NO GUESSED COLOURS. The curated list below is limited to brands whose
//    colour is unambiguous. Everything else gets a deterministic colour
//    derived from the name, drawn from Duitful's own palette — so an unknown
//    lender looks intentional rather than broken, and two different debts
//    never collide by accident.

const BRAND_FALLBACK_PALETTE = [
  { color: "#d76636", ink: "#ffffff" }, // terracotta
  { color: "#4a6b8f", ink: "#ffffff" }, // slate
  { color: "#7da062", ink: "#ffffff" }, // sage
  { color: "#b08a6a", ink: "#ffffff" }, // caramel
  { color: "#8a6a9c", ink: "#ffffff" }, // plum
  { color: "#4f8b8b", ink: "#ffffff" }, // teal
];

// `match` holds lowercase substrings that should resolve to this brand. They
// are matched against the whole debt name, so "Atome — laptop" still lands on
// Atome. Order matters only for display; scoring happens in brandSearch.
const BRAND_CATALOGUE = [
  // ── BNPL ──
  { id: "atome",     name: "Atome",          color: "#edf64b", ink: "#17181a", group: "BNPL", match: ["atome"] },
  { id: "spaylater", name: "SPayLater",      color: "#ee4d2d", ink: "#ffffff", group: "BNPL", logo: true, match: ["spaylater", "shopee paylater", "shopee"] },
  { id: "grabpay",   name: "GrabPayLater",   color: "#00b14f", ink: "#ffffff", group: "BNPL", logo: true, match: ["grabpaylater", "grab paylater", "grab"] },
  { id: "boost",     name: "Boost PayFlex",  color: "#ee2e24", ink: "#ffffff", group: "BNPL", match: ["boost payflex", "payflex", "boost"] },
  { id: "shopback",  name: "ShopBack PayLater", color: "#ff5c5c", ink: "#ffffff", group: "BNPL", match: ["shopback"] },
  { id: "tng",       name: "Touch 'n Go",    color: "#0f4c9c", ink: "#ffffff", group: "BNPL", match: ["touch n go", "touch 'n go", "tng", "gopinjam"] },

  // ── Banks ──
  { id: "maybank",   name: "Maybank",        color: "#ffc20e", ink: "#17181a", group: "Bank", match: ["maybank", "mae"] },
  { id: "cimb",      name: "CIMB",           color: "#9c0f19", ink: "#ffffff", group: "Bank", match: ["cimb"] },
  { id: "publicbank",name: "Public Bank",    color: "#ce1126", ink: "#ffffff", group: "Bank", match: ["public bank", "pbb"] },
  { id: "rhb",       name: "RHB",            color: "#00539f", ink: "#ffffff", group: "Bank", match: ["rhb"] },
  { id: "hongleong", name: "Hong Leong",     color: "#005eb8", ink: "#ffffff", group: "Bank", match: ["hong leong", "hlb"] },
  { id: "ambank",    name: "AmBank",         color: "#e01a2b", ink: "#ffffff", group: "Bank", match: ["ambank"] },
  { id: "bankislam", name: "Bank Islam",     color: "#006b54", ink: "#ffffff", group: "Bank", match: ["bank islam", "bimb"] },
  { id: "bsn",       name: "BSN",            color: "#e30613", ink: "#ffffff", group: "Bank", match: ["bsn", "bank simpanan"] },
  { id: "hsbc",      name: "HSBC",           color: "#db0011", ink: "#ffffff", group: "Bank", logo: true, match: ["hsbc"] },
  { id: "uob",       name: "UOB",            color: "#005eb8", ink: "#ffffff", group: "Bank", match: ["uob"] },
  { id: "ocbc",      name: "OCBC",           color: "#e60012", ink: "#ffffff", group: "Bank", match: ["ocbc"] },
  { id: "stanchart", name: "Standard Chartered", color: "#0473ea", ink: "#ffffff", group: "Bank", match: ["standard chartered", "stanchart", "scb"] },

  // ── Other credit ──
  { id: "ptptn",     name: "PTPTN",          color: "#003a70", ink: "#ffffff", group: "Loan", match: ["ptptn"] },
  { id: "aeon",      name: "AEON Credit",    color: "#a6228e", ink: "#ffffff", group: "Loan", match: ["aeon"] },
];

function brandById(id) {
  if (!id) return null;
  return BRAND_CATALOGUE.find((b) => b.id === id) || null;
}

// Deterministic so a given name always gets the same colour — across reloads,
// across devices, and across a CSV round-trip where no colour was stored.
function brandAutoColor(name) {
  const s = String(name || "").toLowerCase().trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return BRAND_FALLBACK_PALETTE[h % BRAND_FALLBACK_PALETTE.length];
}

// Up to two characters. Only genuine noise is skipped — legal suffixes and
// conjunctions. "Bank" deliberately is NOT skipped: dropping it turns
// "Bank Islam" into "IS", which nobody reads as Bank Islam, while keeping it
// gives "BI" for the brand and "BR" for a typed "Bank Rakyat pinjaman".
const BRAND_MONOGRAM_SKIP = new Set(["the", "my", "dan", "and", "sdn", "bhd", "berhad"]);

function brandMonogram(name) {
  const words = String(name || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !BRAND_MONOGRAM_SKIP.has(w.toLowerCase()));
  if (!words.length) {
    const bare = String(name || "").trim();
    return bare ? bare.slice(0, 1).toUpperCase() : "?";
  }
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Optional real artwork, resolved at render time rather than stored per debt.
//
// Gated on an explicit `logo: true` in the catalogue rather than on the file
// simply being there. Two reasons, and the second one is the one that bit:
//
//  1. Every branded row would otherwise request a file that ships absent —
//     four BNPL plans means four 404s on every single render.
//  2. The obvious fallback (an <img onerror> that removes itself) does not
//     work here at all: app/index.html sets a CSP with no 'unsafe-inline' in
//     script-src, so inline handlers never fire and the user is left staring
//     at a broken-image glyph where the monogram should be.
//
// So: no flag, no <img>, no request. See app/brand-logos/README.md for how to
// turn one on.
function brandLogoUrl(id) {
  const b = brandById(id);
  return b && b.logo ? `brand-logos/${id}.svg` : "";
}

// Everything the renderer needs for one debt row, from whatever the row
// happens to carry: an explicit brand id, a custom colour, a user image, or
// nothing at all.
function brandResolve(debt) {
  const d = debt || {};
  const name = d.name || "";
  const brand = brandById(d.brand);
  const custom = typeof d.color === "string" && /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : "";
  const auto = brandAutoColor(name);
  const color = brand ? brand.color : (custom || auto.color);
  const ink = brand ? brand.ink : (custom ? brandInkFor(custom) : auto.ink);
  return {
    id: brand ? brand.id : "",
    label: brand ? brand.name : name,
    color,
    ink,
    monogram: brandMonogram(brand ? brand.name : name),
    logo: brand ? brandLogoUrl(brand.id) : "",
    image: typeof d.image === "string" && d.image.startsWith("data:image/") ? d.image : "",
  };
}

// Pick black or white ink for a user-chosen swatch. Uses relative luminance
// rather than a simple average so mid-yellows (which read light) get dark ink.
function brandInkFor(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
  if (!m) return "#ffffff";
  const lin = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return L > 0.45 ? "#17181a" : "#ffffff";
}

// Ranked local search for the name combobox. Prefix hits beat substring hits
// so typing "bo" surfaces Boost before ShopBack.
function brandSearch(query, limit) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  const out = [];
  for (const b of BRAND_CATALOGUE) {
    let best = -1;
    for (const alias of [b.name.toLowerCase(), ...b.match]) {
      const at = alias.indexOf(q);
      if (at < 0) continue;
      const score = at === 0 ? 0 : 1;
      if (best < 0 || score < best) best = score;
    }
    if (best >= 0) out.push({ brand: b, score: best });
  }
  out.sort((a, b) => a.score - b.score || a.brand.name.localeCompare(b.brand.name));
  return out.slice(0, limit || 6).map((x) => x.brand);
}

// Best-effort auto-tag when a debt is created or imported without an explicit
// brand. Only fires on an unambiguous alias hit — a name that matches nothing
// stays unbranded rather than being force-fitted to the nearest thing.
function brandGuess(name) {
  const s = String(name || "").toLowerCase();
  if (!s.trim()) return "";
  let hit = null;
  let hitLen = 0;
  for (const b of BRAND_CATALOGUE) {
    for (const alias of b.match) {
      // Longest alias wins: "shopee paylater" should beat bare "shopee".
      if (s.includes(alias) && alias.length > hitLen) { hit = b; hitLen = alias.length; }
    }
  }
  return hit ? hit.id : "";
}
