import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

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
const tokenStorageKey = "viewcastYouTubeAccessToken";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";
let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";

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
  return `
${Math.round(number * 10) / 10}%`.trim();
}

function durationFromSeconds(value) {
  const number = numberValue(value);
  if (number === null) return "";
  const totalSeconds = Math.max(0, Math.round(number));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours ? `
${hours}:${String(minutes).padStart(2, "0")}:${seconds}`.trim() : `
${minutes}:${seconds}`.trim();
}

function durationFromIso(value = "") {
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "";
  const [, hours = 0, minutes = 0, seconds = 0] = match.map((part) => Number(part || 0));
  return durationFromSeconds(hours * 3600 + minutes * 60 + seconds);
}

function truncate(value = "", maxLength = 180) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 1).trim() + "...";
}

function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function bestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url
    || thumbnails.standard?.url
    || thumbnails.high?.url
    || thumbnails.medium?.url
    || thumbnails.default?.url
    || "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function videosStorageKey() {
  return currentUser ? videosStorageKeyPrefix + currentUser.uid : "";
}

function readCachedVideos() {
  const key = videosStorageKey();
  if (!key) return [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(saved?.videos) ? saved.videos : [];
  } catch (error) {
    localStorage.removeItem(key);
    return [];
  }
}

function saveCachedVideos(videos) {
  const key = videosStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({
    videos,
    savedAt: Date.now()
  }));
}

function setLibraryStatus(message) {
  if (videoLibraryStatus) videoLibraryStatus.textContent = message || "";
}

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
    videoLibrary.innerHTML = '<div class="video-library-empty">No uploads are loaded yet. Refresh videos to pull from your linked channel.</div>';
    return;
  }

  videoLibrary.innerHTML = channelVideos.map((video) => {
    const snippet = video.snippet || {};
    const stats = video.statistics || {};
    const title = snippet.title || "Untitled video";
    const thumbnail = bestThumbnail(snippet.thumbnails);
    const published = dateLabel(snippet.publishedAt);
    const duration = durationFromIso(video.contentDetails?.duration);
    const views = wholeNumber(stats.viewCount);
    const meta = [published, views ? views + " views" : ""].filter(Boolean).join(" - ");
    return '<button class="video-library-card" type="button" data-video-id="' + escapeHtml(video.id) + '" aria-pressed="false">'
      + '<div class="video-library-thumb">'
      + (thumbnail ? '<img src="' + escapeHtml(thumbnail) + '" alt="' + escapeHtml(title) + ' thumbnail">' : '')
      + (duration ? '<span class="video-library-duration">' + escapeHtml(duration) + '</span>' : '')
      + '</div>'
      + '<div class="video-library-body"><b>' + escapeHtml(title) + '</b><span>' + escapeHtml(meta || "Upload") + '</span></div>'
      + '</button>';
  }).join("");

  updateLibrarySelection(selectedVideoId);
}

function parseVideoId(value) {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtu.be")) {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const shorts = url.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    if (shorts) return shorts[2];
  } catch (error) {
    return "";
  }

  return "";
}

function createProvider() {
  const provider = new GoogleAuthProvider();
  scopes.forEach((scope) => provider.addScope(scope));
  provider.setCustomParameters({include_granted_scopes: "true"});
  return provider;
}

function readCachedAccessToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(tokenStorageKey) || "null");
    if (saved?.accessToken && saved.uid === currentUser?.uid && saved.expiresAt > Date.now() + 60 * 1000) {
      return saved.accessToken;
    }
  } catch (error) {
    // Fall through and clear bad token cache below.
  }
  localStorage.removeItem(tokenStorageKey);
  return "";
}

function saveCachedAccessToken(accessToken) {
  if (!accessToken || !currentUser) return;
  localStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
}

function clearCachedAccessToken() {
  localStorage.removeItem(tokenStorageKey);
}

function userHasGoogleProvider(user) {
  return user.providerData.some((provider) => provider.providerId === "google.com");
}

