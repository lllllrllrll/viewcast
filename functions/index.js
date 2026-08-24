const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const {getApps, initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const {createHash} = require("crypto");

if (!getApps().length) initializeApp();

// Define the secret for the Gemini API Key
// Set using: firebase functions:secrets:set GEMINI_API_KEY
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const googleOAuthClientSecret = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_OAUTH_CLIENT_ID =
  "351557961377-ocbt4u5dm00n0mqfjvf808rpakc0b5bt.apps.googleusercontent.com";
const enforceAppCheck = true;

// Allowed models to prevent abuse with expensive models
const ALLOWED_MODELS = [
  "gemini-3.1-flash-lite",
];
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const MAX_TEXT_CHARS = 30000;
const MAX_INLINE_DATA_CHARS = 7 * 1024 * 1024;
const MAX_SYSTEM_CHARS = 6000;
const MAX_OUTPUT_TOKENS = 1200;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 12;
const MAX_RATE_LIMIT_USERS = 5000;
const DAILY_USER_REQUESTS = 50;
const DAILY_PROJECT_REQUESTS = 5000;
const recentRequests = new Map();
const geminiResponseCache = new Map();
const GEMINI_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const GEMINI_CACHE_MAX_ENTRIES = 500;

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
  const cached = geminiResponseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.savedAt > GEMINI_CACHE_MAX_AGE_MS) {
    geminiResponseCache.delete(key);
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
  if (geminiResponseCache.size >= GEMINI_CACHE_MAX_ENTRIES) {
    const oldestKey = geminiResponseCache.keys().next().value;
    if (oldestKey) geminiResponseCache.delete(oldestKey);
  }
  geminiResponseCache.set(key, {savedAt: Date.now(), value});
}

/**
 * Exchanges an OAuth code or refresh token with Google.
 * @param {object} parameters OAuth token endpoint parameters.
 * @return {Promise<object>} Google token response.
 */
async function googleTokenRequest(parameters) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams(parameters),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    logger.error("Google OAuth token exchange failed", {
      status: response.status,
      error: payload.error,
    });
    throw new HttpsError(
        "failed-precondition",
        "Your YouTube connection needs to be linked again.",
    );
  }
  return payload;
}

/**
 * Resolves the channel owned by a Google access token.
 * @param {string} accessToken Google OAuth access token.
 * @return {Promise<string>} YouTube channel ID.
 */
async function youtubeChannelId(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("mine", "true");
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`},
  });
  const payload = await response.json().catch(() => ({}));
  const channelId = payload.items && payload.items[0] && payload.items[0].id;
  if (!response.ok || !channelId) {
    throw new HttpsError(
        "failed-precondition",
        "No YouTube channel was available for this Google account.",
    );
  }
  return channelId;
}

exports.exchangeYouTubeAuthorizationCode = onCall(
    {
      secrets: [googleOAuthClientSecret],
      enforceAppCheck,
      region: "us-central1",
      timeoutSeconds: 30,
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before linking YouTube.",
        );
      }
      const data = request.data || {};
      const code = String(data.code || "");
      const redirectUri = String(data.redirectUri || "");
      if (!code || code.length > 4096 || !/^https?:\/\//.test(redirectUri)) {
        throw new HttpsError(
            "invalid-argument",
            "Invalid Google authorization response.",
        );
      }

      const tokens = await googleTokenRequest({
        code,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: googleOAuthClientSecret.value(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const channelId = await youtubeChannelId(tokens.access_token);
      const credentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${request.auth.uid}`);
      const existing = await credentialRef.get();
      const existingCredential = existing.data() || {};
      const refreshToken = tokens.refresh_token ||
        existingCredential.refreshToken;
      if (!refreshToken) {
        throw new HttpsError(
            "failed-precondition",
            "Google did not return renewable access. " +
            "Unlink ViewCast in your Google account and link again.",
        );
      }
      const expiresAt = Date.now() +
        Number(tokens.expires_in || 3600) * 1000;
      await credentialRef.set({
        refreshToken,
        accessToken: tokens.access_token,
        expiresAt,
        channelId,
        scope: String(tokens.scope || ""),
        updatedAt: new Date(),
      });
      return {accessToken: tokens.access_token, expiresAt, channelId};
    },
);

