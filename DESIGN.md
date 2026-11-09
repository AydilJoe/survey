---
name: Duitful
description: A warm paper ledger for Malaysian money, where colour states the size of a number and nothing else.
colors:
  stage: "#e9e1d3"
  bg: "#efe9dd"
  card: "#f9f5ed"
  card-strong: "#fbf8f2"
  card-soft: "#f2ece0"
  text: "#241f1a"
  ink2: "#574e45"
  muted: "#6e6458"
  primary: "#1c2b38"
  primary-hover: "#101c27"
  brand: "#c8704b"
  brand-ink: "#a65533"
  gain: "#3d6f45"
  loss: "#bd3a42"
  danger-hover: "#a82e35"
  over-neon: "#ff2740"
  warn: "#a8631a"
  accent-sage: "#6f9457"
  accent-cool: "#5b7f9e"
  accent-tan: "#c99a68"
  accent-caramel: "#a5805f"
  rm1: "#2b5faa"
  rm5: "#2e7d4f"
  rm10: "#b8362f"
  rm20: "#c96a1e"
  rm50: "#0f7f8c"
  rm100: "#6a4193"
  border: "rgba(36, 31, 26, 0.15)"
  line: "rgba(36, 31, 26, 0.09)"
  stage-dark: "#131110"
  bg-dark: "#191614"
  card-dark: "#221e1a"
  card-soft-dark: "#2b2622"
  text-dark: "#f3ede1"
  ink2-dark: "#c4bdb0"
  muted-dark: "#a8a097"
  primary-dark: "#e8d5b9"
  brand-dark: "#dd8a63"
  gain-dark: "#7eaa7e"
  loss-dark: "#e07277"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "2.75rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.2px"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.1px"
  figure:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.45
  code:
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace"
    fontSize: "0.9em"
    fontWeight: 400
    letterSpacing: "0.04em"
rounded:
  xs: "3px"
  sm: "8px"
  md: "14px"
  pill: "999px"
spacing:
  xs: "0.35rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.2rem"
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.card}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0.7rem 1rem"
  button-primary-hover:
    backgroundColor: "#1f1a17"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink2}"
    rounded: "{rounded.sm}"
    padding: "0.45rem 0.7rem"
  button-ghost-hover:
    backgroundColor: "{colors.card-soft}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.loss}"
    rounded: "{rounded.sm}"
    padding: "0.7rem 1rem"
  button-danger-hover:
    backgroundColor: "{colors.loss}"
    textColor: "#ffffff"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "1rem"
  input:
    backgroundColor: "{colors.card-soft}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0.75rem 0.85rem"
  chip:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink2}"
    rounded: "{rounded.pill}"
    padding: "0.45rem 0.75rem"
  chip-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.card}"
  tab-active-icon:
    backgroundColor: "rgba(200, 112, 75, 0.2)"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.pill}"
    height: "28px"
---

# Design System: Duitful

This file describes the app in `app/` (web, PWA and the Capacitor shell). `app/styles.css` is the implementation; the `:root` block at its top holds every token, with the dark values in the two blocks under it. The landing page, guides and `/split` page have their own stylesheets and are not covered here.

## Overview

**Creative North Star: "The Ringgit Ledger"**

Duitful looks like a household ledger kept on warm paper. The page is a cream stock, the writing is near-black ink, and the cards are slightly whiter sheets laid on top. Almost nothing is coloured. That restraint has a purpose: the user is reading their own money, often with some worry, and a calm page lets the few coloured marks mean something.

The colour that does appear is borrowed from the Malaysian banknote series. A blue mark is an RM 1 sized amount, green RM 5, red RM 10, orange RM 20, teal RM 50, purple RM 100 and above. Every user already reads that scale without a legend, so it carries the size of a number at a glance. Terracotta, the colour of the wallet logo, marks where you are and what has focus. Red is reserved for trouble.

Density is a phone ledger: one column of cards, rows separated by hairlines, figures right-aligned in tabular digits. On wider screens the same cards flow into columns and navigation moves to the side; the cards themselves do not change.

