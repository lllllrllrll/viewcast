import {isGeminiAvailable, requestGeminiText} from "./gemini-client.js?v=8";
import {addNotifications} from "../components/notifications.js";
import {
  MAX_FILE_SIZE,
  fileFingerprint,
  imageMimeType,
  optimizedImage,
  parseJson,
  readCachedResult,
  renderList,
  saveCachedResult
} from "./thumbnail-analyzer.js?v=12";

const cachePrefix = "viewcastThumbnailComparison:";
const files = {v1: null, v2: null};
const urls = {v1: "", v2: ""};
const form = document.querySelector("#comparisonForm");
const button = document.querySelector("#compareThumbnails");
const status = document.querySelector("#comparisonStatus");
const title = document.querySelector("#comparisonTitle");

function setStatus(message, type = "") {
  status.textContent = message;
  status.dataset.type = type;
}

function updateButton() {
  button.disabled = !(files.v1 && files.v2 && title.value.trim());
}

function slotElements(slot) {
  const card = document.querySelector(`[data-comparison-slot="${slot}"]`);
  return {
    input: card.querySelector(".comparison-input"),
    dropzone: card.querySelector(".comparison-dropzone"),
    preview: card.querySelector(".comparison-preview"),
    image: card.querySelector(".comparison-preview img"),
    name: card.querySelector(".thumbnail-file-meta strong"),
    size: card.querySelector(".thumbnail-file-meta span"),
    remove: card.querySelector(".comparison-remove")
  };
}

function clearFile(slot) {
  const elements = slotElements(slot);
  files[slot] = null;
  elements.input.value = "";
  if (urls[slot]) URL.revokeObjectURL(urls[slot]);
  urls[slot] = "";
  elements.image.removeAttribute("src");
  elements.preview.hidden = true;
  elements.dropzone.hidden = false;
  updateButton();
  setStatus("");
}

function selectFile(slot, file) {
  if (!file) return;
  if (!imageMimeType(file)) {
    setStatus("Choose JPG, PNG, or WebP files for both versions.", "error");
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    setStatus("Each image must be 5 MB or smaller.", "error");
    return;
  }
  const elements = slotElements(slot);
  if (urls[slot]) URL.revokeObjectURL(urls[slot]);
  files[slot] = file;
  urls[slot] = URL.createObjectURL(file);
  elements.image.src = urls[slot];
  elements.name.textContent = file.name;
  elements.size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  elements.preview.hidden = false;
  elements.dropzone.hidden = true;
  updateButton();
  setStatus(files.v1 && files.v2
    ? title.value.trim() ? "Ready to compare." : "Enter the video title to continue."
    : "Add the other version to continue.");
}

function render(analysis) {
  if (analysis._videoTitle) title.value = analysis._videoTitle;
  const winner = String(analysis.winner || "No clear winner");
  const version1Score = Math.max(0, Math.min(10, Number(analysis.version1Score) || 0));
  const version2Score = Math.max(0, Math.min(10, Number(analysis.version2Score) || 0));
  document.querySelector("#comparisonWinner").textContent = winner;
  document.querySelector("#comparisonSummary").textContent = String(analysis.summary || "Comparison complete.");
  document.querySelector("#comparisonScoreV1").textContent = Number(version1Score.toFixed(1));
  document.querySelector("#comparisonScoreV2").textContent = Number(version2Score.toFixed(1));
  const normalizedWinner = winner.toLowerCase();
  document.querySelector("#comparisonCardV1").classList.toggle("winner", normalizedWinner.includes("version 1") || normalizedWinner.includes("tie"));
  document.querySelector("#comparisonCardV2").classList.toggle("winner", normalizedWinner.includes("version 2") || normalizedWinner.includes("tie"));
  document.querySelector("#comparisonRecommendation").textContent = String(analysis.recommendation || "Test both versions with your audience.");
  renderList(document.querySelector("#comparisonReasons"), Array.isArray(analysis.winnerReasons) ? analysis.winnerReasons : []);
  renderList(document.querySelector("#comparisonFeedback"), Array.isArray(analysis.feedback) ? analysis.feedback : []);
  document.querySelector("#comparisonOutput").hidden = false;
}

