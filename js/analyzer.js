import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured, googleOAuthClientId } from "./firebase-config.js";
import { isGeminiAvailable, requestGeminiContent } from "./gemini-client.js?v=7";
import { addNotifications } from "./notifications.js";
import {getRenewedYouTubeAccessToken} from "./youtube-auth.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const form = document.getElementById("videoAnalysisForm");
const videoUrlInput = document.getElementById("videoUrl");
const submitButton = form?.querySelector('button[type="submit"]');
const videoFileInput = document.getElementById("videoFile");
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const tokenStorageKey = "viewcastYouTubeAccessToken";
const connectionStorageKey = "viewcastYouTubeConnection";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";
const videosCacheVersion = 2;
const videoAnalysisStorageKeyPrefix = "viewcastGeminiVideoAnalysis:";
const videoAnalysisCacheMaxAge = 24 * 60 * 60 * 1000;
const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";
let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let initialVideoId = "";
let timelineDismissHandler = null;
let googleIdentityScriptPromise = null;
const maxUploadBytes = 15 * 1024 * 1024;

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

function secondsFromTimestamp(value = "") {
  const parts = String(value).trim().split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function truncate(value = "", maxLength = 180) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 1).trim() + "...";
}

function shortText(value = "", max = 320) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const youtubeCategoryNames = {
  "1": "Film & Animation",
  "2": "Autos & Vehicles",
  "10": "Music",
  "15": "Pets & Animals",
  "17": "Sports",
  "19": "Travel & Events",
  "20": "Gaming",
  "22": "People & Blogs",
  "23": "Comedy",
  "24": "Entertainment",
  "25": "News & Politics",
  "26": "Howto & Style",
  "27": "Education",
  "28": "Science & Technology"
};

function youtubeCategoryName(categoryId) {
  return youtubeCategoryNames[String(categoryId || "")] || "";
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

function apiDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return apiDate(date);
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

function activeChannelId() {
  try {
    return JSON.parse(localStorage.getItem(connectionStorageKey) || "null")?.channel?.id || "";
  } catch (error) {
    return "";
  }
}

function videosStorageKey() {
  return currentUser ? `${videosStorageKeyPrefix}${currentUser.uid}:${activeChannelId() || "none"}` : "";
}

function readCachedVideos() {
  const key = videosStorageKey();
  if (!key) return [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (saved?.version !== videosCacheVersion) {
      sessionStorage.removeItem(key);
      return [];
    }
    return Array.isArray(saved?.videos) ? saved.videos.filter((video) => !isLivestream(video)) : [];
  } catch (error) {
    sessionStorage.removeItem(key);
    return [];
  }
}

function saveCachedVideos(videos) {
  const key = videosStorageKey();
  if (!key) return;
  sessionStorage.setItem(key, JSON.stringify({
    version: videosCacheVersion,
    videos: videos.filter((video) => !isLivestream(video)),
    savedAt: Date.now()
  }));
}

function isLivestream(video = {}) {
  const broadcastState = video.snippet?.liveBroadcastContent;
  return Boolean(video.liveStreamingDetails) ||
    broadcastState === "live" ||
    broadcastState === "upcoming";
}

function videoAnalysisStorageKey(videoId = "") {
  return currentUser && videoId ? videoAnalysisStorageKeyPrefix + currentUser.uid + ":" + videoId : "";
}

function videoAnalysisFingerprint(video, analytics, retentionPoints, searchTerms) {
  return JSON.stringify({
    analysisVersion: 3,
    id: video.id || "",
    views: video.statistics?.viewCount || "",
    likes: video.statistics?.likeCount || "",
    comments: video.statistics?.commentCount || "",
    period: analytics?.periodLabel || "",
    averageViewDuration: analytics?.averageViewDuration || "",
    averageViewPercentage: analytics?.averageViewPercentage || "",
    retention: retentionPoints.slice(0, 12).map((point) => [point.position, point.ratio]),
    searchTerms: searchTerms.slice(0, 5).map((term) => [term.term, term.views])
  });
}

function readCachedGeminiVideoAnalysis(video, analytics, retentionPoints, searchTerms) {
  const key = videoAnalysisStorageKey(video.id);
  if (!key) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved?.analysis || saved.fingerprint !== videoAnalysisFingerprint(video, analytics, retentionPoints, searchTerms)) return null;
    if (Date.now() - saved.savedAt > videoAnalysisCacheMaxAge) {
      localStorage.removeItem(key);
      return null;
    }
    return saved.analysis;
  } catch (error) {
    localStorage.removeItem(key);
    return null;
  }
}

function saveCachedGeminiVideoAnalysis(video, analytics, retentionPoints, searchTerms, analysis) {
  const key = videoAnalysisStorageKey(video.id);
  if (!key || !analysis) return;
  localStorage.setItem(key, JSON.stringify({
    fingerprint: videoAnalysisFingerprint(video, analytics, retentionPoints, searchTerms),
    analysis,
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
  channelVideos = Array.isArray(videos)
    ? videos.filter((video) => !isLivestream(video))
    : [];
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
    const watchId = url.searchParams.get("v");
    if (watchId) return /^[a-zA-Z0-9_-]{11}$/.test(watchId) ? watchId : "";
    const shorts = url.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    if (shorts) return shorts[2];
  } catch (error) {
    return "";
  }

  return "";
}

function readCachedAccessToken() {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(tokenStorageKey) || "null"
    );
    if (saved?.accessToken && saved.uid === currentUser?.uid && saved.channelId === activeChannelId() && saved.expiresAt > Date.now() + 60 * 1000) {
      return saved.accessToken;
    }
  } catch (error) {
    // Fall through and clear bad token cache below.
  }
  localStorage.removeItem(tokenStorageKey);
  sessionStorage.removeItem(tokenStorageKey);
  return "";
}

