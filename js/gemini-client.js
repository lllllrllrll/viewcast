import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
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
const responseCachePrefix = "viewcastGeminiResponse:v1:";
const responseCacheMaxAge = 6 * 60 * 60 * 1000;
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

// App Check must be initialized before the page starts using Firebase services.
// Doing this only when the user clicked Generate allowed Auth/Firestore to win the
// initialization race on the Insights page and could make reCAPTCHA attestation fail.
const firebaseApp = firebaseConfigured
  ? (getApps().length ? getApps()[0] : initializeApp(firebaseConfig))
  : null;
if (firebaseApp) ensureAppCheck(firebaseApp);

function geminiText(payload = {}) {
  return payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim() || "";
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function ensureAppCheckToken(appCheck) {
  try {
    return await getToken(appCheck, false);
  } catch (error) {
    if (error.code !== "appCheck/initial-throttle") throw error;
    await wait(2000);
    return getToken(appCheck, true);
  }
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
  const app = firebaseApp || (getApps().length ? getApps()[0] : initializeApp(firebaseConfig));
  const appCheck = appCheckInstance || ensureAppCheck(app);
  if (!appCheck) throw new Error("App Check is not configured.");
  await ensureAppCheckToken(appCheck);
  const callGenerateGeminiContent = httpsCallable(getFunctions(app), "generateGeminiContent");
  const result = await callGenerateGeminiContent({
    contents,
    systemInstruction,
    generationConfig,
    modelName: safeGeminiModel(modelName)
  });
  return result.data || {};
}

function requestKey(options = {}) {
  return JSON.stringify({
    contents: options.contents || [],
    systemInstruction: options.systemInstruction || "",
    generationConfig: options.generationConfig || {},
    modelName: safeGeminiModel(options.modelName)
  });
}

function stableHash(value = "") {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function containsInlineMedia(contents = []) {
  return contents.some((content) => (content.parts || []).some(
    (part) => part.inlineData || part.fileData
  ));
}

function persistentCacheKey(key) {
  const uid = firebaseApp ? getAuth(firebaseApp).currentUser?.uid : "";
  return uid ? `${responseCachePrefix}${uid}:${stableHash(key)}` : "";
}

function readPersistentResponse(key) {
  if (!key) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved?.value || Date.now() - saved.savedAt > responseCacheMaxAge) {
      localStorage.removeItem(key);
      return null;
    }
    return saved.value;
  } catch (error) {
    localStorage.removeItem(key);
    return null;
  }
}

function savePersistentResponse(key, value) {
  if (!key || !value) return;
  try {
    localStorage.setItem(key, JSON.stringify({savedAt: Date.now(), value}));
  } catch (error) {
    // Storage pressure should never prevent a fresh AI result from rendering.
  }
}

export function isGeminiAvailable() {
  return firebaseConfigured;
}

export async function requestGeminiContent(options) {
  const key = requestKey(options);
  const cacheKey = containsInlineMedia(options.contents) ? "" : persistentCacheKey(key);
  const cached = readPersistentResponse(cacheKey);
  if (cached) return cached;
  if (pendingRequests.has(key)) return pendingRequests.get(key);

  const request = requestGeminiFunction(options)
    .then((result) => {
      recordAiAnalysis(result.usageMetadata);
      savePersistentResponse(cacheKey, result);
      return result;
    })
    .finally(() => pendingRequests.delete(key));
  pendingRequests.set(key, request);
  return request;
}

export async function requestGeminiText(options) {
  return geminiText(await requestGeminiContent(options));
}
