import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import { firebaseConfig, firebaseConfigured, googleOAuthClientId } from "./firebase-config.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const form = document.getElementById("videoAnalysisForm");
const videoUrlInput = document.getElementById("videoUrl");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const tokenStorageKey = "viewcastYouTubeAccessToken";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";
const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";
let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let initialVideoId = "";
let googleIdentityScriptPromise = null;

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

function setBusy(isBusy, label = "Analyze") {
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

function percent(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return `${Math.round(number * 10) / 10}%`;
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

function apiDate(date) { return date.toISOString().slice(0, 10); }
function daysAgo(days) { const date = new Date(); date.setDate(date.getDate() - days); return apiDate(date); }

function bestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || "";
}

function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

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

function usageDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function recordVideoAnalysis() {
  const key = "viewcastVideosAnalyzed";
  let usage = {day: usageDay(), count: 0};
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved?.day === usage.day) usage.count = Number(saved.count) || 0;
  } catch (error) { localStorage.removeItem(key); }
  usage.count += 1;
  localStorage.setItem(key, JSON.stringify(usage));
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
    videoLibrary.innerHTML = '<div class="video-library-empty">No uploads loaded. Refresh to pull from your channel.</div>';
    return;
  }
  videoLibrary.innerHTML = channelVideos.map((video) => {
    const snippet = video.snippet || {};
    const stats = video.statistics || {};
    const meta = [dateLabel(snippet.publishedAt), wholeNumber(stats.viewCount) ? wholeNumber(stats.viewCount) + " views" : ""].filter(Boolean).join(" - ");
    return `<button class="video-library-card" type="button" data-video-id="${escapeHtml(video.id)}">
      <div class="video-library-thumb">
        ${snippet.thumbnails ? `<img src="${escapeHtml(bestThumbnail(snippet.thumbnails))}" alt="">` : ""}
        <span class="video-library-duration">${escapeHtml(durationFromIso(video.contentDetails?.duration))}</span>
      </div>
      <div class="video-library-body"><b>${escapeHtml(snippet.title)}</b><span>${escapeHtml(meta)}</span></div>
    </button>`;
  }).join("");
  updateLibrarySelection(selectedVideoId);
}

function parseVideoId(value) {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/")[1];
    return url.searchParams.get("v") || url.pathname.split("/").pop();
  } catch (e) { return ""; }
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

async function fetchVideoAnalytics(videoId, accessToken) {
  const functions = getFunctions();
  const getAnalytics = httpsCallable(functions, 'getYouTubeAnalytics');
  const result = await getAnalytics({
    accessToken,
    startDate: "2005-01-01",
    endDate: apiDate(new Date()),
    metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage",
    filters: `video==${videoId}`
  });
  const row = result.data.rows?.[0];
  return row ? { views: row[0], estimatedMinutesWatched: row[1], averageViewDuration: row[2], averageViewPercentage: row[3] } : null;
}

async function analyzeVideoById(videoId) {
  if (!videoId) return;
  const connection = localStorage.getItem("viewcastYouTubeConnection");
  if (!connection) {
    sessionStorage.setItem(pendingAnalyzerVideoKey, videoId);
    window.location.href = "channel.html?link=required";
    return;
  }

  const plan = localStorage.getItem("viewcast:plan") || "basic";
  if (plan === "basic") {
    const usage = JSON.parse(localStorage.getItem("viewcastVideosAnalyzed") || "null");
    if (usage?.day === usageDay() && usage.count >= 5) {
      if (typeof window.showPlanModal === "function") window.showPlanModal("You've reached the daily limit. Upgrade to continue.");
      else window.location.href = "settings.html?upgrade=limit";
      return;
    }
  }

  const requestId = ++analysisRequestId;
  try {
    setBusy(true); setAnalyzerResultsVisible(false); setAnalyzerLoading(true);
    const accessToken = await getAccessToken();
    const functions = getFunctions();
    const getVideos = httpsCallable(functions, 'getYouTubeVideos');
    const videoRes = await getVideos({ accessToken, ids: [videoId] });
    const video = videoRes.data.items?.[0];
    if (!video) throw new Error("Video not found.");

    const [analytics, retentionRes, searchRes] = await Promise.all([
      fetchVideoAnalytics(videoId, accessToken),
      httpsCallable(functions, 'getYouTubeAnalytics')({ accessToken, startDate: "2005-01-01", endDate: apiDate(new Date()), metrics: "audienceWatchRatio", dimensions: "elapsedVideoTimeRatio", filters: `video==${videoId}`, sort: "elapsedVideoTimeRatio" }),
      httpsCallable(functions, 'getYouTubeAnalytics')({ accessToken, startDate: "2005-01-01", endDate: apiDate(new Date()), metrics: "views", dimensions: "insightTrafficSourceDetail", filters: `video==${videoId};insightTrafficSourceType==YT_SEARCH`, sort: "-views", maxResults: 3 })
    ]);

    if (requestId !== analysisRequestId) return;
    recordVideoAnalysis();
    updateMetrics(video, analytics);
    updateLibrarySelection(video.id);
    setAnalyzerLoading(false); setAnalyzerResultsVisible(true);
    setStatus("Analysis complete.");
  } catch (error) {
    setStatus(error.message);
  } finally { setBusy(false); setAnalyzerLoading(false); }
}

function updateMetrics(video, analytics) {
  const stats = video.statistics || {};
  setMetric(0, compactNumber(stats.viewCount), "Views");
  setMetric(1, compactNumber(stats.likeCount), "Likes");
  setMetric(2, compactNumber(stats.commentCount), "Comments");
  setMetric(3, analytics ? durationFromSeconds(analytics.averageViewDuration) : "N/A", "AVD");
}

function setMetric(idx, val, label) {
  const card = document.querySelectorAll(".metric-card")[idx];
  if (card) { card.querySelector(".metric-value").textContent = val; card.querySelector(".trend").textContent = label; }
}

function setAnalyzerLoading(l) { if (analyzerLoading) analyzerLoading.hidden = !l; }
function setAnalyzerResultsVisible(v) { analyzerDashboard?.classList.toggle("analyzer-results-hidden", !v); }
function clearAnalyzerResults() { setAnalyzerLoading(false); setAnalyzerResultsVisible(false); }

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

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = parseVideoId(videoUrlInput.value);
  if (id) analyzeVideoById(id);
});

videoLibrary?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-video-id]");
  if (card) analyzeVideoById(card.dataset.videoId);
});

refreshVideosButton?.addEventListener("click", loadVideoLibrary);
clearAnalyzerResults();
