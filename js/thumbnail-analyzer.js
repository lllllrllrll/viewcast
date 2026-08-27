import { isGeminiAvailable, requestGeminiText } from "./gemini-client.js?v=8";
import { addNotifications } from "../components/notifications.js";

export const MAX_FILE_SIZE = 5 * 1024 * 1024;
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
const thumbnailTitle = document.querySelector("#thumbnailTitle");
const emptyState = document.querySelector("#thumbnailEmptyState");
const output = document.querySelector("#thumbnailAnalysisOutput");
const thumbnailChat = document.querySelector("#thumbnailChat");
let selectedFile = null;
let previewUrl = "";
let latestAnalysis = null;
let thumbnailChatHistory = [];
const thumbnailCachePrefix = "viewcastThumbnailAnalysis:";
const RESULT_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_DIMENSION = 960;
const IMAGE_QUALITY = 0.76;

export function imageMimeType(file) {
  if (ALLOWED_TYPES.has(file?.type)) return file.type;
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || "";
}

function setStatus(message, type = "") {
  status.textContent = message;
  status.dataset.type = type;
}

function updateAnalyzeButton() {
  analyzeButton.disabled = !(selectedFile && thumbnailTitle.value.trim());
}

thumbnailTitle.addEventListener("input", () => {
  updateAnalyzeButton();
  if (selectedFile) {
    setStatus(thumbnailTitle.value.trim() ? "Ready to analyze." : "Enter the video title to continue.");
  }
});

function resetThumbnailChat() {
  latestAnalysis = null;
  thumbnailChatHistory = [];
  const messages = document.querySelector("#thumbnailChatMessages");
  messages.replaceChildren();
  const intro = document.createElement("div");
  intro.className = "chat-message assistant";
  intro.textContent = "I’ve reviewed this thumbnail. Ask me anything about the score or how I would improve it.";
  messages.append(intro);
  document.querySelector("#thumbnailChatInput").value = "";
  document.querySelector("#thumbnailChatStatus").textContent = "";
}

function resetFile() {
  selectedFile = null;
  input.value = "";
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  image.removeAttribute("src");
  preview.hidden = true;
  dropzone.hidden = false;
  output.hidden = true;
  emptyState.hidden = false;
  thumbnailChat.hidden = true;
  resetThumbnailChat();
  updateAnalyzeButton();
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
  emptyState.hidden = true;
  output.hidden = true;
  thumbnailChat.hidden = true;
  resetThumbnailChat();
  updateAnalyzeButton();
  setStatus(thumbnailTitle.value.trim() ? "Ready to analyze." : "Enter the video title to continue.");
}

export function selectThumbnailFile(file, videoTitle = "") {
  if (videoTitle) thumbnailTitle.value = videoTitle;
  selectFile(file);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Could not optimize the selected image."));
    element.src = source;
  });
}