function saveCachedAccessToken(accessToken) {
  if (!accessToken || !currentUser) return;
  sessionStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    channelId: activeChannelId(),
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
  localStorage.removeItem(tokenStorageKey);
}

function clearCachedAccessToken() {
  localStorage.removeItem(tokenStorageKey);
  sessionStorage.removeItem(tokenStorageKey);
}

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;
  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Identity Services could not load."));
    document.head.append(script);
  });
  return googleIdentityScriptPromise;
}

async function authorizedChannelId(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("mine", "true");
  const payload = await fetchJson(url, accessToken);
  return payload.items?.[0]?.id || "";
}

async function requestAccessToken() {
  if (!currentUser) throw new Error("Sign in before analyzing a video.");
  return getRenewedYouTubeAccessToken(currentUser.uid, activeChannelId());
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

async function fetchChannelProfile(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,brandingSettings,topicDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchJson(url, accessToken);
  const channel = payload.items?.[0];
  if (!channel) return null;

  return {
    id: channel.id || "",
    title: channel.snippet?.title || "",
    description: shortText(channel.snippet?.description || "", 700),
    customUrl: channel.snippet?.customUrl || "",
    keywords: shortText(channel.brandingSettings?.channel?.keywords || "", 500),
    subscriberCount: numberValue(channel.statistics?.subscriberCount) || 0,
    videoCount: numberValue(channel.statistics?.videoCount) || 0,
    viewCount: numberValue(channel.statistics?.viewCount) || 0,
    topicCategories: channel.topicDetails?.topicCategories || []
  };
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
    url.searchParams.set("part", "snippet,statistics,contentDetails,liveStreamingDetails");
    url.searchParams.set("id", chunk.join(","));
    const payload = await fetchJson(url, accessToken);
    videos.push(...(payload.items || []));
  }
  return videos.filter((video) => !isLivestream(video));
}

async function fetchChannelVideos(accessToken) {
  const videoIds = await fetchUploadVideoIds(accessToken);
  if (!videoIds.length) return [];
  return fetchVideosByIds(videoIds, accessToken);
}

async function fetchVideo(videoId, accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics,contentDetails,liveStreamingDetails");
  url.searchParams.set("id", videoId);
  const payload = await fetchJson(url, accessToken);
  const video = payload.items?.[0];
  if (!video) throw new Error("No video was found for that URL.");
  if (isLivestream(video)) {
    throw new Error("Livestreams are not supported by the Video Analyzer. Choose a regular video or Short.");
  }
  return video;
}

async function fetchVideoAnalyticsRange(videoId, accessToken, {startDate, endDate, label}) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage");
  url.searchParams.set("filters", `video==${videoId}`);

  const payload = await fetchJson(url, accessToken);
  const row = payload.rows?.[0];
  if (!row) return null;

  return {
    periodLabel: label,
    views: row[0],
    estimatedMinutesWatched: row[1],
    averageViewDuration: row[2],
    averageViewPercentage: row[3]
  };
}

async function fetchVideoAnalytics(videoId, accessToken) {
  const endDate = apiDate(new Date());
  const ranges = [
    {startDate: daysAgo(28), endDate, label: "28D"},
    {startDate: "2005-02-14", endDate, label: "Lifetime"}
  ];

  try {
    for (const range of ranges) {
      const analytics = await fetchVideoAnalyticsRange(videoId, accessToken, range);
      if (analytics) return analytics;
    }
    return null;
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
    console.warn("Video analytics were not available for this video.", error);
    return null;
  }
}

async function fetchRetentionCurveRange(videoId, accessToken, {startDate, endDate}) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", "audienceWatchRatio");
  url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
  url.searchParams.set("filters", `video==${videoId}`);
  url.searchParams.set("sort", "elapsedVideoTimeRatio");

  const payload = await fetchJson(url, accessToken);
  return (payload.rows || []).map(([position, ratio]) => ({
    position: Number(position),
    ratio: Number(ratio)
  })).filter((point) => Number.isFinite(point.position) && Number.isFinite(point.ratio));
}

async function fetchRetentionCurve(videoId, accessToken) {
  const endDate = apiDate(new Date());
  const ranges = [
    {startDate: daysAgo(28), endDate},
    {startDate: "2005-02-14", endDate}
  ];

  try {
    for (const range of ranges) {
      const points = await fetchRetentionCurveRange(videoId, accessToken, range);
      if (points.length) return points;
    }
    return [];
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
    console.warn("Retention curve was not available for this video.", error);
    return [];
  }
}

