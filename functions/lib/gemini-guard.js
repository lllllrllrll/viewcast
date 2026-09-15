const {HttpsError} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {createHash} = require("crypto");

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 12;
const MAX_RATE_LIMIT_USERS = 5000;
const BASIC_DAILY_FEATURE_REQUESTS = 5;
const DAILY_PROJECT_REQUESTS = 5000;
const recentRequests = new Map();
const responseCache = new Map();
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/**
 * Creates a private cache key for one user's exact Gemini request.
 * @param {string} uid Firebase user ID.
 * @param {object} value Validated Gemini request fields.
 * @return {string} Stable cache key.
 */
function geminiCacheKey(uid, value) {
  return `${uid}:${createHash("sha256")
      .update(JSON.stringify(value))
      .digest("base64url")}`;
}

/**
 * Reads a non-expired Gemini result from this warm function instance.
 * @param {string} key Cache key.
 * @return {object|null} Cached callable response.
 */
function readGeminiCache(key) {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.savedAt > CACHE_MAX_AGE_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached.value;
}

/**
 * Stores a Gemini result while keeping the in-memory cache bounded.
 * @param {string} key Cache key.
 * @param {object} value Callable response.
 * @return {void}
 */
function saveGeminiCache(key, value) {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }
  responseCache.set(key, {savedAt: Date.now(), value});
}


/**
 * Applies a short per-instance request limit for one authenticated user.
 * @param {string} uid Firebase Authentication user ID.
 * @return {void}
 */
function enforceRateLimit(uid) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (recentRequests.get(uid) || [])
      .filter((timestamp) => timestamp > cutoff);
  if (timestamps.length >= RATE_LIMIT_REQUESTS) {
    throw new HttpsError(
        "resource-exhausted",
        "Too many AI requests. Please wait about a minute and try again.",
    );
  }
  timestamps.push(now);
  recentRequests.set(uid, timestamps);

  // Keep long-lived warm instances from retaining inactive user IDs forever.
  if (recentRequests.size > MAX_RATE_LIMIT_USERS) {
    for (const [userId, requests] of recentRequests) {
      if (!requests.some((timestamp) => timestamp > cutoff)) {
        recentRequests.delete(userId);
      }
    }
  }
}

/**
 * Enforces durable daily user and project quotas across function instances.
 * @param {string} uid Firebase Authentication user ID.
 * @return {Promise<void>}
 */
async function enforceDailyQuota(uid) {
  const day = new Date().toISOString().slice(0, 10);
  const db = getFirestore();
  const userRef = db.doc(`_internalAiUsage/user_${uid}`);
  const projectRef = db.doc("_internalAiUsage/project");

  await db.runTransaction(async (transaction) => {
    const [userSnapshot, projectSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(projectRef),
    ]);
    const userData = userSnapshot.data() || {};
    const projectData = projectSnapshot.data() || {};
    const userCount = userData.day === day ? Number(userData.count || 0) : 0;
    const projectCount = projectData.day === day ?
      Number(projectData.count || 0) :
      0;
    if (userCount >= BASIC_DAILY_FEATURE_REQUESTS ||
        projectCount >= DAILY_PROJECT_REQUESTS) {
      throw new HttpsError(
          "resource-exhausted",
          userCount >= BASIC_DAILY_FEATURE_REQUESTS ?
            "Your Basic plan includes 5 AI feature uses per day. " +
              "Your uses reset tomorrow." :
            "The daily AI usage limit has been reached.",
      );
    }
    transaction.set(userRef, {count: userCount + 1, day});
    transaction.set(projectRef, {count: projectCount + 1, day});
  });
}

module.exports = {
  enforceDailyQuota,
  enforceRateLimit,
  geminiCacheKey,
  readGeminiCache,
  saveGeminiCache,
};
