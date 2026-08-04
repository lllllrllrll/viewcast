const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const {getApps, initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

if (!getApps().length) initializeApp();

// Define the secret for the Gemini API Key
// Set using: firebase functions:secrets:set GEMINI_API_KEY
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Allowed models to prevent abuse with expensive models
const ALLOWED_MODELS = [
  "gemini-3.1-flash-lite",
];
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const MAX_TEXT_CHARS = 60000;
const MAX_INLINE_DATA_CHARS = 7 * 1024 * 1024;
const MAX_SYSTEM_CHARS = 12000;
const MAX_OUTPUT_TOKENS = 2048;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 12;
const MAX_RATE_LIMIT_USERS = 5000;
const recentRequests = new Map();

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
 * Deletes the caller's profile and Firebase Authentication account together.
 * The client must reauthenticate immediately before invoking this function.
 */
exports.deleteAccount = onCall(
    {
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
      try {
        await getFirestore().doc(`users/${uid}`).delete();
        await getAuth().deleteUser(uid);
        logger.info("Deleted ViewCast account", {uid});
        return {deleted: true};
      } catch (error) {
        logger.error("Account deletion failed", {uid, error});
        throw new HttpsError(
            "internal",
            "The account could not be deleted. Please try again.",
        );
      }
    },
);

/**
 * Validates Gemini message and image payloads.
 * @param {Array<object>} contents Gemini request messages.
 * @return {void}
 */
function validateContents(contents) {
  if (!Array.isArray(contents) || !contents.length || contents.length > 12) {
    throw new HttpsError(
        "invalid-argument",
        "Contents must contain between 1 and 12 messages.",
    );
  }

  let textChars = 0;
  let inlineDataCount = 0;
  contents.forEach((message) => {
    if (!message || typeof message !== "object" ||
        !["user", "model"].includes(message.role) ||
        !Array.isArray(message.parts) ||
        !message.parts.length ||
        message.parts.length > 8) {
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
    1024 :
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
      if (request.auth.token.email_verified !== true) {
        logger.warn(
            "Unverified account attempted to use generateGeminiContent",
            {uid: request.auth.uid},
        );
        throw new HttpsError(
            "permission-denied",
            "Verify your email address before using ViewCast AI features.",
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
        return {
          candidates: response.candidates,
          usageMetadata: response.usageMetadata,
        };
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
