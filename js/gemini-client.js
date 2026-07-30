import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import { firebaseConfig, firebaseConfigured, geminiModel } from "./firebase-config.js";

const fallbackGeminiModel = "gemini-2.5-flash";
const allowedGeminiModels = new Set([
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
]);

function geminiText(payload = {}) {
  return payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim() || "";
}

function safeGeminiModel(modelName) {
  const model = String(modelName || geminiModel || "").trim();
  return allowedGeminiModels.has(model) ? model : fallbackGeminiModel;
}

function recordAiAnalysis() {
  if (typeof window === "undefined") return;
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const key = "viewcastAiAnalysesUsed";
  let usage = {day, count: 0};
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved?.day === day) usage.count = Number(saved.count) || 0;
  } catch (error) {
    localStorage.removeItem(key);
  }
  usage.count += 1;
  localStorage.setItem(key, JSON.stringify(usage));
  window.dispatchEvent(new CustomEvent("viewcast:ai-usage-updated", {detail: usage}));
}

async function requestGeminiFunction({contents, systemInstruction, generationConfig, modelName}) {
  if (!firebaseConfigured) throw new Error("Firebase is not configured.");
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const callGenerateGeminiContent = httpsCallable(getFunctions(app), "generateGeminiContent");
  const result = await callGenerateGeminiContent({
    contents,
    systemInstruction,
    generationConfig,
    modelName: safeGeminiModel(modelName)
  });
  return result.data || {};
}

export function isGeminiAvailable() {
  return firebaseConfigured;
}

export async function requestGeminiContent(options) {
  const result = await requestGeminiFunction(options);
  recordAiAnalysis();
  return result;
}

export async function requestGeminiText(options) {
  return geminiText(await requestGeminiContent(options));
}