exports.getYouTubeAccessToken = onCall(
    {
      secrets: [googleOAuthClientSecret],
      enforceAppCheck,
      region: "us-central1",
      timeoutSeconds: 30,
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before using YouTube.",
        );
      }
      const credentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${request.auth.uid}`);
      const snapshot = await credentialRef.get();
      const credential = snapshot.data();
      if (!credential || !credential.refreshToken) {
        throw new HttpsError(
            "failed-precondition",
            "Link your YouTube channel first.",
        );
      }
      if (credential.accessToken &&
          Number(credential.expiresAt || 0) > Date.now() + 60 * 1000) {
        return {
          accessToken: credential.accessToken,
          expiresAt: credential.expiresAt,
          channelId: credential.channelId,
        };
      }
      const tokens = await googleTokenRequest({
        refresh_token: credential.refreshToken,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: googleOAuthClientSecret.value(),
        grant_type: "refresh_token",
      });
      const expiresAt = Date.now() +
        Number(tokens.expires_in || 3600) * 1000;
      await credentialRef.set({
        accessToken: tokens.access_token,
        expiresAt,
        updatedAt: new Date(),
      }, {merge: true});
      return {
        accessToken: tokens.access_token,
        expiresAt,
        channelId: credential.channelId,
      };
    },
);

exports.revokeYouTubeAuthorization = onCall(
    {enforceAppCheck, region: "us-central1", timeoutSeconds: 30},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before unlinking YouTube.",
        );
      }
      const credentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${request.auth.uid}`);
      const snapshot = await credentialRef.get();
      const savedCredential = snapshot.data() || {};
      const token = savedCredential.refreshToken;
      if (token) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          body: new URLSearchParams({token}),
        }).catch(() => {});
      }
      await credentialRef.delete();
      return {revoked: true};
    },
);

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
    if (userCount >= DAILY_USER_REQUESTS ||
        projectCount >= DAILY_PROJECT_REQUESTS) {
      throw new HttpsError(
          "resource-exhausted",
          "The daily AI usage limit has been reached.",
      );
    }
    transaction.set(userRef, {count: userCount + 1, day});
    transaction.set(projectRef, {count: projectCount + 1, day});
  });
}

/**
 * Deletes the caller's profile and Firebase Authentication account together.
 * The client must reauthenticate immediately before invoking this function.
 */
