const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const logger = require("firebase-functions/logger");

// Define the secret for the Gemini API Key
// Set using: firebase functions:secrets:set GEMINI_API_KEY
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Allowed models to prevent abuse with expensive models
const ALLOWED_MODELS = [
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite"
];

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
      maxInstances: 10,
      region: "us-central1",
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

      const {
        contents,
        systemInstruction,
        generationConfig,
        modelName,
      } = request.data;

      // 2. Input validation
      if (!contents || !Array.isArray(contents)) {
        throw new HttpsError(
            "invalid-argument",
            "The function must be called with a 'contents' array.",
        );
      }

      // 3. Model restriction
      const selectedModel = modelName || "gemini-1.5-flash";
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
          systemInstruction: systemInstruction,
        });

        // 4. Call Gemini API
        const result = await model.generateContent({
          contents,
          generationConfig,
        });

        const response = await result.response;

        // 5. Return the response object.
        return {
          candidates: response.candidates,
          usageMetadata: response.usageMetadata,
        };
      } catch (error) {
        logger.error("Gemini API error:", error);

        // Provide a safe error message to the client
        throw new HttpsError(
            "internal",
            "An error occurred while communicating with the Gemini API.",
            error.message,
        );
      }
    },
);
