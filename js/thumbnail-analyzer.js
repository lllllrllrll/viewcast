import { isGeminiAvailable, requestGeminiText } from "./gemini-client.js";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};
const form = document.querySelector("#thumbnailForm");
const input = document.querySelector("#thumbnailInput");
const dropzone = document.querySelector("#thumbnailDropzone");
const preview = document.querySelector("#thumbnailPreview");
const image = document.querySelector("#thumbnailImage");
const fileName = document.querySelector("#thumbnailFileName");
const fileSize = document.querySelector("#thumbnailFileSize");
const removeButton = document.querySelector("#removeThumbnail");
const analyzeButton = document.querySelector("#analyzeThumbnail");
const status = document.querySelector("#thumbnailStatus");
const context = document.querySelector("#thumbnailContext");
const emptyState = document.querySelector("#thumbnailEmptyState");
const output = document.querySelector("#thumbnailAnalysisOutput");
let selectedFile = null;
let previewUrl = "";

function imageMimeType(file) {
  if (ALLOWED_TYPES.has(file?.type)) return file.type;
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || "";
}

function setStatus(message, type = "") {
  status.textContent = message;
  status.dataset.type = type;
}

function resetFile() {
  selectedFile = null;
  input.value = "";
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  image.removeAttribute("src");
  preview.hidden = true;
  dropzone.hidden = false;
  analyzeButton.disabled = true;
  setStatus("");
}

function selectFile(file) {
  if (!file) return;
  if (!imageMimeType(file)) {
    setStatus("Choose a JPG, PNG, or WebP image.", "error");
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    setStatus("That image is larger than 5 MB. Choose a smaller file.", "error");
    return;
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedFile = file;
  previewUrl = URL.createObjectURL(file);
  image.src = previewUrl;
  fileName.textContent = file.name;
  fileSize.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  preview.hidden = false;
  dropzone.hidden = true;
  analyzeButton.disabled = false;
  setStatus("Ready to analyze.");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function parseJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

function renderList(element, items) {
  element.replaceChildren(...items.slice(0, 5).map((item) => {
    const li = document.createElement("li");
    li.textContent = String(item);
    return li;
  }));
}

function renderAnalysis(analysis) {
  const score = Math.max(0, Math.min(100, Number(analysis.score) || 0));
  document.querySelector("#thumbnailScore strong").textContent = Math.round(score);
  document.querySelector("#thumbnailVerdict").textContent = String(analysis.verdict || "Thumbnail review");
  document.querySelector("#thumbnailSummary").textContent = String(analysis.summary || "Analysis complete.");
  document.querySelector("#thumbnailRecommendation").textContent = String(analysis.recommendation || "Test a simplified variation against the current design.");
  renderList(document.querySelector("#thumbnailStrengths"), Array.isArray(analysis.strengths) ? analysis.strengths : []);
  renderList(document.querySelector("#thumbnailImprovements"), Array.isArray(analysis.improvements) ? analysis.improvements : []);
  document.querySelector("#thumbnailScore").style.setProperty("--score", `${score * 3.6}deg`);
  emptyState.hidden = true;
  output.hidden = false;
}

input.addEventListener("change", () => selectFile(input.files?.[0]));
removeButton.addEventListener("click", resetFile);
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    input.click();
  }
});
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
}));
dropzone.addEventListener("drop", (event) => selectFile(event.dataTransfer?.files?.[0]));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;
  if (!isGeminiAvailable()) {
    setStatus("Gemini is not configured for this workspace.", "error");
    return;
  }

  analyzeButton.disabled = true;
  analyzeButton.classList.add("is-loading");
  setStatus("Gemini is reviewing your thumbnail…", "loading");
  try {
    const base64 = await fileToBase64(selectedFile);
    const userContext = context.value.trim() || "No additional video context was provided.";
    const response = await requestGeminiText({
      systemInstruction: "You are an expert YouTube thumbnail strategist. Give specific, candid, visually grounded feedback. Return only valid JSON, without markdown.",
      contents: [{
        role: "user",
        parts: [
          { text: `Analyze this thumbnail for likely click performance. Consider visual hierarchy, contrast, subject clarity, text legibility at mobile size, emotional pull, curiosity, clutter, and audience fit. Video context: ${userContext}\nReturn this exact JSON shape: {"score": number from 0 to 100, "verdict": "short headline", "summary": "2-3 sentence assessment", "strengths": ["specific point", "specific point", "specific point"], "improvements": ["specific actionable point", "specific actionable point", "specific actionable point"], "recommendation": "one concrete redesign direction"}` },
          { inlineData: { data: base64, mimeType: imageMimeType(selectedFile) } }
        ]
      }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 1200, responseMimeType: "application/json" }
    });
    renderAnalysis(parseJson(response));
    setStatus("Analysis complete.", "success");
  } catch (error) {
    console.error("Thumbnail analysis failed.", error);
    setStatus("Gemini could not analyze this image. Please try again.", "error");
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.classList.remove("is-loading");
  }
});
