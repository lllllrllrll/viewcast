import { isGeminiAvailable, requestGeminiText } from "./gemini-client.js?v=8";
import { addNotifications } from "../components/notifications.js";
import {createBusySetter, createStatusSetter, setControlsDisabled} from "./services/ui-state.js?v=1";
import {createImageUpload} from "./modules/image-upload.js?v=1";
import {createThumbnailChat} from "./modules/thumbnail-chat.js?v=1";
import {
  cleanText,
  fileFingerprint,
  optimizedImage,
  parseJson,
  readCachedResult,
  renderList,
  saveCachedResult
} from "./modules/thumbnail-images.js?v=1";
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
let selectedVideoAnalytics = null;
const thumbnailCachePrefix = "viewcastThumbnailAnalysis:";

const setStatus = createStatusSetter(status, {reflectType: true});
const setAnalysisBusy = createBusySetter(analyzeButton, {busyClass: "is-loading", updateLabel: false});

function updateAnalyzeButton() {
  setControlsDisabled(analyzeButton, !(selectedFile && thumbnailTitle.value.trim()));
}

thumbnailTitle.addEventListener("input", () => {
  updateAnalyzeButton();
  if (selectedFile) {
    setStatus(thumbnailTitle.value.trim() ? "Ready to analyze." : "Enter the video title to continue.");
  }
});

const thumbnailChatController = createThumbnailChat({
  getFile: () => selectedFile,
  getTitle: () => thumbnailTitle.value.trim()
});

function resetAnalyzerState() {
  selectedVideoAnalytics = null;
  output.hidden = true;
  emptyState.hidden = false;
  thumbnailChat.hidden = true;
  thumbnailChatController.reset();
  updateAnalyzeButton();
  setStatus("");
}

const analyzerUpload = createImageUpload({
  input,
  dropzone,
  preview,
  image,
  name: fileName,
  size: fileSize,
  remove: removeButton,
  setStatus,
  onChange(file) {
    selectedFile = file;
    if (!file) {
      resetAnalyzerState();
      return;
    }
    emptyState.hidden = true;
    output.hidden = true;
    thumbnailChat.hidden = true;
    thumbnailChatController.reset();
    updateAnalyzeButton();
    setStatus(thumbnailTitle.value.trim() ? "Ready to analyze." : "Enter the video title to continue.");
  }
});

export function selectThumbnailFile(file, videoTitle = "", ownerAnalytics = null) {
  if (videoTitle) thumbnailTitle.value = videoTitle;
  selectedVideoAnalytics = ownerAnalytics?.source === "youtube-studio" ? ownerAnalytics : null;
  analyzerUpload.select(file);
}

function renderAnalysis(analysis) {
  thumbnailChatController.setAnalysis(analysis);
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

let comparisonModulePromise = null;
let videoPickerModulePromise = null;

document.querySelectorAll("[data-thumbnail-tab]").forEach((tab) => tab.addEventListener("click", () => {
  const activeMode = tab.dataset.thumbnailTab || "analysis";
  const comparisonActive = activeMode === "comparison";
  if (comparisonActive && !comparisonModulePromise) {
    comparisonModulePromise = import("./thumbnail-comparison.js?v=5");
  }
  if (activeMode === "videos" && !videoPickerModulePromise) {
    videoPickerModulePromise = import("../components/thumbnail-video-picker.js?v=5");
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;
  if (!isGeminiAvailable()) {
    setStatus("Gemini is not configured for this workspace.", "error");
    return;
  }
  setAnalysisBusy(true);
  setStatus("Gemini is reviewing your thumbnail…", "loading");
  try {
    const videoTitle = thumbnailTitle.value.trim();
    const studioFingerprint = selectedVideoAnalytics
      ? `:${selectedVideoAnalytics.periodLabel}:${selectedVideoAnalytics.views}:${selectedVideoAnalytics.averageViewPercentage}`
      : ":no-studio-data";
    const cacheKey = `${thumbnailCachePrefix}${fileFingerprint(selectedFile)}:${videoTitle}${studioFingerprint}`;
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
          { text: `Analyze this thumbnail together with the video title "${videoTitle}". Do not judge the image in isolation. First determine the promise, topic, and curiosity created by the title, then compare that promise with what the thumbnail communicates. Identify whether they reinforce each other, add complementary information, redundantly repeat each other, create confusion, or make conflicting promises. Make title–thumbnail alignment 40% of the overall score; use likely click performance, visual hierarchy, contrast, subject clarity, mobile text legibility, emotional pull, curiosity, and clutter for the remaining 60%. The score must be from 0 to 10 and may use one decimal place. ${selectedVideoAnalytics ? `Use this owner-only YouTube Studio context as supporting evidence, without inventing CTR or impressions: ${JSON.stringify(selectedVideoAnalytics)}.` : "No YouTube Studio performance data is attached, so keep performance claims predictive rather than factual."}\nReturn this exact JSON shape: {"score": 0.0, "verdict": "short headline", "summary": "2-3 sentence combined title and thumbnail assessment", "titleAlignment": "specific explanation of what the title promises, what the thumbnail promises, and whether they work together", "strengths": ["specific point", "specific point", "specific point"], "improvements": ["specific actionable point", "specific actionable point", "specific actionable point"], "recommendation": "one concrete redesign direction that better supports this title"}` },
          { inlineData: optimized }
        ]
      }],
      generationConfig: {temperature: 0.3, maxOutputTokens: 360, responseMimeType: "application/json"}
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
    setAnalysisBusy(false);
    updateAnalyzeButton();
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
