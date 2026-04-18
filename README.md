# Duit Tracker

A single-page money tracker for **monthly in/out** and **debt payoff using the avalanche method**. Built as plain HTML/CSS/JS — no build step, no backend. All data stays in your browser's `localStorage`. Currency: **MYR**.

## Features

- Add monthly income and expenses
- Add outstanding debts (balance, APR, minimum payment)
- Avalanche payoff simulator — highest APR first, rolls minimums forward
- Dashboard: net cash flow, total debt, weighted APR, debt-free timeline, total interest paid
- CSV export/import for backup and transferring between devices
- Mobile-first, works offline once loaded

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy (GitHub Pages)

This repo ships a workflow at `.github/workflows/pages.yml` that publishes the site to GitHub Pages whenever `main` is updated. To enable:

1. Push to GitHub.
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The site URL will appear at the top of the Pages settings — share that link.

## CSV format

A single file with columns:

```
type,name,amount,balance,apr,minPayment
income,Salary,5000,,,
expense,Rent,1500,,,
debt,Credit Card,,3000,18,150
setting,extraMonthly,500,,,
```

Rows for `income`/`expense` use `amount`. Rows for `debt` use `balance`, `apr`, `minPayment`. The `setting` row for `extraMonthly` stores the extra payment allocated to the avalanche each month.

## Files

- `index.html` — markup (Dashboard / In-Out / Debts / Data tabs)
- `styles.css` — mobile-first dark UI
- `script.js` — state, avalanche simulation, CSV import/export
