import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import { firebaseConfig, firebaseConfigured, geminiApiKey, geminiModel } from "./firebase-config.js";

const testKeyStorageKey = "viewcastGeminiApiKey";
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

function storedGeminiApiKey() {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(testKeyStorageKey)
    || localStorage.getItem(testKeyStorageKey)
    || "";
}

function activeGeminiApiKey() {
  return geminiApiKey || storedGeminiApiKey();
}

function safeGeminiModel(modelName) {
  const model = String(modelName || geminiModel || "").trim();
  return allowedGeminiModels.has(model) ? model : fallbackGeminiModel;
}

function restPart(part = {}) {
  if (part.inlineData) {
    return {
      inline_data: {
        mime_type: part.inlineData.mimeType,
        data: part.inlineData.data
      }
    };
  }
  return part;
}

function restContents(contents = []) {
  return contents.map((content) => ({
    ...content,
    parts: Array.isArray(content.parts) ? content.parts.map(restPart) : content.parts
  }));
}

async function requestGeminiDirect({contents, systemInstruction, generationConfig, modelName}) {
  const apiKey = activeGeminiApiKey();
  if (!apiKey) throw new Error("Gemini API key missing.");

  const model = safeGeminiModel(modelName);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: restContents(contents),
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
    modelName: safeGeminiModel(modelName)
  });
  return result.data || {};
}

export function isGeminiAvailable() {
  return Boolean(activeGeminiApiKey() || firebaseConfigured);
}

export async function requestGeminiContent(options) {
  // Use Firebase Functions by default for security.
  // Only use direct calls if a test key is explicitly provided in storage or config.
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