export async function optimizedImage(file) {
  const source = await fileToDataUrl(file);
  const bitmap = typeof createImageBitmap === "function"
    ? await createImageBitmap(file)
    : await loadImage(source);
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
  if (scale === 1 && file.type === "image/webp") {
    bitmap.close?.();
    return {data: source.split(",")[1], mimeType: "image/webp"};
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const optimized = canvas.toDataURL("image/webp", IMAGE_QUALITY);
  return {data: optimized.split(",")[1], mimeType: "image/webp"};
}

export function fileFingerprint(file) {
  return [file?.name || "", file?.size || 0, file?.lastModified || 0].join(":");
}

export function readCachedResult(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved?.value || Date.now() - saved.savedAt > RESULT_CACHE_MAX_AGE) {
      localStorage.removeItem(key);
      return null;
    }
    return saved.value;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function saveCachedResult(key, value) {
  if (value) localStorage.setItem(key, JSON.stringify({value, savedAt: Date.now()}));
}

export function parseJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function renderList(element, items) {
  element.replaceChildren(...items.slice(0, 5).map((item) => {
    const li = document.createElement("li");
    li.textContent = cleanText(item, 220);
    return li;
  }));
}

function renderAnalysis(analysis) {
  latestAnalysis = analysis;
  if (analysis._videoTitle) thumbnailTitle.value = analysis._videoTitle;
  const score = Math.max(0, Math.min(10, Number(analysis.score) || 0));
  document.querySelector("#thumbnailScore strong").textContent = Number(score.toFixed(1));
  document.querySelector("#thumbnailVerdict").textContent = cleanText(analysis.verdict || "Thumbnail review", 80);
  document.querySelector("#thumbnailSummary").textContent = cleanText(analysis.summary || "Analysis complete.", 420);
  document.querySelector("#analyzedVideoTitle").textContent = thumbnailTitle.value.trim();
  document.querySelector("#thumbnailTitleAlignment").textContent = cleanText(
    analysis.titleAlignment || "The title and thumbnail should communicate one clear, complementary promise.",
    420
  );
  document.querySelector("#thumbnailRecommendation").textContent = cleanText(
    analysis.recommendation || "Test a simplified variation against the current design.",
    320
  );
  renderList(document.querySelector("#thumbnailStrengths"), Array.isArray(analysis.strengths) ? analysis.strengths : []);
  renderList(document.querySelector("#thumbnailImprovements"), Array.isArray(analysis.improvements) ? analysis.improvements : []);
  document.querySelector("#thumbnailScore").dataset.score = String(Math.round(score * 10));
  emptyState.hidden = true;
  output.hidden = false;
  thumbnailChat.hidden = false;
}

function appendThumbnailChatMessage(role, text) {
  const messages = document.querySelector("#thumbnailChatMessages");
  const message = document.createElement("div");
  message.className = `chat-message ${role}`;
  message.textContent = text;
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
}

const thumbnailChatForm = document.querySelector("#thumbnailChatForm");
const thumbnailChatInput = document.querySelector("#thumbnailChatInput");
const thumbnailChatSend = document.querySelector("#thumbnailChatSend");
const thumbnailChatStatus = document.querySelector("#thumbnailChatStatus");

document.querySelectorAll("#thumbnailChatPrompts button").forEach((button) => button.addEventListener("click", () => {
  thumbnailChatInput.value = button.textContent;
  thumbnailChatInput.focus();
}));

thumbnailChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = thumbnailChatInput.value.trim();
  if (!question || !selectedFile || !latestAnalysis) return;
  appendThumbnailChatMessage("user", question);
  thumbnailChatHistory.push({role: "user", text: question});
  thumbnailChatInput.value = "";
  thumbnailChatInput.disabled = true;
  thumbnailChatSend.disabled = true;
  thumbnailChatStatus.textContent = "Gemini is thinking…";
  thumbnailChatStatus.dataset.type = "loading";
  try {
    const recentConversation = thumbnailChatHistory.slice(-2)
      .map((message) => `${message.role === "user" ? "User" : "Gemini"}: ${message.text}`)
      .join("\n");
    const reply = await requestGeminiText({
      systemInstruction: "Answer thumbnail follow-ups concisely using only the supplied analysis. Be specific and honest about uncertainty.",
      contents: [{role: "user", parts: [
        {text: `Analysis:${JSON.stringify({score: latestAnalysis.score, verdict: latestAnalysis.verdict, titleAlignment: latestAnalysis.titleAlignment, improvements: latestAnalysis.improvements, recommendation: latestAnalysis.recommendation})}\nTitle:${thumbnailTitle.value.trim()}\nRecent chat:${recentConversation}\nAnswer the latest question directly.`}
      ]}],
      generationConfig: {temperature: 0.3, maxOutputTokens: 120}
    });
    const answer = reply || "I could not produce a useful answer for that question.";
    appendThumbnailChatMessage("assistant", answer);
    thumbnailChatHistory.push({role: "assistant", text: answer});
    thumbnailChatStatus.textContent = "";
    thumbnailChatStatus.dataset.type = "";
  } catch (error) {
    console.error("Thumbnail follow-up failed.", error);
    appendThumbnailChatMessage("assistant", "I couldn’t answer that right now. Please try again.");
    thumbnailChatStatus.textContent = "Gemini could not answer this question.";
    thumbnailChatStatus.dataset.type = "error";
  } finally {
    thumbnailChatInput.disabled = false;
    thumbnailChatSend.disabled = false;
    thumbnailChatInput.focus();
  }
});

let comparisonModulePromise = null;
let videoPickerModulePromise = null;

