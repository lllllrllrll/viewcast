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
const previewThumbnail = document.getElementById("videoPreviewThumbnail");
const previewEmpty = document.getElementById("videoPreviewEmpty");
const previewTitle = document.getElementById("videoPreviewTitle");
const previewMeta = document.getElementById("videoPreviewMeta");
const previewDescription = document.getElementById("videoPreviewDescription");
const previewLink = document.getElementById("videoPreviewLink");
let currentUser = null;
let auth = null;

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

function updateVideoPreview(video) {
  const snippet = video.snippet || {};
  const title = snippet.title || "Selected video";
  const channel = snippet.channelTitle || "YouTube channel";
  const published = dateLabel(snippet.publishedAt);
  const duration = durationFromIso(video.contentDetails?.duration);
  const meta = [channel, published, duration].filter(Boolean).join(" - ");
  const thumbnail = bestThumbnail(snippet.thumbnails);

  if (previewTitle) previewTitle.textContent = title;
  if (previewMeta) previewMeta.textContent = meta || "Video details loaded from YouTube.";
  if (previewDescription) {
    previewDescription.textContent = truncate(snippet.description, 220) || "No public description is available for this video.";
  }

  if (previewThumbnail) {
    if (thumbnail) {
      previewThumbnail.src = thumbnail;
      previewThumbnail.alt = title + " thumbnail";
      previewThumbnail.hidden = false;
    } else {
      previewThumbnail.removeAttribute("src");
      previewThumbnail.alt = "";
      previewThumbnail.hidden = true;
    }
  }

  if (previewEmpty) previewEmpty.hidden = Boolean(thumbnail);
  if (previewLink) {
    previewLink.href = "https://www.youtube.com/watch?v=" + video.id;
    previewLink.hidden = false;
  }
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
  provider.setCustomParameters({prompt: "consent"});
  return provider;
}

function userHasGoogleProvider(user) {
  return user.providerData.some((provider) => provider.providerId === "google.com");
}

async function getCredential() {
  if (!currentUser) throw new Error("Sign in before analyzing a video.");
  const provider = createProvider();
  const result = userHasGoogleProvider(currentUser)
    ? await reauthenticateWithPopup(currentUser, provider)
    : await linkWithPopup(currentUser, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error("Google did not return a YouTube access token.");
  return credential;
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`}
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || "YouTube API request failed.");
  }
  return payload;
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

async function analyzeVideo(event) {
  event.preventDefault();
  const videoId = parseVideoId(videoUrlInput?.value || "");
  if (!videoId) {
    setStatus("Paste a valid YouTube video URL or video ID.");
    return;
  }

  try {
    setBusy(true);
    setStatus("Requesting YouTube access...");
    const credential = await getCredential();
    setStatus("Loading video data from YouTube...");
    const [video, analytics, retentionPoints] = await Promise.all([
      fetchVideo(videoId, credential.accessToken),
      fetchVideoAnalytics(videoId, credential.accessToken),
      fetchRetentionCurve(videoId, credential.accessToken)
    ]);

    updateVideoPreview(video);
    updateMetrics(video, analytics);
    drawActualRetention(retentionPoints);
    updateKeyMoments(video, analytics, retentionPoints);
    updateTable(video, analytics, retentionPoints);
    setStatus("Video data loaded from YouTube.");
  } catch (error) {
    console.error("Could not analyze video.", error);
    setStatus(error.message || "Could not analyze this video.");
  } finally {
    setBusy(false);
  }
}

if (form && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (!user) setStatus("Sign in before analyzing a video.");
  });
  form.addEventListener("submit", analyzeVideo);
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
