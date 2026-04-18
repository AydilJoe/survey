const STORAGE_KEY = "survey.responses.v1";

const views = {
  survey: document.getElementById("survey-view"),
  thanks: document.getElementById("thanks-view"),
  results: document.getElementById("results-view"),
};

const form = document.getElementById("survey-form");
const formError = document.getElementById("form-error");

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

function loadResponses() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveResponse(response) {
  const all = loadResponses();
  all.push(response);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function clearResponses() {
  localStorage.removeItem(STORAGE_KEY);
}

function collectFormData() {
  const data = new FormData(form);
  const features = data.getAll("features");
  return {
    id: crypto.randomUUID(),
    submittedAt: new Date().toISOString(),
    name: (data.get("name") || "").toString().trim(),
    role: (data.get("role") || "").toString(),
    satisfaction: (data.get("satisfaction") || "").toString(),
    features,
    comments: (data.get("comments") || "").toString().trim(),
  };
}

function validate(response) {
  if (!response.name) return "Please enter your name.";
  if (!response.role) return "Please select a role.";
  if (!response.satisfaction) return "Please rate your satisfaction.";
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderResults() {
  const all = loadResponses();
  const summary = document.getElementById("results-summary");
  const list = document.getElementById("results-list");

  if (all.length === 0) {
    summary.textContent = "No responses yet.";
    list.innerHTML = "";
    return;
  }

  const avg =
    all.reduce((sum, r) => sum + Number(r.satisfaction || 0), 0) / all.length;
  summary.textContent = `${all.length} response${all.length === 1 ? "" : "s"} • average satisfaction ${avg.toFixed(1)}/5`;

  list.innerHTML = all
    .slice()
    .reverse()
    .map((r) => {
      const date = new Date(r.submittedAt).toLocaleString();
      const features = r.features.length ? r.features.join(", ") : "—";
      const comments = r.comments ? escapeHtml(r.comments) : "—";
      return `
        <article class="result-card">
          <div class="meta">${escapeHtml(date)}</div>
          <dl>
            <dt>Name</dt><dd>${escapeHtml(r.name)}</dd>
            <dt>Role</dt><dd>${escapeHtml(r.role)}</dd>
            <dt>Satisfaction</dt><dd>${escapeHtml(r.satisfaction)}/5</dd>
            <dt>Features</dt><dd>${escapeHtml(features)}</dd>
            <dt>Comments</dt><dd>${comments}</dd>
          </dl>
        </article>
      `;
    })
    .join("");
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  formError.hidden = true;

  const response = collectFormData();
  const err = validate(response);
  if (err) {
    formError.textContent = err;
    formError.hidden = false;
    return;
  }

  saveResponse(response);
  form.reset();
  showView("thanks");
});

document.getElementById("view-results").addEventListener("click", () => {
  renderResults();
  showView("results");
});

document.getElementById("submit-another").addEventListener("click", () => {
  showView("survey");
});

document.getElementById("go-results").addEventListener("click", () => {
  renderResults();
  showView("results");
});

document.getElementById("back-to-form").addEventListener("click", () => {
  showView("survey");
});

document.getElementById("clear-results").addEventListener("click", () => {
  if (confirm("Delete all saved responses? This cannot be undone.")) {
    clearResponses();
    renderResults();
  }
});

showView("survey");