document.querySelectorAll("[data-thumbnail-tab]").forEach((tab) => tab.addEventListener("click", () => {
  const activeMode = tab.dataset.thumbnailTab || "analysis";
  const comparisonActive = activeMode === "comparison";
  if (comparisonActive && !comparisonModulePromise) {
    comparisonModulePromise = import("./thumbnail-comparison.js?v=3");
  }
  if (activeMode === "videos" && !videoPickerModulePromise) {
    videoPickerModulePromise = import("../components/thumbnail-video-picker.js?v=2");
  }
  document.querySelectorAll("[data-thumbnail-tab]").forEach((button) => {
    const active = button === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#analysisPanel").hidden = activeMode !== "analysis";
  document.querySelector("#comparisonPanel").hidden = activeMode !== "comparison";
  document.querySelector("#videosPanel").hidden = activeMode !== "videos";
}));

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
    const videoTitle = thumbnailTitle.value.trim();
    const cacheKey = `${thumbnailCachePrefix}${fileFingerprint(selectedFile)}:${videoTitle}`;
    const cachedAnalysis = readCachedResult(cacheKey);
    if (cachedAnalysis) {
      renderAnalysis(cachedAnalysis);
      setStatus("Showing your saved analysis.", "success");
      return;
    }

    const optimized = await optimizedImage(selectedFile);
    const response = await requestGeminiText({
      systemInstruction: "You are an expert YouTube thumbnail strategist. Give specific, candid, visually grounded feedback. Return only valid JSON, without markdown.",
      contents: [{
        role: "user",
        parts: [
          { text: `Analyze this thumbnail together with the video title "${videoTitle}". Do not judge the image in isolation. First determine the promise, topic, and curiosity created by the title, then compare that promise with what the thumbnail communicates. Identify whether they reinforce each other, add complementary information, redundantly repeat each other, create confusion, or make conflicting promises. Make title–thumbnail alignment 40% of the overall score; use likely click performance, visual hierarchy, contrast, subject clarity, mobile text legibility, emotional pull, curiosity, and clutter for the remaining 60%. The score must be from 0 to 10 and may use one decimal place.\nReturn this exact JSON shape: {"score": 0.0, "verdict": "short headline", "summary": "2-3 sentence combined title and thumbnail assessment", "titleAlignment": "specific explanation of what the title promises, what the thumbnail promises, and whether they work together", "strengths": ["specific point", "specific point", "specific point"], "improvements": ["specific actionable point", "specific actionable point", "specific actionable point"], "recommendation": "one concrete redesign direction that better supports this title"}` },
          { inlineData: optimized }
        ]
      }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 480, responseMimeType: "application/json" }
    });
    const analysis = {...parseJson(response), _videoTitle: videoTitle};
    saveCachedResult(cacheKey, analysis);
    sessionStorage.setItem("viewcastLatestThumbnailResult", cacheKey);
    renderAnalysis(analysis);
    addNotifications([
      {
        id: `thumbnail:${cacheKey}:score`,
        title: `Thumbnail scored ${Number(analysis.score || 0).toFixed(1)}/10`,
        message: analysis.summary,
        href: "pages/thumbnail-analyzer.html?result=latest",
        tone: Number(analysis.score || 0) >= 7 ? "teal" : "amber"
      },
      {
        id: `thumbnail:${cacheKey}:improvement`,
        title: "Thumbnail improvement",
        message: analysis.improvements?.[0] || analysis.recommendation,
        href: "pages/thumbnail-analyzer.html?result=latest",
        tone: "blue"
      }
    ]);
    setStatus("Analysis complete.", "success");
  } catch (error) {
    console.error("Thumbnail analysis failed.", error);
    setStatus("Gemini could not analyze this image. Please try again.", "error");
  } finally {
    updateAnalyzeButton();
    analyzeButton.classList.remove("is-loading");
  }
});

const notificationParams = new URLSearchParams(window.location.search);
if (notificationParams.get("result") === "latest") {
  const key = sessionStorage.getItem("viewcastLatestThumbnailResult") || "";
  const result = readCachedResult(key);
  if (result) {
    renderAnalysis(result);
    setStatus("Showing your latest saved thumbnail result.", "success");
  }
}
if (notificationParams.get("comparison") === "latest") {
  document.querySelector("[data-thumbnail-tab='comparison']")?.click();
}
