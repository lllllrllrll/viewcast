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
let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;

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

function channelAverage(fieldName, selectedVideoId = "") {
  const values = channelVideos
    .filter((video) => video.id !== selectedVideoId)
    .map((video) => numberValue(video.statistics?.[fieldName]))
    .filter((value) => value !== null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratioLabel(value, average) {
  if (!average || value === null) return "No baseline";
  const ratio = value / average;
  if (ratio >= 1.15) return Math.round((ratio - 1) * 100) + "% above avg";
  if (ratio <= 0.85) return Math.round((1 - ratio) * 100) + "% below avg";
  return "Near avg";
}

function generateVideoInsights(video, analytics, retentionPoints, searchTerms) {
  const stats = video.statistics || {};
  const views = numberValue(stats.viewCount);
  const likes = numberValue(stats.likeCount);
  const comments = numberValue(stats.commentCount);
  const avgViews = channelAverage("viewCount", video.id);
  const avgLikes = channelAverage("likeCount", video.id);
  const avgComments = channelAverage("commentCount", video.id);
  const insights = [];

  if (avgViews && views !== null) {
    const lowViews = views < avgViews * 0.85;
    insights.push({
      title: lowViews ? "Packaging may be holding this video back" : "Topic and packaging are competitive",
      body: lowViews
        ? "This upload is " + ratioLabel(views, avgViews) + " on views compared with your other videos. Rework the title and thumbnail around the clearest viewer promise."
        : "This upload is " + ratioLabel(views, avgViews) + " on views. Use its title, thumbnail, and topic angle as a reference for future uploads.",
      label: "Views"
    });
  }

  if (avgLikes && likes !== null) {
    const weakLikeRate = views && likes / Math.max(views, 1) < avgLikes / Math.max(avgViews || views, 1);
    insights.push({
      title: weakLikeRate ? "Payoff may not match the promise" : "Viewer satisfaction is holding up",
      body: weakLikeRate
        ? "Likes are weaker than your channel baseline after accounting for views. Tighten the intro and deliver the main payoff sooner."
        : "Likes are healthy compared with your baseline. Keep the structure and repeat the parts that clearly satisfied viewers.",
      label: "Likes"
    });
  }

  if (analytics?.averageViewDuration) {
    insights.push({
      title: "Use average view duration to find the weak section",
      body: "Average view duration is " + durationFromSeconds(analytics.averageViewDuration) + ". Compare that timestamp against the video: if the main payoff starts after this point, move it earlier.",
      label: analytics.periodLabel || "AVD"
    });
  } else if (retentionPoints.length) {
    const lowest = retentionPoints.reduce((min, point) => point.ratio < min.ratio ? point : min, retentionPoints[0]);
    const totalSeconds = secondsFromIso(video.contentDetails?.duration) || 0;
    insights.push({
      title: "Retention shows a likely drop-off area",
      body: "The weakest sampled retention point is around " + (totalSeconds ? durationFromSeconds(lowest.position * totalSeconds) : Math.round(lowest.position * 100) + "%") + ". Review that section for slow pacing, topic drift, or a missed payoff.",
      label: "Retention"
    });
  }

  if (searchTerms.length) {
    insights.push({
      title: "Search intent is clear",
      body: "Top search phrase: " + searchTerms[0].term + ". Make sure the title, first 30 seconds, and pinned comment directly answer that intent.",
      label: "Search"
    });
  }

  if (avgComments && comments !== null && comments < avgComments * 0.75) {
    insights.push({
      title: "Comments are below your norm",
      body: "This video is getting fewer comments than similar uploads. Add a specific question near the end and pin a comment that invites a concrete response.",
      label: "Comments"
    });
  }

  if (!insights.length) {
    insights.push({
      title: "Not enough comparison data yet",
      body: "Load more uploads or reconnect YouTube Analytics so ViewCast can compare this video against your channel baseline.",
      label: "Data"
    });
  }

  return insights.slice(0, 3);
}

function updateVideoInsights(insights) {
  const items = document.querySelectorAll(".activity-item");
  items.forEach((item, index) => {
    const insight = insights[index] || {title: " ", body: " ", label: " "};
    item.querySelector("b").textContent = insight.title;
    item.querySelector("span").textContent = insight.body;
    item.querySelector("time").textContent = insight.label;
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

function updateTable(video, analytics, retentionPoints, insights = []) {
  const tbody = document.querySelector("table tbody");
  if (!tbody) return;
  const stats = video.statistics || {};
  const views = numberValue(stats.viewCount);
  const likes = numberValue(stats.likeCount);
  const comments = numberValue(stats.commentCount);
  const rows = [
    ["Comparison", "Views", ratioLabel(views, channelAverage("viewCount", video.id)), "Channel avg"],
    ["Comparison", "Likes", ratioLabel(likes, channelAverage("likeCount", video.id)), "Channel avg"],
    ["Comparison", "Comments", ratioLabel(comments, channelAverage("commentCount", video.id)), "Channel avg"],
    ["Private analytics", "Avg. view duration", analytics ? durationFromSeconds(analytics.averageViewDuration) : "Unavailable", analytics ? (analytics.periodLabel || "Analytics API") : "Needs owner access"],
    ["Action", "Top recommendation", insights[0]?.title || "Load more data", insights[0]?.label || "Insight"]
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
  const views = numberValue(stats.viewCount);
  const likes = numberValue(stats.likeCount);
  const comments = numberValue(stats.commentCount);
  setMetric(0, compactNumber(views), ratioLabel(views, channelAverage("viewCount", video.id)));
  setMetric(1, compactNumber(likes), ratioLabel(likes, channelAverage("likeCount", video.id)));
  setMetric(2, compactNumber(comments), ratioLabel(comments, channelAverage("commentCount", video.id)));
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
  const requestId = ++analysisRequestId;

  try {
    setBusy(true);
    setAnalyzerResultsVisible(false);
    setAnalyzerLoading(true);
    setStatus(readCachedAccessToken() ? "Loading video data from YouTube..." : "Requesting YouTube access...");
    if (videoUrlInput) videoUrlInput.value = "https://www.youtube.com/watch?v=" + videoId;
    updateLibrarySelection(videoId);
    const [video, analytics, retentionPoints, searchTerms] = await loadVideoAnalysisWithRetry(videoId);
    if (requestId !== analysisRequestId) return;

    updateLibrarySelection(video.id);
    const insights = generateVideoInsights(video, analytics, retentionPoints, searchTerms);
    updateMetrics(video, analytics);
    updateVideoInsights(insights);
    updateTable(video, analytics, retentionPoints, insights);
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    requestAnimationFrame(() => drawActualRetention(retentionPoints, video));
    const period = analytics?.periodLabel ? " (" + analytics.periodLabel + ")" : "";
    setStatus(analytics ? "Video insights generated from YouTube" + period + "." : "Video insights generated from public data. Private analytics are unavailable for this upload right now.");
    setLibraryStatus("Insights ready for " + (video.snippet?.title || "selected video") + ".");
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
    setStatus("Choose one of your videos or paste a valid YouTube video URL for insights.");
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
    setLibraryStatus(cachedVideos.length ? "Showing saved uploads. Pick a video to generate insights." : "Refresh videos to load uploads from your linked channel.");
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
    setLibraryStatus(videos.length ? "Select one of your uploads to generate insights." : "No uploads were found on your linked channel.");
  } catch (error) {
    console.error("Could not load channel videos.", error);
    setLibraryStatus(error.message || "Could not load videos from YouTube.");
  } finally {
    setLibraryBusy(false);
  }
}

clearAnalyzerResults();

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
      setLibraryStatus("Sign in and link a channel to generate video insights.");
      return;
    }

    const cachedVideos = readCachedVideos();
    if (cachedVideos.length) {
      renderVideoLibrary(cachedVideos);
      setLibraryStatus("Showing saved uploads. Pick a video to generate insights.");
    } else {
      setLibraryStatus("Loading uploads for video insights...");
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