async function fetchSearchTermsRange(videoId, accessToken, {startDate, endDate, label}) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", "views");
  url.searchParams.set("dimensions", "insightTrafficSourceDetail");
  url.searchParams.set("filters", `video==${videoId};insightTrafficSourceType==YT_SEARCH`);
  url.searchParams.set("sort", "-views");
  url.searchParams.set("maxResults", "3");

  const payload = await fetchJson(url, accessToken);
  return (payload.rows || []).map(([term, views]) => ({
    term: term || "Unknown search term",
    views: Number(views) || 0,
    periodLabel: label
  }));
}

async function fetchSearchTerms(videoId, accessToken) {
  const endDate = apiDate(new Date());
  const ranges = [
    {startDate: daysAgo(28), endDate, label: "28D"},
    {startDate: "2005-02-14", endDate, label: "Lifetime"}
  ];

  try {
    for (const range of ranges) {
      const terms = await fetchSearchTermsRange(videoId, accessToken, range);
      if (terms.length) return terms;
    }
    return [];
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
    console.warn("YouTube search terms were not available for this video.", error);
    return [];
  }
}

function setMetric(index, value, trend = "") {
  const card = document.querySelectorAll(".metric-card")[index];
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  if (valueEl) valueEl.textContent = value === "" || value === null || value === undefined ? " " : value;
  if (trendEl) trendEl.textContent = trend || " ";
}

function drawActualRetention(points, video) {
  if (!points.length || typeof drawLineChart !== "function") {
    if (typeof drawLineChart === "function") drawLineChart("retentionChart", [], [], []);
    return;
  }

  const totalSeconds = secondsFromIso(video?.contentDetails?.duration) || 0;
  const sampled = points.filter((_, index) => index % Math.max(1, Math.floor(points.length / 12)) === 0).slice(0, 12);
  const actual = sampled.map((point) => Math.max(0, Math.min(200, Math.round(point.ratio * 100))));
  const labels = sampled.map((point) => totalSeconds
    ? durationFromSeconds(point.position * totalSeconds)
    : `${Math.round(point.position * 100)}%`);
  drawLineChart("retentionChart", actual, actual, labels, {ySuffix: "%"});
}

function retentionDipContext(retentionPoints, video, maxDips = 4) {
  const durationSeconds = secondsFromIso(video?.contentDetails?.duration) || 0;
  if (retentionPoints.length < 2) return [];
  // Compare short windows rather than only adjacent samples so gradual but
  // meaningful audience losses are surfaced alongside sharp single-point dips.
  const windowSize = Math.max(1, Math.round(retentionPoints.length * 0.03));
  const candidates = retentionPoints
    .slice(windowSize)
    .map((point, index) => {
      const previous = retentionPoints[index];
      const drop = previous.ratio - point.ratio;
      const positionPercent = Math.round(point.position * 100);
      const phase = positionPercent <= 15
        ? "Hook / intro"
        : positionPercent >= 85 ? "Ending / CTA" : "Main content";
      return {
        time: durationSeconds ? durationFromSeconds(point.position * durationSeconds) : `${Math.round(point.position * 100)}%`,
        startTime: durationSeconds ? durationFromSeconds(previous.position * durationSeconds) : `${Math.round(previous.position * 100)}%`,
        positionPercent,
        phase,
        fromPercent: Math.round(previous.ratio * 100),
        toPercent: Math.round(point.ratio * 100),
        dropPoints: Math.round(drop * 100),
        windowSeconds: durationSeconds ? Math.max(1, Math.round((point.position - previous.position) * durationSeconds)) : null
      };
    })
    .filter((dip) => dip.dropPoints >= 2)
    .sort((a, b) => b.dropPoints - a.dropPoints);

  const selected = [];
  for (const dip of candidates) {
    const overlapsExisting = selected.some((item) => Math.abs(item.positionPercent - dip.positionPercent) < 4);
    if (!overlapsExisting) selected.push(dip);
    if (selected.length >= maxDips) break;
  }
  return selected.map((dip, index) => ({...dip, rank: index + 1}));
}

function updateSearchTerms(searchTerms) {
  const panel = document.querySelector(".search-terms-panel");
  const activity = panel?.querySelector(".activity");
  if (!activity) return;

  activity.innerHTML = "";
  panel.hidden = !searchTerms.length;
  if (!searchTerms.length) return;

  activity.innerHTML = searchTerms.slice(0, 3).map((row) => `
    <div class="activity-item">
      <i class="dot"></i>
      <div>
        <b>${escapeHtml(row.term)}</b>
        <span>${escapeHtml(wholeNumber(row.views) + " views from search")}</span>
      </div>
      <time>${escapeHtml(row.periodLabel || " ")}</time>
    </div>
  `).join("");
}

function safeJsonParse(value) {
  const cleaned = String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  // Try standard parse first
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // If that fails, try to extract just the first object found
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        // Remove trailing commas which are common in LLM output but invalid in JSON
        const fixTrailingCommas = match[0].replace(/,[ \t\r\n]*([\]\}])/g, "$1");
        return JSON.parse(fixTrailingCommas);
      } catch (innerError) {
        console.warn("JSON repair failed:", innerError);
      }
    }
    return null;
  }
}

function channelVideoContext(videos) {
  return videos.slice(0, 6).map((video) => ({
    id: video.id || "",
    title: video.snippet?.title || "Untitled video",
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.statistics?.viewCount) || 0,
    likes: numberValue(video.statistics?.likeCount) || 0,
    comments: numberValue(video.statistics?.commentCount) || 0,
    duration: durationFromIso(video.contentDetails?.duration),
    youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId)
  }));
}

