// Stateless Paid-Tier Gemini REST client for Duitful AI+.
// - Uses responseMimeType: "application/json" + responseSchema (JSON only).
// - Never enables Search Grounding.
// - Never logs request bodies, images, or AI outputs.
// - Supports global.__DUITFUL_AI_GEMINI_STUB__ in tests (in-memory e2e).

const { MODELS } = require("./models");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function callGemini({ modelKey, prompt, imageBase64, imageMime, schema, timeoutMs = 15000, thinkingLevel = "" }) {
  const modelId = MODELS[modelKey];
  if (!modelId) throw new Error(`Unknown model key: ${modelKey}`);

  // In-memory test stub (used by tests/e2e.mjs with AI_MEMORY=1).
  if (typeof global.__DUITFUL_AI_GEMINI_STUB__ === "function") {
    return await global.__DUITFUL_AI_GEMINI_STUB__({
      modelKey,
      modelId,
      prompt,
      hasImage: !!imageBase64,
      schema,
      timeoutMs,
      thinkingLevel: thinkingLevel || "",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: imageMime || "image/jpeg",
        data: imageBase64,
      },
    });
  }

  // Gemini 3.x / 4.x deprecated sampling parameters (temperature/topP/topK);
  // keep temperature: 0 only on Gemini 2.5 models.
  const isGemini2 = /^gemini-2\./i.test(modelId);
  const generationConfig = {
    responseMimeType: "application/json",
    ...(isGemini2 ? { temperature: 0 } : {}),
    ...(schema ? { responseSchema: schema } : {}),
    ...(!isGemini2 && thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
  };

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      const err = new Error(`gemini-http-${r.status}`);
      err.status = r.status;
      throw err;
    }
    const data = await r.json();
    const text = data
      && data.candidates
      && data.candidates[0]
      && data.candidates[0].content
      && data.candidates[0].content.parts
      && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    if (typeof text !== "string" || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callGemini };