exports.deleteAccount = onCall(
    {
      enforceAppCheck,
      region: "us-central1",
      timeoutSeconds: 30,
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before deleting your account.",
        );
      }

      const authTimeSeconds = Number(request.auth.token.auth_time || 0);
      if (!authTimeSeconds || Date.now() / 1000 - authTimeSeconds > 5 * 60) {
        throw new HttpsError(
            "failed-precondition",
            "Reauthenticate before deleting your account.",
        );
      }

      const uid = request.auth.uid;
      const youtubeCredentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${uid}`);
      const youtubeCredential = await youtubeCredentialRef.get();
      const savedYouTubeCredential = youtubeCredential.data() || {};
      const googleRefreshToken = savedYouTubeCredential.refreshToken;
      if (googleRefreshToken) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          body: new URLSearchParams({token: googleRefreshToken}),
        }).catch(() => {});
      }
      await youtubeCredentialRef.delete();
      try {
        await getAuth().deleteUser(uid);
      } catch (error) {
        logger.error("Firebase Auth account deletion failed", {uid, error});
        throw new HttpsError(
            "internal",
            "The account could not be deleted. Please try again.",
        );
      }

      try {
        // Firestore deletion is idempotent. Perform it after deleting the Auth
        // identity so a cleanup failure can never leave a usable account with
        // a missing profile.
        await getFirestore().doc(`users/${uid}`).delete();
        logger.info("Deleted ViewCast account and profile", {uid});
        return {deleted: true, profileDeleted: true};
      } catch (error) {
        logger.error("Deleted Auth account but profile cleanup failed", {
          uid,
          error,
        });
        return {deleted: true, profileDeleted: false};
      }
    },
);

/**
 * Validates Gemini message and image payloads.
 * @param {Array<object>} contents Gemini request messages.
 * @return {void}
 */
function validateContents(contents) {
  if (!Array.isArray(contents) || !contents.length || contents.length > 8) {
    throw new HttpsError(
        "invalid-argument",
        "Contents must contain between 1 and 8 messages.",
    );
  }

  let textChars = 0;
  let inlineDataCount = 0;
  contents.forEach((message) => {
    if (!message || typeof message !== "object" ||
        !["user", "model"].includes(message.role) ||
        !Array.isArray(message.parts) ||
        !message.parts.length ||
        message.parts.length > 4) {
      throw new HttpsError("invalid-argument", "Invalid message structure.");
    }
    message.parts.forEach((part) => {
      if (!part || typeof part !== "object") {
        throw new HttpsError("invalid-argument", "Invalid message part.");
      }
      const keys = Object.keys(part);
      if (keys.length !== 1) {
        throw new HttpsError(
            "invalid-argument",
            "Invalid message part fields.",
        );
      }
      if (typeof part.text === "string") {
        textChars += part.text.length;
        return;
      }
      const inlineData = part.inlineData;
      if (!inlineData || typeof inlineData.data !== "string" ||
          !["image/jpeg", "image/png", "image/webp"]
              .includes(inlineData.mimeType) ||
          inlineData.data.length > MAX_INLINE_DATA_CHARS) {
        throw new HttpsError("invalid-argument", "Invalid inline image data.");
      }
      inlineDataCount += 1;
    });
  });

  if (textChars > MAX_TEXT_CHARS || inlineDataCount > 2) {
    throw new HttpsError("invalid-argument", "AI request is too large.");
  }
}

/**
 * Validates an optional Gemini system instruction.
 * @param {*} value Requested system instruction.
 * @return {string|undefined} Validated instruction.
 */
function validatedSystemInstruction(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_SYSTEM_CHARS) {
    throw new HttpsError(
        "invalid-argument",
        "System instruction is invalid or too large.",
    );
  }
  return value;
}

/**
 * Builds a bounded, allowlisted Gemini generation config.
 * @param {*} value Requested generation config.
 * @return {object} Validated generation config.
 */
function validatedGenerationConfig(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "Invalid generation config.");
  }
  const allowedKeys = [
    "temperature",
    "topP",
    "topK",
    "maxOutputTokens",
    "responseMimeType",
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new HttpsError("invalid-argument", "Unsupported generation config.");
  }

  const config = {};
  if (value.temperature !== undefined) {
    if (typeof value.temperature !== "number" ||
        value.temperature < 0 || value.temperature > 2) {
      throw new HttpsError("invalid-argument", "Invalid temperature.");
    }
    config.temperature = value.temperature;
  }
  if (value.topP !== undefined) {
    if (typeof value.topP !== "number" ||
        value.topP < 0 || value.topP > 1) {
      throw new HttpsError("invalid-argument", "Invalid topP.");
    }
    config.topP = value.topP;
  }
  if (value.topK !== undefined) {
    if (!Number.isInteger(value.topK) || value.topK < 1 || value.topK > 100) {
      throw new HttpsError("invalid-argument", "Invalid topK.");
    }
    config.topK = value.topK;
  }
  const outputTokens = value.maxOutputTokens === undefined ?
    512 :
    value.maxOutputTokens;
  if (!Number.isInteger(outputTokens) ||
      outputTokens < 1 || outputTokens > MAX_OUTPUT_TOKENS) {
    throw new HttpsError("invalid-argument", "Invalid output token limit.");
  }
  config.maxOutputTokens = outputTokens;
  if (value.responseMimeType !== undefined) {
    if (!["application/json", "text/plain"]
        .includes(value.responseMimeType)) {
      throw new HttpsError("invalid-argument", "Invalid response MIME type.");
    }
    config.responseMimeType = value.responseMimeType;
  }
  return config;
}

/**
 * Callable function to generate content using Gemini API.
 * This function is secure because it:
 * 1. Uses Firebase Authentication to verify the caller.
 * 2. Uses Google Cloud Secret Manager to store the API key safely.
 * 3. Never exposes the API key to the client.
 */
exports.generateGeminiContent = onCall(
    {
      secrets: [geminiApiKey],
      enforceAppCheck,
      maxInstances: 5,
      region: "us-central1",
      timeoutSeconds: 120, // Increased to prevent 504 timeouts
    },
    async (request) => {
      // 1. Authentication check
      if (!request.auth) {
        logger.warn("Unauthenticated request to generateGeminiContent");
        throw new HttpsError(
            "unauthenticated",
            "The function must be called while authenticated.",
        );
      }
      if (!request.data || typeof request.data !== "object") {
        throw new HttpsError("invalid-argument", "Request data is required.");
      }

      const {
        contents,
        systemInstruction,
        generationConfig,
        modelName,
      } = request.data;

      // 2. Input validation and basic per-instance abuse control.
      enforceRateLimit(request.auth.uid);
      validateContents(contents);
      const safeSystemInstruction =
        validatedSystemInstruction(systemInstruction);
      const safeGenerationConfig =
        validatedGenerationConfig(generationConfig);

      // 3. Model restriction
      const selectedModel = modelName || DEFAULT_GEMINI_MODEL;
      if (!ALLOWED_MODELS.includes(selectedModel)) {
        throw new HttpsError(
            "invalid-argument",
            `Model '${selectedModel}' is not allowed.`,
        );
      }

      const responseCacheKey = geminiCacheKey(request.auth.uid, {
        contents,
        systemInstruction: safeSystemInstruction,
        generationConfig: safeGenerationConfig,
        modelName: selectedModel,
      });
      const cachedResponse = readGeminiCache(responseCacheKey);
      if (cachedResponse) return cachedResponse;

      await enforceDailyQuota(request.auth.uid);

      try {
        const apiKey = geminiApiKey.value();
        if (!apiKey) {
          logger.error("GEMINI_API_KEY secret is not set.");
          throw new HttpsError(
              "failed-precondition",
              "API configuration missing.",
          );
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: selectedModel,
          systemInstruction: safeSystemInstruction,
        });

        // 4. Call Gemini API
        const result = await model.generateContent({
          contents,
          generationConfig: safeGenerationConfig,
        });

        const response = await result.response;

        // 5. Return the response object.
        const responseValue = {
          candidates: response.candidates,
          usageMetadata: response.usageMetadata,
        };
        saveGeminiCache(responseCacheKey, responseValue);
        return responseValue;
      } catch (error) {
        logger.error("Gemini API error:", error);

        // Handle specific Gemini errors
        if (error.status === 503) {
          throw new HttpsError(
              "unavailable",
              "The AI model is overloaded. Please try again in a few seconds.",
              error.message,
          );
        }
        if (error.status === 404) {
          throw new HttpsError(
              "not-found",
              `The model '${selectedModel}' was not found or is deprecated.`,
              error.message,
          );
        }

        throw new HttpsError(
            "internal",
            "An error occurred while communicating with the Gemini API.",
            error.message,
        );
      }
    },
);