**Key Characteristics:**
- Warm paper surfaces in three steps (stage, background, card), in light and in dark.
- Ink for text and for every action. No coloured buttons.
- Banknote hues carry amount size and nothing else.
- Terracotta for identity, location and focus only.
- Red only when something is actually wrong.
- One serif moment per screen: the wordmark and the balance.
- Flat cards with hairline borders; shadows are reserved for things that float.

## Colors

A near-monochrome warm palette, with three small sets of chroma that each have one job.

### Primary
- **Ledger Ink** (`text`, `text-dark`): body text and the fill of the primary button. In light mode the button is ink on paper; in dark mode it inverts to **Warm Sand** (`primary-dark`) with the background colour as its label, so the primary action is always the highest-contrast thing on the surface.
- **Ink Navy** (`primary`, `primary-hover`): the interactive tint in light mode. Selected filter chips fill with it, checkboxes and radios take it as their accent, today's calendar cell is outlined in it, and soft "selected" washes are a percentage of it. In dark mode the same token resolves to Warm Sand.

### Secondary
- **Terracotta** (`brand`, `brand-dark`): the wallet mark, the active tab's icon pill, the selected entry type, the spending-calendar heat ramp (14 / 28 / 44 / 60% over the card), search highlights. Used as a fill or tint.
- **Terracotta Ink** (`brand-ink`): the same hue darkened to pass contrast as a line. Focus rings, active-tab glyphs, small inline links that need to stand out.

### Tertiary
- **Banknote scale** (`rm1`, `rm5`, `rm10`, `rm20`, `rm50`, `rm100`): amount size. The thresholds live in `denomToken()` in `app/script.js`: up to RM 1, 5, 10, 20, 50, then everything above. Each has a brightened dark-mode value in `styles.css`.
- **Money Green** (`gain`) and **Trouble Red** (`loss`): a positive balance or incoming money; an overspend, an overdue payment or a negative balance. `over-neon` is the hotter alarm used only on a blown budget bar.
- **Amber** (`warn`): attention without alarm, such as a payment due soon or an OCR total to double-check.
- **Sage, Slate, Tan, Caramel** (`accent-sage`, `accent-cool`, `accent-tan`, `accent-caramel`): quiet category accents. Sage for savings and progress bars, Slate for Pro, Drive and licence tags, Tan and Caramel for instalment badges and the gradient on a few feature cards.

### Neutral
- **Stage, Paper, Sheet** (`stage`, `bg`, `card`, plus `card-strong` for the balance card and `card-soft` for inputs and hovers): the three surface steps. Dark mode keeps the same three steps in warm near-black (`stage-dark`, `bg-dark`, `card-dark`).
- **Second Ink and Muted** (`ink2`, `muted`): secondary text and captions. Both pass 4.5:1 on a card in both themes.
- **Hairlines** (`line`, `border`): row dividers and card or control outlines, drawn as transparent ink so they sit correctly on any surface step.

### Named Rules
**The Banknote Rule.** Chroma states the size of a number. If a colour is not telling the user how big an amount is, where they are, or that something is wrong, it should be ink.

**The Trouble Rule.** Red means trouble. Having a debt is not an error, so debt totals and upcoming payments are plain ink. Overdue, overspent and negative are red.

**The Token Tint Rule.** Soft washes are written as `color-mix(in srgb, var(--token) N%, transparent)`, never as a literal `rgba()` of the light value. A literal navy tint disappears on a dark card.

## Typography

**Display Font:** Fraunces (with Georgia, serif)
**Body Font:** Inter (with the system sans stack)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, Menlo)

**Character:** Inter does nearly all the work, quietly and in three weights (400, 500, 600). Fraunces appears twice per screen at most, which is what lets the balance read as the reason the app exists.

