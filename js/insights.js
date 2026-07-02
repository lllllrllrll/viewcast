import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import { firebaseConfig, firebaseConfigured, geminiModel, googleOAuthClientId } from "./firebase-config.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const form = document.getElementById("videoAnalysisForm");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("insightChatForm");
const chatInput = document.getElementById("insightChatInput");

const tokenStorageKey = "viewcastYouTubeAccessToken";
const connectionStorageKey = "viewcastYouTubeConnection";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";

let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let googleIdentityScriptPromise = null;
let latestChannelSummary = null;
let chatHistory = [];

function setStatus(message) {
  let status = document.getElementById("videoAnalysisStatus");
  if (!status && form) {
    status = document.createElement("span");
    status.id = "videoAnalysisStatus";
    status.className = "analysis-status";
    form.append(status);
  }
  if (status) status.textContent = message || "";
}

function setBusy(isBusy, label = "Generate Insights") {
  if (!submitButton) return;
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "Analyzing..." : label;
}

function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: number >= 1000 ? 1 : 0
  }).format(number);
}

function wholeNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en").format(Math.round(number));
}

function durationFromSeconds(value) {
  const number = numberValue(value);
  if (number === null) return "";
  const totalSeconds = Math.max(0, Math.round(number));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function secondsFromIso(value = "") {
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function durationFromIso(value = "") {
  const seconds = secondsFromIso(value);
  return seconds === null ? "" : durationFromSeconds(seconds);
}

function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function bestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || "";
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function videosStorageKey() { return currentUser ? videosStorageKeyPrefix + currentUser.uid : ""; }

function readCachedVideos() {
  const key = videosStorageKey();
  if (!key) return [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(saved?.videos) ? saved.videos : [];
  } catch (error) { localStorage.removeItem(key); return []; }
}

function saveCachedVideos(videos) {
  const key = videosStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({ videos, savedAt: Date.now() }));
}

function setLibraryStatus(message) { if (videoLibraryStatus) videoLibraryStatus.textContent = message || ""; }

function setLibraryBusy(isBusy) {
  if (!refreshVideosButton) return;
  refreshVideosButton.disabled = isBusy;
  refreshVideosButton.textContent = isBusy ? "Loading..." : "Refresh Videos";
}

function updateLibrarySelection(videoId) {
  selectedVideoId = videoId || "";
  videoLibrary?.querySelectorAll(".video-library-card").forEach((card) => {
    const isActive = card.dataset.videoId === selectedVideoId;
    card.classList.toggle("active", isActive);
    card.setAttribute("aria-pressed", String(isActive));
  });
}

function renderVideoLibrary(videos = channelVideos) {
  channelVideos = Array.isArray(videos) ? videos : [];
  if (!videoLibrary) return;
  if (!channelVideos.length) {
    videoLibrary.innerHTML = '<div class="video-library-empty">No uploads loaded.</div>';
    return;
  }
  videoLibrary.innerHTML = channelVideos.map((video) => {
    const snippet = video.snippet || {};
    const stats = video.statistics || {};
    const meta = [dateLabel(snippet.publishedAt), wholeNumber(stats.viewCount) + " views"].filter(Boolean).join(" - ");
    return `<button class="video-library-card" type="button" data-video-id="${escapeHtml(video.id)}">
      <div class="video-library-thumb">
        <img src="${escapeHtml(bestThumbnail(snippet.thumbnails))}" alt="">
      </div>
      <div class="video-library-body"><b>${escapeHtml(snippet.title)}</b><span>${escapeHtml(meta)}</span></div>
    </button>`;
  }).join("");
  updateLibrarySelection(selectedVideoId);
}

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;
  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; script.onload = resolve; script.onerror = reject;
    document.head.append(script);
  });
  return googleIdentityScriptPromise;
}

async function getAccessToken() {
  const saved = JSON.parse(localStorage.getItem(tokenStorageKey) || "null");
  if (saved?.accessToken && saved.uid === currentUser?.uid && saved.expiresAt > Date.now() + 60000) return saved.accessToken;

  await loadGoogleIdentityServices();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: googleOAuthClientId,
      scope: scopes.join(" "),
      callback: (res) => {
        if (res.error) return reject(new Error(res.error));
        localStorage.setItem(tokenStorageKey, JSON.stringify({ accessToken: res.access_token, uid: currentUser.uid, expiresAt: Date.now() + 3000000 }));
        resolve(res.access_token);
      }
    });
    client.requestAccessToken();
  });
}