function videoAnalysisContext(video, analytics, retentionPoints, searchTerms, channelProfile, videos) {
  const stats = video.statistics || {};
  const durationSeconds = secondsFromIso(video.contentDetails?.duration) || 0;
  const views = videos.map((item) => numberValue(item.statistics?.viewCount)).filter((value) => value !== null);
  const averageViews = views.length ? Math.round(views.reduce((sum, value) => sum + value, 0) / views.length) : 0;
  const retentionSamples = retentionPoints
    .filter((_, index) => index % Math.max(1, Math.floor(retentionPoints.length / 5)) === 0)
    .slice(0, 5)
    .map((point) => ({
      time: durationSeconds ? durationFromSeconds(point.position * durationSeconds) : `${Math.round(point.position * 100)}%`,
      retentionPercent: Math.round(point.ratio * 100)
    }));
  const retentionDips = retentionDipContext(retentionPoints, video);

  return {
    channelProfile: channelProfile || {},
    selectedVideo: {
      id: video.id || "",
      title: video.snippet?.title || "Untitled video",
      description: shortText(video.snippet?.description || "", 140),
      tags: (video.snippet?.tags || []).slice(0, 4),
      publishedAt: video.snippet?.publishedAt || "",
      duration: durationFromIso(video.contentDetails?.duration),
      youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId),
      publicStats: {
        views: numberValue(stats.viewCount) || 0,
        likes: numberValue(stats.likeCount) || 0,
        comments: numberValue(stats.commentCount) || 0
      },
      privateAnalytics: analytics ? {
        period: analytics.periodLabel || "Analytics API",
        averageViewDuration: durationFromSeconds(analytics.averageViewDuration),
        averageViewPercentage: percent(analytics.averageViewPercentage),
        estimatedMinutesWatched: Math.round(analytics.estimatedMinutesWatched || 0)
      } : null,
      retentionSamples,
      retentionDips,
      youtubeSearchTerms: searchTerms.slice(0, 3).map((term) => ({
        term: term.term,
        views: term.views,
        period: term.periodLabel
      }))
    },
    channelComparison: {
      averageViews,
      recentUploads: channelVideoContext(videos)
    }
  };
}

function normalizeGeminiVideoAnalysis(value) {
  if (!value || typeof value !== "object") return null;
  const labels = value.metricLabels || {};
  const edits = Array.isArray(value.recommendedEdits)
    ? value.recommendedEdits.slice(0, 5).map((item) => ({
      segment: String(item.segment || "Overall").slice(0, 40),
      issue: String(item.issue || "Opportunity").slice(0, 80),
      recommendation: String(item.recommendation || "Make one clear improvement based on the supplied analytics.").slice(0, 220),
      impact: String(item.impact || "AI").slice(0, 32)
    }))
    : [];
  const timeline = Array.isArray(value.timelineInterestPoints)
    ? value.timelineInterestPoints.slice(0, 8).map((item) => ({
      timestamp: String(item.timestamp || "0:00").slice(0, 12),
      title: String(item.title || item.issue || "Improvement opportunity").slice(0, 90),
      suggestion: String(item.suggestion || item.recommendation || "Tighten this moment to keep viewers engaged.").slice(0, 260),
      severity: ["high", "medium", "low"].includes(String(item.severity).toLowerCase()) ? String(item.severity).toLowerCase() : "medium"
    }))
    : [];

  return {
    metricLabels: {
      views: String(labels.views || "Gemini").slice(0, 18),
      likes: String(labels.likes || "Gemini").slice(0, 18),
      comments: String(labels.comments || "Gemini").slice(0, 18),
      averageViewDuration: String(labels.averageViewDuration || "Gemini").slice(0, 18)
    },
    recommendedEdits: edits,
    timelineInterestPoints: timeline
  };
}

function retentionEditSuggestions(retentionPoints, video) {
  const dips = retentionDipContext(retentionPoints, video, 5);
  if (!dips.length) return [];

  return dips.map((dip) => {
    const isIntro = dip.positionPercent <= 15;
    return [
      dip.time,
      `${dip.dropPoints} point retention drop (${dip.fromPercent}% → ${dip.toPercent}%)`,
      isIntro
        ? "Tighten the opening: state the payoff sooner, cut setup, and show the strongest visual or result before the drop."
        : "Review this moment for repetition, slow setup, or a promise mismatch. Cut dead air, add a pattern interrupt, or move the next payoff before this timestamp.",
      "Retention dip"
    ];
  });
}

