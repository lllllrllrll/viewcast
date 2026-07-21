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
let latestAnalysis = null;
let thumbnailChatHistory = [];
const comparisonFiles = {v1: null, v2: null};
const comparisonUrls = {v1: "", v2: ""};

function imageMimeType(file) {
  if (ALLOWED_TYPES.has(file?.type)) return file.type;
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || "";
}

function setStatus(message, type = "") {
  status.textContent = message;
  status.dataset.type = type;
}

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
  resetThumbnailChat();
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
  emptyState.hidden = true;
  output.hidden = true;
  resetThumbnailChat();
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
  latestAnalysis = analysis;
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
    const base64 = await fileToBase64(selectedFile);
    const recentConversation = thumbnailChatHistory.slice(-7)
      .map((message) => `${message.role === "user" ? "User" : "Gemini"}: ${message.text}`)
      .join("\n");
    const reply = await requestGeminiText({
      systemInstruction: "You are an expert YouTube thumbnail strategist answering follow-up questions about your prior visual analysis. Be concise, specific, honest about uncertainty, and ground every answer in the supplied thumbnail and analysis.",
      contents: [{role: "user", parts: [
        {text: `Original thumbnail analysis:\n${JSON.stringify(latestAnalysis)}\n\nVideo context: ${context.value.trim() || "None provided"}\n\nRecent conversation:\n${recentConversation}\n\nAnswer the user's latest question directly. Do not return JSON.`},
        {inlineData: {data: base64, mimeType: imageMimeType(selectedFile)}}
      ]}],
      generationConfig: {temperature: 0.45, maxOutputTokens: 700}
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

document.querySelectorAll("[data-thumbnail-tab]").forEach((tab) => tab.addEventListener("click", () => {
  const comparisonActive = tab.dataset.thumbnailTab === "comparison";
  document.querySelectorAll("[data-thumbnail-tab]").forEach((button) => {
    const active = button === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#analysisPanel").hidden = comparisonActive;
  document.querySelector("#comparisonPanel").hidden = !comparisonActive;
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

const comparisonForm = document.querySelector("#comparisonForm");
const comparisonButton = document.querySelector("#compareThumbnails");
const comparisonStatus = document.querySelector("#comparisonStatus");

function setComparisonStatus(message, type = "") {
  comparisonStatus.textContent = message;
  comparisonStatus.dataset.type = type;
}

function updateComparisonButton() {
  comparisonButton.disabled = !(comparisonFiles.v1 && comparisonFiles.v2);
}

function comparisonSlotElements(slot) {
  const card = document.querySelector(`[data-comparison-slot="${slot}"]`);
  return {
    card,
    input: card.querySelector(".comparison-input"),
    dropzone: card.querySelector(".comparison-dropzone"),
    preview: card.querySelector(".comparison-preview"),
    image: card.querySelector(".comparison-preview img"),
    name: card.querySelector(".thumbnail-file-meta strong"),
    size: card.querySelector(".thumbnail-file-meta span"),
    remove: card.querySelector(".comparison-remove")
  };
}

function clearComparisonFile(slot) {
  const elements = comparisonSlotElements(slot);
  comparisonFiles[slot] = null;
  elements.input.value = "";
  if (comparisonUrls[slot]) URL.revokeObjectURL(comparisonUrls[slot]);
  comparisonUrls[slot] = "";
  elements.image.removeAttribute("src");
  elements.preview.hidden = true;
  elements.dropzone.hidden = false;
  updateComparisonButton();
  setComparisonStatus("");
}

function selectComparisonFile(slot, file) {
  if (!file) return;
  if (!imageMimeType(file)) {
    setComparisonStatus("Choose JPG, PNG, or WebP files for both versions.", "error");
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    setComparisonStatus("Each image must be 5 MB or smaller.", "error");
    return;
  }
  const elements = comparisonSlotElements(slot);
  if (comparisonUrls[slot]) URL.revokeObjectURL(comparisonUrls[slot]);
  comparisonFiles[slot] = file;
  comparisonUrls[slot] = URL.createObjectURL(file);
  elements.image.src = comparisonUrls[slot];
  elements.name.textContent = file.name;
  elements.size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  elements.preview.hidden = false;
  elements.dropzone.hidden = true;
  updateComparisonButton();
  setComparisonStatus(comparisonFiles.v1 && comparisonFiles.v2 ? "Ready to compare." : "Add the other version to continue.");
}

["v1", "v2"].forEach((slot) => {
  const elements = comparisonSlotElements(slot);
  elements.input.addEventListener("change", () => selectComparisonFile(slot, elements.input.files?.[0]));
  elements.remove.addEventListener("click", () => clearComparisonFile(slot));
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
  elements.dropzone.addEventListener("drop", (event) => selectComparisonFile(slot, event.dataTransfer?.files?.[0]));
});

function renderComparison(analysis) {
  document.querySelector("#comparisonWinner").textContent = String(analysis.winner || "No clear winner");
  document.querySelector("#comparisonSummary").textContent = String(analysis.summary || "Comparison complete.");
  document.querySelector("#comparisonScoreV1").textContent = Math.max(0, Math.min(100, Math.round(Number(analysis.version1Score) || 0)));
  document.querySelector("#comparisonScoreV2").textContent = Math.max(0, Math.min(100, Math.round(Number(analysis.version2Score) || 0)));
  document.querySelector("#comparisonRecommendation").textContent = String(analysis.recommendation || "Test both versions with your audience.");
  renderList(document.querySelector("#comparisonReasons"), Array.isArray(analysis.winnerReasons) ? analysis.winnerReasons : []);
  renderList(document.querySelector("#comparisonFeedback"), Array.isArray(analysis.feedback) ? analysis.feedback : []);
  document.querySelector("#comparisonOutput").hidden = false;
}

comparisonForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!comparisonFiles.v1 || !comparisonFiles.v2) return;
  if (!isGeminiAvailable()) {
    setComparisonStatus("Gemini is not configured for this workspace.", "error");
    return;
  }
  comparisonButton.disabled = true;
  comparisonButton.classList.add("is-loading");
  setComparisonStatus("Gemini is comparing both versions…", "loading");
  try {
    const [version1Data, version2Data] = await Promise.all([
      fileToBase64(comparisonFiles.v1),
      fileToBase64(comparisonFiles.v2)
    ]);
    const userContext = document.querySelector("#comparisonContext").value.trim() || "No additional video context was provided.";
    const response = await requestGeminiText({
      systemInstruction: "You are an expert YouTube thumbnail strategist. Compare the two labeled images objectively and return only valid JSON, without markdown.",
      contents: [{role: "user", parts: [
        {text: `Compare two thumbnail versions for likely click performance, visual hierarchy, mobile readability, emotional pull, curiosity, clutter, and audience fit. Video context: ${userContext}\nThe next image is Version 1.`},
        {inlineData: {data: version1Data, mimeType: imageMimeType(comparisonFiles.v1)}},
        {text: "The next image is Version 2."},
        {inlineData: {data: version2Data, mimeType: imageMimeType(comparisonFiles.v2)}},
        {text: 'Return this exact JSON shape: {"winner":"Version 1, Version 2, or Tie","version1Score":0,"version2Score":0,"summary":"2-3 sentence comparison","winnerReasons":["reason","reason","reason"],"feedback":["specific Version 1 feedback","specific Version 2 feedback","shared lesson"],"recommendation":"best combined redesign direction"}'}
      ]}],
      generationConfig: {temperature: 0.3, maxOutputTokens: 1400, responseMimeType: "application/json"}
    });
    renderComparison(parseJson(response));
    setComparisonStatus("Comparison complete.", "success");
  } catch (error) {
    console.error("Thumbnail comparison failed.", error);
    setComparisonStatus("Gemini could not compare these images. Please try again.", "error");
  } finally {
    comparisonButton.disabled = false;
    comparisonButton.classList.remove("is-loading");
  }
});
