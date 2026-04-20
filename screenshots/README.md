# Landing page screenshots

Drop PNG exports here with these exact filenames — the landing page references them directly.

| Filename | Content | Notes |
|---|---|---|
| `hero-home.png` | Home tab: greeting, Upcoming card, Balance Left this month | Primary hero shot. Should show RM 428.30 balance, Upcoming list with Freelance/PTPTN/Maybank |
| `debts-summary.png` | Debts tab: RM 53,600 total, 6.62% weighted APR, 4yr debt-free | Used in the "Debt avalanche" section |
| `scan-receipt.png` | Scan receipt modal with OCR result | Used in the "Receipt OCR" feature card |
| `monthly.png` | Monthly tab: Income list + Recurring expenses | Used in the "In/Out" feature card |
| `avalanche-order.png` | Avalanche payoff order list (Home, scrolled down) | Optional — used in avalanche explainer |

## How to produce them

1. Open the web app and import `../sample.csv` via the **Data** tab
2. Navigate to each screen listed above
3. Take an iPhone-sized screenshot (~1170×2532 is ideal; taller is fine)
4. Crop out the PWA install banner if it appears at the bottom
5. Save into this directory with the filename from the table above

Images are referenced with `loading="lazy"` in `index.html`, so new files are picked up automatically on next deploy.
