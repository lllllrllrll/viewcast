import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  firebaseAppCheckSiteKey,
  firebaseConfig,
  firebaseConfigured,
  geminiModel
} from "./firebase-config.js?v=2";
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app-check.js";

const fallbackGeminiModel = "gemini-3.1-flash-lite";
const allowedGeminiModels = new Set([
  "gemini-3.1-flash-lite"
]);
const pendingRequests = new Map();
let appCheckInitialized = false;
let appCheckInstance = null;

function ensureAppCheck(app) {
  if (!firebaseAppCheckSiteKey) return null;
  if (!appCheckInitialized) {
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(firebaseAppCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    });
    appCheckInitialized = true;
  }
  return appCheckInstance;
}

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

function recordAiAnalysis(usageMetadata = {}) {
  if (typeof window === "undefined") return;
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const key = "viewcastAiAnalysesUsed";
  let usage = {day, count: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0};
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved?.day === day) {
      usage.count = Number(saved.count) || 0;
      usage.promptTokens = Number(saved.promptTokens) || 0;
      usage.outputTokens = Number(saved.outputTokens) || 0;
      usage.totalTokens = Number(saved.totalTokens) || 0;
    }
  } catch (error) {
    localStorage.removeItem(key);
  }
  usage.count += 1;
  usage.promptTokens += Number(usageMetadata.promptTokenCount) || 0;
  usage.outputTokens += Number(usageMetadata.candidatesTokenCount) || 0;
  usage.totalTokens += Number(usageMetadata.totalTokenCount) || 0;
  localStorage.setItem(key, JSON.stringify(usage));
  window.dispatchEvent(new CustomEvent("viewcast:ai-usage-updated", {detail: usage}));
}

async function requestGeminiFunction({contents, systemInstruction, generationConfig, modelName}) {
  if (!firebaseConfigured) throw new Error("Firebase is not configured.");
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const appCheck = ensureAppCheck(app);
  const user = getAuth(app).currentUser;
  if (!user) throw new Error("Sign in before using AI features.");
  if (!appCheck) throw new Error("App Check is not configured.");

  const [idToken, appCheckResult] = await Promise.all([
    user.getIdToken(),
    getToken(appCheck, false)
  ]);
  const response = await fetch(
    `https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/generateGeminiContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`,
        "X-Firebase-AppCheck": appCheckResult.token
      },
      body: JSON.stringify({data: {
        contents,
        systemInstruction,
        generationConfig,
        modelName: safeGeminiModel(modelName)
      }})
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const status = String(payload.error?.status || "internal").toLowerCase().replace(/_/g, "-");
    const error = new Error(payload.error?.message || "The AI request failed.");
    error.code = `functions/${status}`;
    throw error;
  }
  return payload.data || payload.result || {};
}

function requestKey(options = {}) {
  return JSON.stringify({
    contents: options.contents || [],
    systemInstruction: options.systemInstruction || "",
    generationConfig: options.generationConfig || {},
    modelName: safeGeminiModel(options.modelName)
  });
}

export function isGeminiAvailable() {
  return firebaseConfigured;
}

export async function requestGeminiContent(options) {
  const key = requestKey(options);
  if (pendingRequests.has(key)) return pendingRequests.get(key);

  const request = requestGeminiFunction(options)
    .then((result) => {
      recordAiAnalysis(result.usageMetadata);
      return result;
    })
    .finally(() => pendingRequests.delete(key));
  pendingRequests.set(key, request);
  return request;
}

export async function requestGeminiText(options) {
  return geminiText(await requestGeminiContent(options));
}