async function buildGeminiVideoAnalysis({video, analytics, retentionPoints, searchTerms, channelProfile, videos}) {
  if (!isGeminiAvailable()) return null;

  const prompt = [
    "You are ViewCast's YouTube video analyst. Return compact JSON only.",
    "Use only supplied selected-video data, private analytics, retention samples, search terms, and compact channel comparison.",
    "Metric labels must be short: Above avg, Needs lift, Strong, Watch drop, or Unavailable.",
    "Actively analyze retentionDips when present. Rank them by dropPoints, consider fromPercent, toPercent, windowSeconds, video phase, and nearby retention samples.",
    "For every major dip, state what the analytics prove, then label the cause as a likely hypothesis—not a certainty—because analytics alone cannot reveal the exact on-screen cause.",
    "Recommended edits must prioritize the largest retention drops. Each suggestion must name the exact dip timestamp, quantify the drop, explain likely viewer friction, and give a concrete edit or content change.",
    "Use practical fixes: shorten/rewrite the intro, move payoff earlier, cut repetition, add pattern interrupts, add chapter/card/pinned-comment recovery, tighten title-thumbnail promise, or make a follow-up/Shorts cutdown.",
    "If retention samples exist but retentionDips is empty, explicitly say there was no significant 2+ point drop in the sampled curve. If retention data is absent, say it is unavailable.",
    "Create timelineInterestPoints for the major retention drops before adding other opportunities. Use exact timestamps and include the measured before-to-after percentages in each title or suggestion.",
    "Return JSON only with this shape:",
    `{"metricLabels":{"views":"","likes":"","comments":"","averageViewDuration":""},"recommendedEdits":[{"segment":"","issue":"","recommendation":"","impact":""}],"timelineInterestPoints":[{"timestamp":"0:00","title":"","suggestion":"","severity":"high|medium|low"}]}`,
    "",
    "Video and channel data:",
    JSON.stringify(videoAnalysisContext(video, analytics, retentionPoints, searchTerms, channelProfile, videos))
  ].join("\n");

  try {
    const payload = await requestGeminiContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 520
      }
    });
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    return normalizeGeminiVideoAnalysis(safeJsonParse(text));
  } catch (error) {
    console.warn("Gemini video analysis failed.", error);
    return null;
  }
}

function fallbackTimeline(retentionPoints, video, edits = []) {
  const dips = retentionDipContext(retentionPoints, video, 6);
  if (dips.length) {
    return dips.map((dip, index) => ({
      timestamp: dip.time,
      title: `${dip.fromPercent}% → ${dip.toPercent}% retention (${dip.dropPoints}-point drop)`,
      suggestion: edits[index]?.recommendation || `${dip.phase}: analytics show viewers leaving between ${dip.startTime} and ${dip.time}. Check this window for slow pacing, repetition, or a delayed payoff, then tighten the edit or add a visual change before the drop.`,
      severity: dip.dropPoints >= 10 ? "high" : "medium"
    }));
  }
  return edits.slice(0, 5).map((item, index) => ({
    timestamp: item.segment.match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0] || durationFromSeconds(index * 30),
    title: item.issue,
    suggestion: item.recommendation,
    severity: index < 2 ? "high" : "medium"
  }));
}