title.addEventListener("input", () => {
  updateButton();
  if (files.v1 && files.v2) setStatus(title.value.trim() ? "Ready to compare." : "Enter the video title to continue.");
});

["v1", "v2"].forEach((slot) => {
  const elements = slotElements(slot);
  elements.input.addEventListener("change", () => selectFile(slot, elements.input.files?.[0]));
  elements.remove.addEventListener("click", () => clearFile(slot));
  elements.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.input.click();
    }
  });
  ["dragenter", "dragover"].forEach((name) => elements.dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => elements.dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("dragging");
  }));
  elements.dropzone.addEventListener("drop", (event) => selectFile(slot, event.dataTransfer?.files?.[0]));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!files.v1 || !files.v2) return;
  if (!isGeminiAvailable()) {
    setStatus("Gemini is not configured for this workspace.", "error");
    return;
  }
  button.disabled = true;
  button.classList.add("is-loading");
  setStatus("Gemini is comparing both versions…", "loading");
  try {
    const videoTitle = title.value.trim();
    const cacheKey = `${cachePrefix}${fileFingerprint(files.v1)}:${fileFingerprint(files.v2)}:${videoTitle}`;
    const cached = readCachedResult(cacheKey);
    if (cached) {
      render(cached);
      setStatus("Showing your saved comparison.", "success");
      return;
    }
    const [version1, version2] = await Promise.all([optimizedImage(files.v1), optimizedImage(files.v2)]);
    const response = await requestGeminiText({
      systemInstruction: "You are an expert YouTube thumbnail strategist. Compare the two labeled images objectively and return only valid JSON, without markdown.",
      contents: [{role: "user", parts: [
        {text: `Compare two thumbnail versions for the title "${videoTitle}". The following images are Version 1, then Version 2. Score title alignment at 40%; use likely click performance, hierarchy, mobile readability, emotion, curiosity, clarity, and clutter for 60%. Scores are 0-10.`},
        {inlineData: version1},
        {inlineData: version2},
        {text: 'Return this exact JSON shape: {"winner":"Version 1, Version 2, or Tie","version1Score":0.0,"version2Score":0.0,"summary":"2-3 sentence comparison tied to the title","winnerReasons":["reason","reason","reason"],"feedback":["specific Version 1 feedback","specific Version 2 feedback","shared lesson"],"recommendation":"best combined redesign direction for this title"}'}
      ]}],
      generationConfig: {temperature: 0.25, maxOutputTokens: 480, responseMimeType: "application/json"}
    });
    const comparison = {...parseJson(response), _videoTitle: videoTitle};
    saveCachedResult(cacheKey, comparison);
    sessionStorage.setItem("viewcastLatestThumbnailComparison", cacheKey);
    render(comparison);
    addNotifications([
      {id: `thumbnail-comparison:${cacheKey}:winner`, title: `${comparison.winner || "Thumbnail comparison"} leads`, message: comparison.summary, href: "pages/thumbnail-analyzer.html?comparison=latest", tone: "teal"},
      {id: `thumbnail-comparison:${cacheKey}:recommendation`, title: "Best combined direction", message: comparison.recommendation, href: "pages/thumbnail-analyzer.html?comparison=latest", tone: "blue"}
    ]);
    setStatus("Comparison complete.", "success");
  } catch (error) {
    console.error("Thumbnail comparison failed.", error);
    setStatus("Gemini could not compare these images. Please try again.", "error");
  } finally {
    updateButton();
    button.classList.remove("is-loading");
  }
});

if (new URLSearchParams(window.location.search).get("comparison") === "latest") {
  const key = sessionStorage.getItem("viewcastLatestThumbnailComparison") || "";
  const comparison = readCachedResult(key);
  if (comparison) {
    document.querySelector("[data-thumbnail-tab='comparison']")?.click();
    render(comparison);
    setStatus("Showing your latest saved comparison.", "success");
  }
}