### Hierarchy
- **Display** (Fraunces 500, 2.75rem, line-height 1, -0.04em): the balance on Home. The currency sits at half size and the cents at about 0.38 of it, in muted ink. Steps down to 2.15rem and 1.6rem for 7 and 10 digit figures.
- **Headline** (Fraunces 600, 1.25rem): the Duitful wordmark in the header and on the lock screen. Nothing else.
- **Title** (Inter 600, 1.15rem, -0.02em): card headings and subpage titles.
- **Body** (Inter 400, 1rem, line-height 1.5): row names, form values, prose. Row names run at 0.95rem.
- **Figure** (Inter 500, tabular digits, 0.95 to 1.15rem): every ringgit amount. Weight 500, not bold; alignment and tabular digits make the column, not heaviness.
- **Label** (Inter 400 to 600, 0.72 to 0.85rem, muted or second ink): captions, hints, field labels, chips, tab labels (0.82rem / 600).
- **Code** (JetBrains Mono, 0.9em): currency codes such as `MYR`, raw receipt text, licence keys, n-of-m counters.

### Named Rules
**The Scarce Serif Rule.** Fraunces is for the wordmark and the one headline figure. Card titles are Inter.

**The Machine Text Rule.** Monospace is for text a machine produced or will read. Words like "Min payment" or "Instalment" are Inter, even inside a badge.

## Layout

One column of cards on a phone: `main` is capped at 640px with a 0.75rem gutter, cards are 0.85rem apart with 1rem of padding. Inside a card, related controls sit 0.35 to 0.5rem apart and groups 0.75 to 1rem apart.

From 640px the cards flow into a grid (`auto-fill`, 280px minimum column, 1.2rem gap), and the frame widens to 1320px on desktop. Headline cards span the full width.

Navigation follows the screen, not the device:
- **Bottom bar** on a tall phone: five tabs (Home, Monthly, Debts, Savings, Settings).
- **Side rail** (5rem) from 600px wide, or from 440px wide when the screen is shorter than 720px.
- **Sidebar** with labels from 1000px.

The same rule lives in `FoldLab.navFor` in `folds/fold-lab.js`, and the e2e suite checks the two agree. Daily, Reports and Tax are subpages of Home, reached from Home and left with a pill-shaped back button.

Touch targets are at least 44px. Safe-area insets pad the header, the bottom bar and the rail.

## Elevation & Depth

Flat by default. Depth comes from the three paper tones and a hairline border; a card's own shadow is a single 1px contact line that is barely visible. The page backdrop carries faint radial washes of ink, sage and tan in light mode so the paper does not look like a flat fill.

### Shadow Vocabulary
- **Contact** (`0 1px 2px rgba(0,0,0,.05)`): every card at rest.
- **Lift** (`0 1px 2px rgba(42,36,32,.04), 0 8px 24px rgba(42,36,32,.05)`): the lock screen mark and the few things that sit above the page.
- **Sheet** (`0 -10px 40px rgba(42,36,32,.12), 0 1px 3px rgba(42,36,32,.05)`): dialogs and bottom sheets, over a `rgba(42,36,32,.35)` backdrop.
- **Float** (`0 10px 30px rgba(0,0,0,.18)`): toasts and the save-failed banner.

### Named Rules
**The Flat Sheet Rule.** If it scrolls with the page it has no drop shadow. Shadows mean "this is floating above your ledger": dialogs, menus, toasts.

**The One Blur Rule.** The only frosted surface is the bottom tab bar (88% stage colour, 14px blur), because content scrolls underneath it. The `--glass-*` tokens are historical names for solid card colours and do not blur.

## Shapes

Four radii, each with a job. Hairline marks and bars are barely rounded (3px). Things you tap are gently rounded (8px): buttons, tabs, day chips, tiles. Containers are softer (14px): cards, dialogs, inputs, list tiles, toasts. Pills are fully round: amount shortcuts, filters, badges, the active-tab highlight, round icon buttons. Circles stay a literal 50% where the circle is structural, such as avatars and step numbers.

Borders are hairlines (0.5px, rendering as 1px on standard screens) in transparent ink. A debt row carries a 3px left stripe in its banknote hue; that stripe is data, not decoration.

