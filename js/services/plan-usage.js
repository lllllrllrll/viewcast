export const BASIC_DAILY_FEATURE_LIMIT = 5;

const usageStorageKey = "viewcastAiAnalysesUsed";

function currentDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function emptyUsage() {
  return {day: currentDay(), count: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0};
}

export function readFeatureUsage() {
  const usage = emptyUsage();
  if (typeof localStorage === "undefined") return usage;
  try {
    const saved = JSON.parse(localStorage.getItem(usageStorageKey) || "null");
    if (saved?.day !== usage.day) return usage;
    return {
      day: usage.day,
      count: Math.max(0, Number(saved.count) || 0),
      promptTokens: Math.max(0, Number(saved.promptTokens) || 0),
      outputTokens: Math.max(0, Number(saved.outputTokens) || 0),
      totalTokens: Math.max(0, Number(saved.totalTokens) || 0)
    };
  } catch {
    localStorage.removeItem(usageStorageKey);
    return usage;
  }
}

export function requireAvailableFeatureUse() {
  if (readFeatureUsage().count < BASIC_DAILY_FEATURE_LIMIT) return;
  const error = new Error(`Your Basic plan includes ${BASIC_DAILY_FEATURE_LIMIT} AI feature uses per day. Your uses reset tomorrow.`);
  error.code = "plan/basic-feature-limit-reached";
  throw error;
}

export function recordFeatureUse(usageMetadata = {}) {
  if (typeof localStorage === "undefined") return readFeatureUsage();
  const usage = readFeatureUsage();
  usage.count += 1;
  usage.promptTokens += Number(usageMetadata.promptTokenCount) || 0;
  usage.outputTokens += Number(usageMetadata.candidatesTokenCount) || 0;
  usage.totalTokens += Number(usageMetadata.totalTokenCount) || 0;
  localStorage.setItem(usageStorageKey, JSON.stringify(usage));
  window.dispatchEvent(new CustomEvent("viewcast:ai-usage-updated", {detail: usage}));
  return usage;
}
