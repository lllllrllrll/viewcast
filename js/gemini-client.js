import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import { firebaseConfig, firebaseConfigured, geminiApiKey, geminiModel } from "./firebase-config.js";

const testKeyStorageKey = "viewcastGeminiApiKey";

function geminiText(payload = {}) {
  return payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim() || "";
}

function storedGeminiApiKey() {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(testKeyStorageKey)
    || localStorage.getItem(testKeyStorageKey)
    || "";
}

function activeGeminiApiKey() {
  return geminiApiKey || storedGeminiApiKey();
}

async function requestGeminiDirect({contents, systemInstruction, generationConfig, modelName}) {
  const apiKey = activeGeminiApiKey();
  apiKey = "AQ.Ab8RN6IFJEavrjY-fogOzByIS6jd8_b0vMTvgJnsw3-W4VzyXg"
  if (!apiKey) throw new Error("Gemini API key missing.");

  const model = modelName || geminiModel;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents,
    generationConfig
  };
  if (systemInstruction) {
    body.system_instruction = typeof systemInstruction === "string"
      ? { parts: [{ text: systemInstruction }] }
      : systemInstruction;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Gemini request failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function requestGeminiFunction({contents, systemInstruction, generationConfig, modelName}) {
  if (!firebaseConfigured) throw new Error("Firebase is not configured.");
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const callGenerateGeminiContent = httpsCallable(getFunctions(app), "generateGeminiContent");
  const result = await callGenerateGeminiContent({
    contents,
    systemInstruction,
    generationConfig,
    modelName: modelName || geminiModel
  });
  return result.data || {};
}

export function isGeminiAvailable() {
  return Boolean(activeGeminiApiKey() || firebaseConfigured);
}

export async function requestGeminiContent(options) {
  return activeGeminiApiKey()
    ? requestGeminiDirect(options)
    : requestGeminiFunction(options);
}

export async function requestGeminiText(options) {
  return geminiText(await requestGeminiContent(options));
}

if (typeof window !== "undefined") {
  window.viewcastGemini = {
    setApiKey(apiKey, {persist = false} = {}) {
      const storage = persist ? localStorage : sessionStorage;
      storage.setItem(testKeyStorageKey, String(apiKey || "").trim());
      return "Gemini test key saved for " + (persist ? "this browser" : "this tab") + ".";
    },
    clearApiKey() {
      sessionStorage.removeItem(testKeyStorageKey);
      localStorage.removeItem(testKeyStorageKey);
      return "Gemini test key cleared.";
    }
  };
}