function renderTimeline(points, durationSeconds = 0, recommendedEdits = []) {
  const markers = document.getElementById("timelineMarkers");
  const list = document.getElementById("timelinePoints");
  const duration = document.getElementById("timelineDuration");
  const ticks = document.getElementById("timelineTicks");
  const popover = document.getElementById("timelinePopover");
  const popoverTime = document.getElementById("timelinePopoverTime");
  const popoverTitle = document.getElementById("timelinePopoverTitle");
  const popoverSuggestion = document.getElementById("timelinePopoverSuggestion");
  const popoverEdit = document.getElementById("timelinePopoverEdit");
  const popoverClose = document.getElementById("timelinePopoverClose");
  if (!markers || !list) return;
  if (timelineDismissHandler) {
    document.removeEventListener("click", timelineDismissHandler);
    timelineDismissHandler = null;
  }
  const normalized = (points || []).slice(0, 8).map((point) => ({...point}));
  (recommendedEdits || []).slice(0, 5).forEach((edit, index) => {
    const timestamp = edit.segment.match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0];
    let target = timestamp
      ? normalized.find((point) => point.timestamp === timestamp)
      : normalized[index];
    if (!target) {
      target = {
        timestamp: timestamp || durationFromSeconds(index * 30),
        title: edit.issue,
        suggestion: edit.recommendation,
        severity: index < 2 ? "high" : "medium"
      };
      normalized.push(target);
    }
    target.edit = edit;
  });
  normalized.sort((a, b) => secondsFromTimestamp(a.timestamp) - secondsFromTimestamp(b.timestamp));
  let pinnedIndex = -1;
  const inferredDuration = Math.max(durationSeconds, ...normalized.map((point) => secondsFromTimestamp(point.timestamp)), 1);
  if (duration) {
    duration.textContent = durationSeconds
      ? `Video length ${durationFromSeconds(durationSeconds)}`
      : "";
  }
  if (ticks) {
    const tickCount = durationSeconds >= 120 ? 5 : 3;
    ticks.innerHTML = Array.from({length: tickCount}, (_, index) => {
      const ratio = index / (tickCount - 1);
      const timestamp = durationFromSeconds(Math.round(inferredDuration * ratio));
      return `<span class="timeline-position-${Math.round(ratio * 100)}">${escapeHtml(timestamp)}</span>`;
    }).join("");
  }
  if (popover) popover.hidden = true;
  markers.innerHTML = normalized.map((point, index) => {
    const position = Math.round(Math.min(100, Math.max(2, secondsFromTimestamp(point.timestamp) / inferredDuration * 100)));
    return `<button class="timeline-marker ${escapeHtml(point.severity)} timeline-position-${position}" type="button" data-timeline-index="${index}" aria-label="${escapeHtml(point.timestamp + ": " + point.title)}" aria-expanded="false"></button>`;
  }).join("");
  list.innerHTML = normalized.length ? normalized.map((point) => `
    <article class="timeline-point">
      <time>${escapeHtml(point.timestamp)}</time>
      <div>
        <b>${escapeHtml(point.title)}</b>
        <span>${escapeHtml(point.suggestion)}</span>
        ${point.edit ? `
          <div class="timeline-recommended-edit">
            <div><strong>Recommended edit</strong><em>${escapeHtml(point.edit.impact)}</em></div>
            <p>${escapeHtml(point.edit.recommendation)}</p>
            <small>${escapeHtml(point.edit.segment)}</small>
          </div>
        ` : ""}
      </div>
    </article>
  `).join("") : '<div class="video-library-empty">No timestamped improvement points were available for this analysis.</div>';

  const showPoint = (index, {pin = false} = {}) => {
    const point = normalized[index];
    if (!point || !popover) return;
    if (pin) pinnedIndex = index;
    if (popoverTime) popoverTime.textContent = `${point.timestamp} · ${point.severity} priority`;
    if (popoverTitle) popoverTitle.textContent = point.title;
    if (popoverSuggestion) popoverSuggestion.textContent = point.suggestion;
    if (popoverEdit) {
      popoverEdit.textContent = point.edit
        ? `Recommended edit: ${point.edit.recommendation}`
        : "";
      popoverEdit.hidden = !point.edit;
    }
    popover.hidden = false;
    markers.querySelectorAll(".timeline-marker").forEach((marker) => {
      const isActive = Number(marker.dataset.timelineIndex) === index;
      marker.classList.toggle("is-active", isActive);
      marker.setAttribute("aria-expanded", String(isActive));
    });
  };

  const closePoint = () => {
    pinnedIndex = -1;
    if (popover) popover.hidden = true;
    if (popoverEdit) popoverEdit.hidden = true;
    markers.querySelectorAll(".timeline-marker").forEach((marker) => {
      marker.classList.remove("is-active");
      marker.setAttribute("aria-expanded", "false");
    });
  };

  markers.querySelectorAll(".timeline-marker").forEach((marker) => {
    const index = Number(marker.dataset.timelineIndex);
    marker.addEventListener("mouseenter", () => showPoint(index));
    marker.addEventListener("focus", () => showPoint(index));
    marker.addEventListener("mouseleave", () => {
      if (pinnedIndex >= 0) showPoint(pinnedIndex);
      else closePoint();
    });
    marker.addEventListener("blur", () => {
      if (pinnedIndex >= 0) showPoint(pinnedIndex);
      else closePoint();
    });
    marker.addEventListener("click", () => {
      if (pinnedIndex === index) closePoint();
      else showPoint(index, {pin: true});
    });
    marker.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closePoint();
        marker.blur();
      }
    });
  });
  if (popoverClose) popoverClose.onclick = closePoint;
  timelineDismissHandler = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (pinnedIndex >= 0 && !target?.closest(".timeline-marker") && !target?.closest("#timelinePopover")) {
      closePoint();
    }
  };
  document.addEventListener("click", timelineDismissHandler);
}

function setAnalyzerLoading(isLoading) {
  if (analyzerLoading) analyzerLoading.hidden = !isLoading;
}

function setAnalyzerResultsVisible(isVisible) {
  analyzerDashboard?.classList.toggle("analyzer-results-hidden", !isVisible);
}

function clearAnalyzerResults() {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  document.querySelectorAll(".metric-card").forEach((card) => {
    const valueEl = card.querySelector(".metric-value");
    const trendEl = card.querySelector(".trend");
    if (valueEl) valueEl.textContent = " ";
    if (trendEl) trendEl.textContent = " ";
  });
  document.querySelectorAll(".activity-item").forEach((item) => {
    item.querySelector("b").textContent = " ";
    item.querySelector("span").textContent = " ";
    item.querySelector("time").textContent = " ";
  });
  if (typeof drawLineChart === "function") drawLineChart("retentionChart", [], [], []);
  renderTimeline([], 0);
}

function updateMetrics(video, analytics, geminiAnalysis = null) {
  const stats = video.statistics || {};
  const labels = geminiAnalysis?.metricLabels || {};
  setMetric(0, compactNumber(stats.viewCount), labels.views || "Public");
  setMetric(1, compactNumber(stats.likeCount), labels.likes || "Public");
  setMetric(2, compactNumber(stats.commentCount), labels.comments || "Public");
  setMetric(3, analytics ? durationFromSeconds(analytics.averageViewDuration) : "", labels.averageViewDuration || (analytics ? (analytics.periodLabel || "Analytics") : "Unavailable"));
}

async function loadVideoDetailsWithRetry(videoId, accessToken) {
  try {
    return await fetchVideo(videoId, accessToken);
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    clearCachedAccessToken();
    setStatus("YouTube access needs to be refreshed. Please approve once to continue.");
    const refreshedToken = await requestAccessToken();
    return fetchVideo(videoId, refreshedToken);
  }
}

