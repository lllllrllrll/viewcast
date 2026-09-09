const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const logger = require("firebase-functions/logger");
const {
  validateContents,
  validatedGenerationConfig,
  validatedSystemInstruction,
} = require("../lib/gemini-validation");
const {
  enforceDailyQuota,
  enforceRateLimit,
  geminiCacheKey,
  readGeminiCache,
  saveGeminiCache,
} = require("../lib/gemini-guard");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const enforceAppCheck = true;
const ALLOWED_MODELS = ["gemini-3.1-flash-lite"];
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

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
