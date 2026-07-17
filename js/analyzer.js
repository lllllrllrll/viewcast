import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import { isGeminiAvailable, requestGeminiContent } from "./gemini-client.js";

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
const videoAnalysisStorageKeyPrefix = "viewcastGeminiVideoAnalysis:";
const videoAnalysisCacheMaxAge = 15 * 60 * 1000;
const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";
let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let initialVideoId = "";

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

function videoAnalysisStorageKey(videoId = "") {
  return currentUser && videoId ? videoAnalysisStorageKeyPrefix + currentUser.uid + ":" + videoId : "";
}

function videoAnalysisFingerprint(video, analytics, retentionPoints, searchTerms) {
  return JSON.stringify({
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
    if (Date.now() - saved.savedAt > videoAnalysisCacheMaxAge) return null;
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
  } catch (error) {
    localStorage.removeItem(key);
  }
  usage.count += 1;
  localStorage.setItem(key, JSON.stringify(usage));
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
    const watchId = url.searchParams.get("v");
    if (watchId) return /^[a-zA-Z0-9_-]{11}$/.test(watchId) ? watchId : "";
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
  if (!retentionPoints.length) return [];

  return retentionPoints
    .slice(1)
    .map((point, index) => {
      const previous = retentionPoints[index];
      const drop = previous.ratio - point.ratio;
      return {
        time: durationSeconds ? durationFromSeconds(point.position * durationSeconds) : `${Math.round(point.position * 100)}%`,
        fromPercent: Math.round(previous.ratio * 100),
        toPercent: Math.round(point.ratio * 100),
        dropPoints: Math.round(drop * 100)
      };
    })
    .filter((dip) => dip.dropPoints >= 4)
    .sort((a, b) => b.dropPoints - a.dropPoints)
    .slice(0, maxDips);
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
  return videos.slice(0, 10).map((video) => ({
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
    .filter((_, index) => index % Math.max(1, Math.floor(retentionPoints.length / 6)) === 0)
    .slice(0, 7)
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
      description: shortText(video.snippet?.description || "", 220),
      tags: (video.snippet?.tags || []).slice(0, 6),
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
      youtubeSearchTerms: searchTerms.slice(0, 5).map((term) => ({
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

  return {
    metricLabels: {
      views: String(labels.views || "Gemini").slice(0, 18),
      likes: String(labels.likes || "Gemini").slice(0, 18),
      comments: String(labels.comments || "Gemini").slice(0, 18),
      averageViewDuration: String(labels.averageViewDuration || "Gemini").slice(0, 18)
    },
    recommendedEdits: edits
  };
}

function retentionEditSuggestions(retentionPoints, video) {
  const dips = retentionDipContext(retentionPoints, video, 5);
  if (!dips.length) return [];

  return dips.map((dip, index) => {
    const isIntro = index === 0 && /^0:0|^0:1|^0:2/.test(dip.time);
    return [
      dip.time,
      `${dip.dropPoints} point retention drop`,
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
    "Recommended edits must prioritize retentionDips when present. Each suggestion should name the dip time or segment, explain the likely viewer friction, and give a concrete edit the creator can make.",
    "Use practical fixes: shorten/rewrite the intro, move payoff earlier, cut repetition, add pattern interrupts, add chapter/card/pinned-comment recovery, tighten title-thumbnail promise, or make a follow-up/Shorts cutdown.",
    "If retentionDips is empty, say retention data is unavailable and base edits on public stats/search intent only.",
    "Return JSON only with this shape:",
    `{"metricLabels":{"views":"","likes":"","comments":"","averageViewDuration":""},"recommendedEdits":[{"segment":"","issue":"","recommendation":"","impact":""}]}`,
    "",
    "Video and channel data:",
    JSON.stringify(videoAnalysisContext(video, analytics, retentionPoints, searchTerms, channelProfile, videos), null, 2)
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
        maxOutputTokens: 650
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
  const tbody = document.querySelector("table tbody");
  if (tbody) {
    tbody.innerHTML = Array.from({length: 3}, () => "<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>").join("");
  }
  if (typeof drawLineChart === "function") drawLineChart("retentionChart", [], [], []);
}

function updateTable(video, analytics, retentionPoints, geminiAnalysis = null) {
  const tbody = document.querySelector("table tbody");
  if (!tbody) return;
  const stats = video.statistics || {};
  const retentionRows = retentionEditSuggestions(retentionPoints, video);
  const rows = geminiAnalysis?.recommendedEdits?.length
    ? geminiAnalysis.recommendedEdits.map((item) => [
      item.segment,
      item.issue,
      item.recommendation,
      item.impact
    ])
    : retentionRows.length ? retentionRows : [
    ["Public stats", "Views", wholeNumber(stats.viewCount) || "Unavailable", "Data API"],
    ["Public stats", "Likes", wholeNumber(stats.likeCount) || "Unavailable", "Data API"],
    ["Public stats", "Comments", wholeNumber(stats.commentCount) || "Unavailable", "Data API"],
    ["Private analytics", "Avg. view %", analytics ? percent(analytics.averageViewPercentage) : "Unavailable", analytics ? (analytics.periodLabel || "Analytics API") : "Needs owner access"],
    ["Private analytics", "Retention curve", retentionPoints.length ? `${retentionPoints.length} samples` : "Unavailable", retentionPoints.length ? "Analytics API" : "Needs owner access"]
  ];

  tbody.innerHTML = rows.map(([segment, issue, recommendation, impact]) => `
    <tr>
      <td>${escapeHtml(segment)}</td>
      <td>${escapeHtml(issue)}</td>
      <td>${escapeHtml(recommendation)}</td>
      <td><span class="trend ${impact.includes("Unavailable") || impact.includes("Needs") ? "warn" : "good"}">${escapeHtml(impact)}</span></td>
    </tr>
  `).join("");
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

  // Check plan limits
  const plan = localStorage.getItem("viewcast:plan") || "basic";
  if (plan === "basic") {
    const usage = JSON.parse(localStorage.getItem("viewcastVideosAnalyzed") || "null");
    const currentDay = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
    if (usage?.day === currentDay && usage.count >= 5) {
      if (typeof window.showPlanModal === "function") {
        window.showPlanModal("You've reached the daily analysis limit for the Basic plan. Upgrade to continue.");
      } else {
        window.location.href = "settings.html?upgrade=limit";
      }
      return;
    }
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

    recordVideoAnalysis();
    updateLibrarySelection(video.id);
    updateMetrics(video, analytics, geminiAnalysis);
    updateSearchTerms(searchTerms);
    updateTable(video, analytics, retentionPoints, geminiAnalysis);
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    requestAnimationFrame(() => drawActualRetention(retentionPoints, video));
    const period = analytics?.periodLabel ? " (" + analytics.periodLabel + ")" : "";
    setStatus(geminiAnalysis
      ? "Gemini video analysis generated from YouTube data" + period + "."
      : (analytics ? "Video analytics loaded from YouTube" + period + "." : "Public video details loaded. Private analytics are unavailable for this upload right now."));
    setLibraryStatus("Analyzing " + (video.snippet?.title || "selected video") + ".");
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
    currentUser = user;
    selectedVideoId = "";
    clearAnalyzerResults();
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
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
