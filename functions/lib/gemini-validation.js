const {HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const MAX_TEXT_CHARS = 18000;
const MAX_INLINE_DATA_CHARS = 21 * 1024 * 1024;
const MAX_SYSTEM_CHARS = 3000;
const MAX_OUTPUT_TOKENS = 800;

/**
 * Validates Gemini message and supported media payloads.
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
  let mediaPartCount = 0;
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
      const fileData = part.fileData;
      if (fileData) {
        let fileUrl;
        try {
          fileUrl = new URL(String(fileData.fileUri || ""));
        } catch (error) {
          logger.debug("Rejected malformed Gemini media URL", {
            name: error.name,
          });
          throw new HttpsError("invalid-argument", "Invalid media URL.");
        }
        const youtubeHost = fileUrl.hostname === "youtube.com" ||
          fileUrl.hostname.endsWith(".youtube.com") ||
          fileUrl.hostname === "youtu.be";
        if (typeof fileData.mimeType !== "string" ||
            fileData.mimeType !== "video/*" ||
            fileUrl.protocol !== "https:" || !youtubeHost) {
          throw new HttpsError(
              "invalid-argument",
              "Invalid YouTube media URL.",
          );
        }
        mediaPartCount += 1;
        return;
      }
      const inlineData = part.inlineData;
      if (!inlineData || typeof inlineData.data !== "string" ||
          !["image/jpeg", "image/png", "image/webp", "video/mp4",
            "video/webm", "video/quicktime", "video/x-m4v"]
              .includes(inlineData.mimeType) ||
          inlineData.data.length > MAX_INLINE_DATA_CHARS) {
        throw new HttpsError("invalid-argument", "Invalid inline media data.");
      }
      mediaPartCount += 1;
    });
  });

  if (textChars > MAX_TEXT_CHARS || mediaPartCount > 2) {
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

module.exports = {
  validateContents,
  validatedSystemInstruction,
  validatedGenerationConfig,
};