**The Four Radii Rule.** Use `--r-xs`, `--r-sm`, `--r-md` or `--r-pill`. A literal pixel radius is a bug.

## Components

### Buttons
Calm and literal: one filled button per card at most, everything else outlined.
- **Shape:** gently rounded (8px), 0.7rem by 1rem padding, Inter 600 at 0.95rem.
- **Primary:** ink fill with card-coloured label; warm sand with dark label in dark mode.
- **Ghost:** transparent with a hairline border and second-ink label, 0.85rem. Hover fills with `card-soft`.
- **Danger:** outlined in red at rest, fills red on hover or focus. Destructive actions in a row of actions use the ghost-danger variant and are pushed to the far edge.
- **Pressed:** every button scales to 0.98 for 50ms. Background transitions take 150ms ease.
- **Focus:** a 2px terracotta-ink ring, 2px offset, on every focusable control.

### Chips
- **Amount shortcuts and filters:** pills on the card colour with a hairline border and second-ink label (0.82rem / 500).
- **Selected filter:** fills ink navy with a card-coloured label.
- **Entry type (Spend / Pay debt / Save):** larger 14px tiles; the selected one takes a 14% terracotta wash, a terracotta border and a terracotta-ink icon.
- **Day chips and badges:** 8px or pill, tinted from the token that explains them: neutral ink for today, amber for soon, red for late, green for income.

### Cards / Containers
- **Corner Style:** softly rounded (14px).
- **Background:** `card`; the balance card uses `card-strong`.
- **Shadow Strategy:** Contact only. See Elevation.
- **Border:** 0.5px hairline.
- **Internal Padding:** 1rem. Never nest a card in a card; inner groups are list tiles or hairline-separated rows.

### Inputs / Fields
- **Style:** `card-soft` fill, hairline border, 14px radius, 1rem text so iOS does not zoom.
- **Amount fields:** 1.5rem, weight 500, tabular digits.
- **Focus:** 2px terracotta-ink outline and matching border.
- **Error:** message below in red on an 8% red wash with a 25% red hairline.

### Navigation
- **Bottom bar:** frosted stage colour, icon over label. The active tab's icon sits in a terracotta-tinted pill and its label turns full ink; inactive tabs are muted.
- **Rail and sidebar:** same icons; in the sidebar the active row gets a terracotta bar on its leading edge.
- **Header:** the wallet mark in a small card tile, the serif wordmark, a one-line greeting and date, then round search and privacy buttons.

### Balance card (signature)
The first thing on Home. A caption, the month, then the balance in Fraunces, green when positive and red when negative. Under it a thin progress bar of spend against income, the per-day figure to stay on track, and a hairline-separated debt total with the debt-free date. It is the only place the serif figure appears.

### List rows
A name on the left, a tabular figure on the right, a muted meta line under each, hairlines between rows. Row actions are one visible button (Pay, Add) plus a `⋯` menu for Edit and Delete.

## Do's and Don'ts

### Do:
- **Do** read every colour from a token in `:root`, and keep the two dark blocks in `styles.css` identical to each other.
- **Do** write tints as `color-mix()` of a token so they survive the theme switch.
- **Do** use ink for actions. The primary button is `text` on light and warm sand on dark.
- **Do** set amounts in Inter 500 with tabular digits, right-aligned.
- **Do** keep body and caption text at 4.5:1 or better; `ink2` and `muted` are tuned for that on a card.
- **Do** keep touch targets at 44px or more.
- **Do** respect `prefers-reduced-motion`; give every new animation a reduced variant, as the existing ones have.

### Don't:
- **Don't** use a banknote hue, terracotta or red for decoration. Each has one meaning.
- **Don't** colour a debt total or a normal upcoming payment red.
- **Don't** add a radius outside the four, or a drop shadow to anything that scrolls with the page.
- **Don't** set words in monospace, or a second heading in Fraunces.
- **Don't** hard-code a hex or `rgba()` in a component rule, or reference a token that `:root` does not define.
- **Don't** add blur or glass to cards; only the bottom bar is frosted.
- **Don't** put a card inside a card.