async function fetchChannelVideos(accessToken) {
  const functions = getFunctions();
  const getChannelData = httpsCallable(functions, 'getYouTubeChannelData');
  const channelRes = await getChannelData({ accessToken, mine: true });
  const playlistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("Uploads not found.");

  const getPlaylistItems = httpsCallable(functions, 'getYouTubePlaylistItems');
  const playlistRes = await getPlaylistItems({ accessToken, playlistId, maxResults: 50 });
  const ids = (playlistRes.data.items || []).map(i => i.contentDetails.videoId);

  const getVideos = httpsCallable(functions, 'getYouTubeVideos');
  const videosRes = await getVideos({ accessToken, ids });
  return videosRes.data.items || [];
}

async function buildGeminiChatReply(question, summary) {
  try {
    const functions = getFunctions();
    const generateAdvice = httpsCallable(functions, 'generateChannelAdvice');
    const result = await generateAdvice({
      question,
      history: chatHistory.slice(0, -1),
      context: summary,
      modelName: geminiModel
    });
    return result.data.text;
  } catch (error) {
    console.error(error);
    return "I'm having trouble connecting to my brain right now.";
  }
}

function appendChatMessage(role, message, addToHistory = true) {
  if (!chatMessages) return;
  const bubble = document.createElement("div");
  bubble.className = ["chat-message", role].join(" ");
  bubble.textContent = message;
  chatMessages.append(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (addToHistory) {
    chatHistory.push({ role: role === "user" ? "user" : "model", parts: [{ text: message }] });
  }
  return bubble;
}

function setChatSeedMessage(msg = "Hi! How can I help with your channel today?") {
  if (!chatMessages) return;
  chatMessages.innerHTML = ""; chatHistory = [];
  appendChatMessage("assistant", msg);
}

onAuthStateChanged(getAuth(), (user) => {
  currentUser = user;
  if (!user) return;
  const cached = readCachedVideos();
  if (cached.length) renderVideoLibrary(cached);
  loadVideoLibrary();
});

async function loadVideoLibrary() {
  try {
    setLibraryBusy(true);
    const token = await getAccessToken();
    const videos = await fetchChannelVideos(token);
    saveCachedVideos(videos);
    renderVideoLibrary(videos);
  } catch (e) { setLibraryStatus(e.message); } finally { setLibraryBusy(false); }
}

async function handleGenerateInsights(e) {
  e.preventDefault();
  try {
    setBusy(true); setAnalyzerLoading(true); setAnalyzerResultsVisible(false);
    const token = await getAccessToken();
    const videos = await fetchChannelVideos(token);
    // Simplified summary for example
    latestChannelSummary = { videoCount: videos.length, topVideo: videos[0]?.snippet?.title };
    setAnalyzerLoading(false); setAnalyzerResultsVisible(true);
    setStatus("Channel insights ready.");
  } catch (e) { setStatus(e.message); } finally { setBusy(false); setAnalyzerLoading(false); }
}

async function handleChatQuestion(e) {
  e.preventDefault();
  const q = chatInput.value.trim();
  if (!q) return;
  appendChatMessage("user", q);
  chatInput.value = "";
  const thinking = appendChatMessage("assistant", "Thinking...", false);
  const reply = await buildGeminiChatReply(q, latestChannelSummary);
  thinking.textContent = reply;
  chatHistory.push({ role: "model", parts: [{ text: reply }] });
}

function setAnalyzerLoading(l) { if (analyzerLoading) analyzerLoading.hidden = !l; }
function setAnalyzerResultsVisible(v) { analyzerDashboard?.classList.toggle("analyzer-results-hidden", !v); }
function clearAnalyzerResults() { setAnalyzerLoading(false); setAnalyzerResultsVisible(false); }

form?.addEventListener("submit", handleGenerateInsights);
chatForm?.addEventListener("submit", handleChatQuestion);
videoLibrary?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-video-id]");
  if (card) updateLibrarySelection(card.dataset.videoId);
});
refreshVideosButton?.addEventListener("click", loadVideoLibrary);
setChatSeedMessage();
clearAnalyzerResults();
