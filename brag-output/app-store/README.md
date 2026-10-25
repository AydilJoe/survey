# Duitful — App Store preview drafts

Three 22-second portrait previews, 886×1920, 30 fps, H.264 + AAC 48 kHz stereo (`*.mp4`), plus a poster frame (`*-poster.png`) for each.

| File | Story | Captions |
|---|---|---|
| `01-overview.mp4` | Spend → Monthly calendar → debt payoff → savings goal → privacy blur | See what's left this month · Every day, at a glance · Pay off debt in the smartest order · Watch your goals fill up · Hide every ringgit in one tap |
| `02-debt-payoff.mp4` | Avalanche planner: RM 100 then RM 300 extra → debt-free date and interest move live | Three debts. One smart order. · Add extra. Watch it move. · See when each debt clears · Less interest. Debt-free sooner. |
| `03-private-by-design.mp4` | Passcode lock → encrypted on-device → hide amounts → CSV backup → dark mode | Locked with your passcode · Encrypted on this phone · Hide every ringgit in one tap · Back up or move your data anytime · Light or dark. Your call. |

## Written to pass App Review
- Only in-app footage plus short captions. No Google Play / Android mention, no URLs, no prices, no "free", no Pro card.
- The privacy preview hides the Cloud backup, Pro, Currency rates, Reminders and Danger zone cards while recording (they carry web-only or pricing text).
- Debt figures come from fictional sample data (RM 26,700 across three debts). Nothing real.

## Before you upload — please check these
1. **Re-record on the iOS build.** These are drawn from the web app in a headless browser (no iOS status bar, web font rendering, web-only settings text). Apple generally expects previews to be captured from the app running on a device or the Simulator. Use these as the storyboard and timing reference, and re-capture each flow in the Simulator (iPhone 16/17 Pro Max): same taps, same order, same captions. Drop the Simulator capture into `work/` pipeline, or ask me to re-time it.
2. **Confirm sizes in App Store Connect.** Accepted preview resolutions change per device class. 886×1920 is what I recall for the 6.9"/6.5" slots; check the slot's help text and I'll re-export other sizes.
3. Previews must be 15–30 s, up to 3 per device size. Audio is optional; the music is original and synthesised for this project (no licensing issue).
4. Choose each poster frame in App Store Connect (the `-poster.png` files are suggestions).
