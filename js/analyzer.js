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

function secondsFromIso(value = "") {
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const [, hours = 0, minutes = 0, seconds = 0] = match.map((part) => Number(part || 0));
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
    : `
${Math.round(point.position * 100)}%`.trim());
  drawLineChart("retentionChart", actual, actual, labels, {ySuffix: "%"});
}

function updateSearchTerms(searchTerms) {
  const items = document.querySelectorAll(".activity-item");
  const rows = searchTerms.length ? searchTerms : [
    {
      term: "Search terms unavailable",
      views: null,
      periodLabel: "API"
    }
  ];

  items.forEach((item, index) => {
    const row = rows[index] || {term: " ", views: null, periodLabel: " "};
    item.querySelector("b").textContent = row.term;
    item.querySelector("span").textContent = row.views === null ? "YouTube Analytics did not return search phrase data." : wholeNumber(row.views) + " views from search";
    item.querySelector("time").textContent = row.periodLabel || " ";
  });
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

function updateTable(video, analytics, retentionPoints) {
  const tbody = document.querySelector("table tbody");
  if (!tbody) return;
  const stats = video.statistics || {};
  const rows = [
    ["Public stats", "Views", wholeNumber(stats.viewCount) || "Unavailable", "Data API"],
    ["Public stats", "Likes", wholeNumber(stats.likeCount) || "Unavailable", "Data API"],
    ["Public stats", "Comments", wholeNumber(stats.commentCount) || "Unavailable", "Data API"],
    ["Private analytics", "Avg. view %", analytics ? percent(analytics.averageViewPercentage) : "Unavailable", analytics ? (analytics.periodLabel || "Analytics API") : "Needs owner access"],
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
  setMetric(0, compactNumber(stats.viewCount), "Public");
  setMetric(1, compactNumber(stats.likeCount), "Public");
  setMetric(2, compactNumber(stats.commentCount), "Public");
  setMetric(3, analytics ? durationFromSeconds(analytics.averageViewDuration) : "", analytics ? (analytics.periodLabel || "Analytics") : "Unavailable");
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

  return [video, privateData.analytics, privateData.retentionPoints, privateData.searchTerms];
}

async function analyzeVideoById(videoId) {
  if (!videoId) return;

  // Check if channel is linked before analyzing
  const connection = localStorage.getItem("viewcastYouTubeConnection");
  if (!connection) {
    sessionStorage.setItem("viewcastPendingAnalyzerVideo", videoId);
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
    const [video, analytics, retentionPoints, searchTerms] = await loadVideoAnalysisWithRetry(videoId);
    if (requestId !== analysisRequestId) return;

    recordVideoAnalysis();
    updateLibrarySelection(video.id);
    updateMetrics(video, analytics);
    updateSearchTerms(searchTerms);
    updateTable(video, analytics, retentionPoints);
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    requestAnimationFrame(() => drawActualRetention(retentionPoints, video));
    const period = analytics?.periodLabel ? " (" + analytics.periodLabel + ")" : "";
    setStatus(analytics ? "Video analytics loaded from YouTube" + period + "." : "Public video details loaded. Private analytics are unavailable for this upload right now.");
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
