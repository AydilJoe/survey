# Duitful landing page

This directory holds the marketing landing page for **Duitful** (duitful.app). It is intentionally separate from the app codebase so it can be deployed independently (Cloudflare Pages, Vercel, Netlify, or GitHub Pages on a custom subdomain).

## Status

**Scaffolded, not built.** The full design brief lives at [`../prompts/landing-page.md`](../prompts/landing-page.md). Paste that into a fresh Claude Code session pointed at this directory to generate the page.

## Expected final files

```
landing/
├── index.html        ← single-page marketing site
├── styles.css        ← (optional — may be inlined in index.html)
├── favicon.svg       ← reuse of the app's wallet mark
├── og-image.svg      ← 1200×630 social preview
└── README.md         ← this file, plus deploy steps once built
```

## Deploy options (pick one after the page is built)

- **Cloudflare Pages** — connect the GitHub repo, build command empty, output directory `landing`, custom domain `duitful.app`. Free tier, fastest edge.
- **Vercel** — same idea, `landing` as the project root. Free hobby tier.
- **Netlify** — drag-and-drop or Git integration, publish directory `landing`.
- **GitHub Pages** — add `.github/workflows/landing-pages.yml` that uploads `landing/` as the artifact. Works but slower to propagate.

## Design system

Single source of truth is `../prompts/landing-page.md`. Do not re-derive palette or typography here — always match the app so users recognise the brand when they arrive.
