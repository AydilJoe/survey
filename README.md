# Quick Survey

A minimal single-page survey web app. No build step, no backend — open `index.html` in a browser.

## Features

- Collects name, role, satisfaction rating, feature usage, and comments
- Basic client-side validation
- Responses saved to `localStorage`
- Results view with response list and average satisfaction
- Clear-all action for resetting saved responses

## Run locally

Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Files

- `index.html` — markup and views (survey / thanks / results)
- `styles.css` — styling
- `script.js` — form handling, storage, and rendering