async function requestAccessToken() {
  if (!currentUser) throw new Error("Sign in before analyzing a video.");
  const provider = createProvider();
  const result = userHasGoogleProvider(currentUser)
    ? await reauthenticateWithPopup(currentUser, provider)
    : await linkWithPopup(currentUser, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error("Google did not return a YouTube access token.");
  saveCachedAccessToken(credential.accessToken);
  return credential.accessToken;
}

async function getAccessToken() {
  return readCachedAccessToken() || requestAccessToken();
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`}
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "YouTube API request failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchUploadsPlaylistId(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchJson(url, accessToken);
  const playlistId = payload.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("No uploads playlist was found for your linked channel.");
  return playlistId;
}

async function fetchUploadVideoIds(accessToken) {
  const playlistId = await fetchUploadsPlaylistId(accessToken);
  const ids = [];
  let pageToken = "";

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await fetchJson(url, accessToken);
    payload.items?.forEach((item) => {
      const id = item.contentDetails?.videoId;
      if (id) ids.push(id);
    });
    pageToken = payload.nextPageToken || "";
  } while (pageToken);

  return ids;
}

async function fetchVideosByIds(videoIds, accessToken) {
  const videos = [];
  for (let index = 0; index < videoIds.length; index += 50) {
    const chunk = videoIds.slice(index, index + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", chunk.join(","));
    const payload = await fetchJson(url, accessToken);
    videos.push(...(payload.items || []));
  }
  return videos;
}

async function fetchChannelVideos(accessToken) {
  const videoIds = await fetchUploadVideoIds(accessToken);
  if (!videoIds.length) return [];
  return fetchVideosByIds(videoIds, accessToken);
}

async function fetchVideo(videoId, accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("id", videoId);
  const payload = await fetchJson(url, accessToken);
  const video = payload.items?.[0];
  if (!video) throw new Error("No video was found for that URL.");
  return video;
}

async function fetchVideoAnalytics(videoId, accessToken) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 28);
  const formatDate = (date) => date.toISOString().slice(0, 10);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", formatDate(startDate));
  url.searchParams.set("endDate", formatDate(endDate));
  url.searchParams.set("metrics", "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained");
  url.searchParams.set("filters", `video==${videoId}`);

  try {
    const payload = await fetchJson(url, accessToken);
    const row = payload.rows?.[0] || [];
    return {
      views: row[0],
      estimatedMinutesWatched: row[1],
      averageViewDuration: row[2],
      averageViewPercentage: row[3],
      likes: row[4],
      comments: row[5],
      shares: row[6],
      subscribersGained: row[7]
    };
  } catch (error) {
    console.warn("Video analytics were not available for this video.", error);
    return null;
  }
}

async function fetchRetentionCurve(videoId, accessToken) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 28);
  const formatDate = (date) => date.toISOString().slice(0, 10);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", formatDate(startDate));
  url.searchParams.set("endDate", formatDate(endDate));
  url.searchParams.set("metrics", "audienceWatchRatio");
  url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
  url.searchParams.set("filters", `video==${videoId}`);
  url.searchParams.set("sort", "elapsedVideoTimeRatio");

  try {
    const payload = await fetchJson(url, accessToken);
    return (payload.rows || []).map(([position, ratio]) => ({
      position: Number(position),
      ratio: Number(ratio)
    })).filter((point) => Number.isFinite(point.position) && Number.isFinite(point.ratio));
  } catch (error) {
    console.warn("Retention curve was not available for this video.", error);
    return [];
  }
}

function setMetric(index, value, trend = "") {
  const card = document.querySelectorAll(".metric-card")[index];
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  if (valueEl) valueEl.textContent = value || " ";
  if (trendEl) trendEl.textContent = trend || " ";
}

function drawActualRetention(points) {
  if (!points.length || typeof drawLineChart !== "function") {
    if (typeof drawLineChart === "function") drawLineChart("retentionChart", [], [], []);
    return;
  }

  const sampled = points.filter((_, index) => index % Math.max(1, Math.floor(points.length / 12)) === 0).slice(0, 12);
  const actual = sampled.map((point) => Math.round(point.ratio * 100));
  const labels = sampled.map((point) => `
${Math.round(point.position * 100)}%`.trim());
  drawLineChart("retentionChart", actual, actual, labels);
}

function updateKeyMoments(video, analytics, retentionPoints) {
  const items = document.querySelectorAll(".activity-item");
  const title = video.snippet?.title || "Selected video";
  const moments = [
    {
      title: "Video loaded",
      desc: title,
      time: durationFromIso(video.contentDetails?.duration) || "Video"
    },
    analytics ? {
      title: "Average view duration",
      desc: durationFromSeconds(analytics.averageViewDuration),
      time: "28D"
    } : {
      title: "Analytics unavailable",
      desc: "Private analytics require access to the video's channel.",
      time: "API"
    },
    retentionPoints.length ? {
      title: "Retention samples",
      desc: `
${retentionPoints.length} points returned by YouTube Analytics`.trim(),
      time: "Curve"
    } : {
      title: "Retention curve unavailable",
      desc: "YouTube did not return audience retention points for this video.",
      time: "API"
    }
  ];

  items.forEach((item, index) => {
    const moment = moments[index];
    if (!moment) return;
    item.querySelector("b").textContent = moment.title;
    item.querySelector("span").textContent = moment.desc || " ";
    item.querySelector("time").textContent = moment.time || " ";
  });
}

function updateTable(video, analytics, retentionPoints) {
  const tbody = document.querySelector("table tbody");
  if (!tbody) return;
  const stats = video.statistics || {};
  const rows = [
    ["Public stats", "Views", wholeNumber(stats.viewCount) || "Unavailable", "Data API"],
    ["Public stats", "Likes", wholeNumber(stats.likeCount) || "Unavailable", "Data API"],
    ["Public stats", "Comments", wholeNumber(stats.commentCount) || "Unavailable", "Data API"],
    ["Private analytics", "Avg. view %", analytics ? percent(analytics.averageViewPercentage) : "Unavailable", analytics ? "Analytics API" : "Needs owner access"],
    ["Private analytics", "Retention curve", retentionPoints.length ? `
${retentionPoints.length} samples`.trim() : "Unavailable", retentionPoints.length ? "Analytics API" : "Needs owner access"]
  ];

  tbody.innerHTML = rows.map(([segment, issue, recommendation, impact]) => `
    <tr>
      <td>${segment}</td>
      <td>${issue}</td>
      <td>${recommendation}</td>
      <td><span class="trend ${impact.includes("Unavailable") || impact.includes("Needs") ? "warn" : "good"}">${impact}</span></td>
    </tr>
  `).join("");
}

function updateMetrics(video, analytics) {
  const stats = video.statistics || {};
  setMetric(0, compactNumber(analytics?.views ?? stats.viewCount), analytics ? "28D" : "Total");
  setMetric(1, durationFromSeconds(analytics?.averageViewDuration) || durationFromIso(video.contentDetails?.duration), analytics ? "28D avg" : "Length");
  setMetric(2, analytics?.estimatedMinutesWatched !== undefined ? compactNumber(analytics.estimatedMinutesWatched / 60) : compactNumber(stats.likeCount), analytics ? "Watch hrs" : "Likes");
  setMetric(3, analytics?.subscribersGained !== undefined ? wholeNumber(analytics.subscribersGained) : wholeNumber(stats.commentCount), analytics ? "Subs gained" : "Comments");
}

async function loadVideoAnalysis(videoId, accessToken) {
  return Promise.all([
    fetchVideo(videoId, accessToken),
    fetchVideoAnalytics(videoId, accessToken),
    fetchRetentionCurve(videoId, accessToken)
  ]);
}

async function loadVideoAnalysisWithRetry(videoId) {
  let accessToken = await getAccessToken();

  try {
    return await loadVideoAnalysis(videoId, accessToken);
  } catch (error) {
    if (error.status !== 401) throw error;
    clearCachedAccessToken();
    setStatus("YouTube access expired. Please approve once to continue.");
    accessToken = await requestAccessToken();
    return loadVideoAnalysis(videoId, accessToken);
  }
}

async function analyzeVideoById(videoId) {
  if (!videoId) return;

  try {
    setBusy(true);
    setStatus(readCachedAccessToken() ? "Loading video data from YouTube..." : "Requesting YouTube access...");
    if (videoUrlInput) videoUrlInput.value = "https://www.youtube.com/watch?v=" + videoId;
    const [video, analytics, retentionPoints] = await loadVideoAnalysisWithRetry(videoId);

    updateLibrarySelection(video.id);
    updateMetrics(video, analytics);
    drawActualRetention(retentionPoints);
    updateKeyMoments(video, analytics, retentionPoints);
    updateTable(video, analytics, retentionPoints);
    setStatus("Video data loaded from YouTube.");
    setLibraryStatus("Analyzing " + (video.snippet?.title || "selected video") + ".");
  } catch (error) {
    console.error("Could not analyze video.", error);
    setStatus(error.message || "Could not analyze this video.");
  } finally {
    setBusy(false);
  }
}

async function analyzeVideo(event) {
  event.preventDefault();
  const videoId = parseVideoId(videoUrlInput?.value || "");
  if (!videoId) {
    setStatus("Choose one of your videos or paste a valid YouTube video URL.");
    return;
  }
  await analyzeVideoById(videoId);
}

async function loadVideoLibrary({allowPrompt = false} = {}) {
  if (!currentUser) return;

  const cachedVideos = readCachedVideos();
  if (cachedVideos.length) renderVideoLibrary(cachedVideos);

  const cachedToken = readCachedAccessToken();
  if (!cachedToken && !allowPrompt) {
    setLibraryStatus(cachedVideos.length ? "Showing saved uploads. Refresh videos to check for new uploads." : "Refresh videos to load uploads from your linked channel.");
    return;
  }

  try {
    setLibraryBusy(true);
    setLibraryStatus("Loading uploads from YouTube...");
    let accessToken = cachedToken || await getAccessToken();
    let videos;

    try {
      videos = await fetchChannelVideos(accessToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      clearCachedAccessToken();
      if (!allowPrompt) throw error;
      setLibraryStatus("YouTube access expired. Please approve once to refresh videos.");
      accessToken = await requestAccessToken();
      videos = await fetchChannelVideos(accessToken);
    }

    saveCachedVideos(videos);
    renderVideoLibrary(videos);
    setLibraryStatus(videos.length ? "Select one of your uploads to load its analytics." : "No uploads were found on your linked channel.");
  } catch (error) {
    console.error("Could not load channel videos.", error);
    setLibraryStatus(error.message || "Could not load videos from YouTube.");
  } finally {
    setLibraryBusy(false);
  }
}

if (form && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    selectedVideoId = "";
    if (!user) {
      channelVideos = [];
      renderVideoLibrary([]);
      setStatus("Sign in before analyzing a video.");
      setLibraryStatus("Sign in and link a channel to load your videos.");
      return;
    }

    const cachedVideos = readCachedVideos();
    if (cachedVideos.length) {
      renderVideoLibrary(cachedVideos);
      setLibraryStatus("Showing saved uploads. Refresh videos to check for new uploads.");
    } else {
      setLibraryStatus("Loading your linked channel uploads...");
    }
    loadVideoLibrary({allowPrompt: false});
  });
  form.addEventListener("submit", analyzeVideo);
  videoLibrary?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest("[data-video-id]");
    if (!card) return;
    analyzeVideoById(card.dataset.videoId);
  });
  refreshVideosButton?.addEventListener("click", () => loadVideoLibrary({allowPrompt: true}));
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