async function loadPrivateAnalytics(videoId, accessToken) {
  const [analyticsResult, retentionResult, searchTermsResult] = await Promise.allSettled([
    fetchVideoAnalytics(videoId, accessToken),
    fetchRetentionCurve(videoId, accessToken),
    fetchSearchTerms(videoId, accessToken)
  ]);
  const errors = [analyticsResult, retentionResult, searchTermsResult]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);

  return {
    analytics: analyticsResult.status === "fulfilled" ? analyticsResult.value : null,
    retentionPoints: retentionResult.status === "fulfilled" ? retentionResult.value : [],
    searchTerms: searchTermsResult.status === "fulfilled" ? searchTermsResult.value : [],
    needsRefresh: errors.some((error) => error?.status === 401 || error?.status === 403),
    errors
  };
}

async function loadVideoAnalysisWithRetry(videoId) {
  let accessToken = await getAccessToken();
  const video = await loadVideoDetailsWithRetry(videoId, accessToken);
  let privateData = await loadPrivateAnalytics(videoId, accessToken);

  if (privateData.needsRefresh && !privateData.analytics && !privateData.retentionPoints.length) {
    clearCachedAccessToken();
    setStatus("YouTube Analytics access needs to be refreshed. Please approve once to continue.");
    accessToken = await requestAccessToken();
    privateData = await loadPrivateAnalytics(videoId, accessToken);
  }

  privateData.errors.forEach((error) => {
    console.warn("Some private video analytics were not available.", error);
  });

  return [video, privateData.analytics, privateData.retentionPoints, privateData.searchTerms, accessToken];
}

async function analyzeVideoById(videoId) {
  if (!videoId) return;

  // Check if channel is linked before analyzing
  const connection = localStorage.getItem("viewcastYouTubeConnection");
  if (!connection) {
    sessionStorage.setItem(pendingAnalyzerVideoKey, videoId);
    window.location.href = "channel.html?link=required";
    return;
  }

  const requestId = ++analysisRequestId;

  try {
    setBusy(true);
    setAnalyzerResultsVisible(false);
    setAnalyzerLoading(true);
    setStatus(readCachedAccessToken() ? "Loading video data from YouTube..." : "Requesting YouTube access...");
    if (videoUrlInput) videoUrlInput.value = "https://www.youtube.com/watch?v=" + videoId;
    sessionStorage.removeItem(pendingAnalyzerVideoKey);
    updateLibrarySelection(videoId);
    const [video, analytics, retentionPoints, searchTerms, accessToken] = await loadVideoAnalysisWithRetry(videoId);
    if (requestId !== analysisRequestId) return;

    const cachedGeminiAnalysis = readCachedGeminiVideoAnalysis(video, analytics, retentionPoints, searchTerms);
    let geminiAnalysis = cachedGeminiAnalysis;
    setStatus(cachedGeminiAnalysis
      ? "Using recently generated Gemini analysis..."
      : isGeminiAvailable() ? "Asking Gemini to analyze this video..." : "AI service unavailable. Showing YouTube API data only.");
    const videosForContext = channelVideos.length ? channelVideos : readCachedVideos();
    let channelProfile = null;
    if (!cachedGeminiAnalysis && accessToken) {
      try {
        channelProfile = await fetchChannelProfile(accessToken);
      } catch (error) {
        console.warn("Could not load channel profile for video analysis.", error);
      }
    }
    if (!cachedGeminiAnalysis) {
      geminiAnalysis = await buildGeminiVideoAnalysis({
        video,
        analytics,
        retentionPoints,
        searchTerms,
        channelProfile,
        videos: videosForContext.length ? videosForContext : [video]
      });
      saveCachedGeminiVideoAnalysis(video, analytics, retentionPoints, searchTerms, geminiAnalysis);
    }
    if (requestId !== analysisRequestId) return;

    updateLibrarySelection(video.id);
    updateMetrics(video, analytics, geminiAnalysis);
    updateSearchTerms(searchTerms);
    const hasAiTimeline = Boolean(geminiAnalysis?.timelineInterestPoints?.length);
    const timelinePoints = hasAiTimeline
      ? geminiAnalysis.timelineInterestPoints
      : fallbackTimeline(retentionPoints, video, geminiAnalysis?.recommendedEdits || []);
    renderTimeline(
      timelinePoints,
      secondsFromIso(video.contentDetails?.duration) || 0,
      hasAiTimeline ? (geminiAnalysis?.recommendedEdits || []) : []
    );
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    requestAnimationFrame(() => drawActualRetention(retentionPoints, video));
    const period = analytics?.periodLabel ? " (" + analytics.periodLabel + ")" : "";
    setStatus(geminiAnalysis
      ? "Gemini video analysis generated from YouTube data" + period + "."
      : (analytics ? "Video analytics loaded from YouTube" + period + "." : "Public video details loaded. Private analytics are unavailable for this upload right now."));
    setLibraryStatus("Analyzing " + (video.snippet?.title || "selected video") + ".");
    const notificationPoints = (geminiAnalysis?.timelineInterestPoints || [])
      .slice(0, 2)
      .map((point, index) => ({
        id: `video:${video.id}:point:${index}:${point.timestamp}`,
        title: `${point.timestamp} · ${point.title}`,
        message: point.suggestion,
        href: `pages/analyzer.html?video=${encodeURIComponent(video.id)}`,
        tone: point.severity === "high" ? "rose" : "amber"
      }));
    addNotifications([
      {
        id: `video:${video.id}:complete`,
        title: "Video analysis ready",
        message: video.snippet?.title || "Your selected video has new recommendations.",
        href: `pages/analyzer.html?video=${encodeURIComponent(video.id)}`,
        tone: "teal"
      },
      ...notificationPoints
    ]);
  } catch (error) {
    if (requestId !== analysisRequestId) return;
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(false);
    console.error("Could not analyze video.", error);
    setStatus(error.message || "Could not analyze this video.");
  } finally {
    if (requestId === analysisRequestId) {
      setAnalyzerLoading(false);
      setBusy(false);
    }
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The selected video could not be read."));
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.readAsDataURL(file);
  });
}

function readVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const seconds = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(objectUrl);
      resolve(seconds);
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(0);
    };
    video.src = objectUrl;
  });
}

async function analyzeUploadedVideo(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    setStatus("Choose a valid video file.");
    return;
  }
  if (file.size > maxUploadBytes) {
    setStatus("Choose a video smaller than 15 MB. A shorter export works best for direct analysis.");
    return;
  }
  if (!isGeminiAvailable()) {
    setStatus("AI analysis is unavailable until Gemini is configured.");
    return;
  }
  const requestId = ++analysisRequestId;
  try {
    setBusy(true);
    setAnalyzerResultsVisible(false);
    setAnalyzerLoading(true);
    setStatus(`Uploading and analyzing ${file.name}...`);
    updateLibrarySelection("");
    const [data, durationSeconds] = await Promise.all([readFileAsBase64(file), readVideoDuration(file)]);
    const prompt = [
      "Analyze the attached video as an expert video editor and audience-retention strategist.",
      "Inspect its visuals, audible content, pacing, hook, clarity, transitions, dead space, and opportunities for stronger engagement.",
      "Return JSON only. Give 3-6 timestamped improvement points tied to moments you can actually observe.",
      `Filename: ${file.name}. Duration: ${durationFromSeconds(durationSeconds)}.`,
      `Shape: {"recommendedEdits":[{"segment":"","issue":"","recommendation":"","impact":""}],"timelineInterestPoints":[{"timestamp":"0:00","title":"","suggestion":"","severity":"high|medium|low"}]}`
    ].join("\n");
    const payload = await requestGeminiContent({
      contents: [{role: "user", parts: [{text: prompt}, {inlineData: {mimeType: file.type, data}}]}],
      generationConfig: {responseMimeType: "application/json", maxOutputTokens: 520}
    });
    if (requestId !== analysisRequestId) return;
    const responseText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    const analysis = normalizeGeminiVideoAnalysis(safeJsonParse(responseText));
    if (!analysis) throw new Error("The video analysis returned an invalid response. Please try again.");
    const localVideo = {statistics: {}, contentDetails: {duration: ""}, snippet: {title: file.name}};
    updateMetrics(localVideo, null, {metricLabels: {views: "Uploaded file", likes: "Unavailable", comments: "Unavailable", averageViewDuration: "File length"}});
    setMetric(3, durationFromSeconds(durationSeconds), "File length");
    updateSearchTerms([]);
    renderTimeline(
      analysis.timelineInterestPoints,
      durationSeconds,
      analysis.recommendedEdits || []
    );
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    if (typeof drawLineChart === "function") drawLineChart("retentionChart", [], [], []);
    setStatus(`Analysis complete for ${file.name}. Uploaded files do not include YouTube performance metrics.`);
    setLibraryStatus(`Analyzed uploaded file: ${file.name}.`);
    addNotifications((analysis.timelineInterestPoints || []).slice(0, 2).map((point, index) => ({
      id: `upload:${file.name}:${file.size}:${index}:${point.timestamp}`,
      title: `${point.timestamp} · ${point.title}`,
      message: point.suggestion,
      href: "pages/analyzer.html",
      tone: point.severity === "high" ? "rose" : "amber"
    })));
  } catch (error) {
    if (requestId !== analysisRequestId) return;
    console.error("Could not analyze uploaded video.", error);
    setAnalyzerResultsVisible(false);
    setStatus(error.message || "Could not analyze the uploaded video.");
  } finally {
    if (requestId === analysisRequestId) {
      setAnalyzerLoading(false);
      setBusy(false);
      if (videoFileInput) videoFileInput.value = "";
    }
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

function initialVideoIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const rawVideo = params.get("video") || params.get("v") || sessionStorage.getItem(pendingAnalyzerVideoKey) || "";
  return parseVideoId(rawVideo);
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

clearAnalyzerResults();
initialVideoId = initialVideoIdFromUrl();
if (initialVideoId && videoUrlInput) {
  videoUrlInput.value = "https://www.youtube.com/watch?v=" + initialVideoId;
  setStatus("Opening selected video for analysis...");
}

if (form && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  onAuthStateChanged(auth, (user) => {
    currentUser = user || null;
    selectedVideoId = "";
    clearAnalyzerResults();
    if (!currentUser) {
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
    if (initialVideoId) analyzeVideoById(initialVideoId);
  });
  form.addEventListener("submit", analyzeVideo);
  videoLibrary?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest("[data-video-id]");
    if (!card) return;
    analyzeVideoById(card.dataset.videoId);
  });
  refreshVideosButton?.addEventListener("click", () => loadVideoLibrary({allowPrompt: true}));
  videoFileInput?.addEventListener("change", () => analyzeUploadedVideo(videoFileInput.files?.[0]));
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
