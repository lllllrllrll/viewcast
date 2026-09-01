import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import { isGeminiAvailable, requestGeminiContent } from "./gemini-client.js?v=8";
import { addNotifications } from "../components/notifications.js";
import {studioVideoCardsHtml, syncVideoLibrarySelection} from "../components/youtube-video-library.js?v=1";
import {getRenewedYouTubeAccessToken} from "./youtube-auth.js?v=4";
import {getPrivateVideoAnalytics} from "./analyzer-private-analytics.js?v=3";
import {startStudioAutoRefresh} from "./services/studio-auto-refresh.js?v=1";
import {parseJsonObject} from "./services/json.js?v=1";
import {createBusySetter, createStatusSetter, ensureStatusElement} from "./services/ui-state.js?v=1";
import {readCachedYouTubeVideos, saveCachedYouTubeVideos} from "./services/youtube-video-cache.js?v=1";
import {
  activeYouTubeChannelId,
  clearCachedYouTubeAccessToken,
  readCachedYouTubeAccessToken
} from "./services/youtube-session.js?v=1";
import {
  fetchChannelProfile,
  fetchChannelVideos,
  fetchVideoById
} from "./insights-youtube.js?v=5";
import {
  compactNumber,
  durationFromIso,
  durationFromSeconds,
  escapeHtml,
  numberValue,
  secondsFromIso,
  shortText,
  wholeNumber,
  youtubeCategoryName
} from "./insights-format.js?v=1";

/* global drawLineChart */

const form = document.getElementById("videoAnalysisForm");
const videoUrlInput = document.getElementById("videoUrl");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const videoAnalysisStorageKeyPrefix = "viewcastGeminiVideoAnalysis:";
const videoAnalysisCacheMaxAge = 24 * 60 * 60 * 1000;
const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";
let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let latestLinkedVideoContext = null;
let initialVideoId = "";
let timelineDismissHandler = null;

const setStatus = createStatusSetter(ensureStatusElement({
  id: "videoAnalysisStatus",
  parent: form,
  className: "analysis-status"
}));
const setBusy = createBusySetter(submitButton, {
  busyLabel: "Analyzing...",
  idleLabel: "Analyze"
});

function percent(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return `${Math.round(number * 10) / 10}%`;
}

function secondsFromTimestamp(value = "") {
  const parts = String(value).trim().split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function readCachedVideos() {
  return readCachedYouTubeVideos(currentUser?.uid, activeYouTubeChannelId());
}

function saveCachedVideos(videos) {
  saveCachedYouTubeVideos(currentUser?.uid, activeYouTubeChannelId(), videos);
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
    analysisVersion: 4,
    id: video.id || "",
    views: analytics?.views ?? "",
    likes: analytics?.likes ?? "",
    comments: analytics?.comments ?? "",
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

const setLibraryStatus = createStatusSetter(videoLibraryStatus);
const setLibraryBusy = createBusySetter(refreshVideosButton, {
  busyLabel: "Loading...",
  idleLabel: "Refresh Videos"
});

function updateLibrarySelection(videoId) {
  selectedVideoId = videoId || "";
  syncVideoLibrarySelection(videoLibrary, selectedVideoId);
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

  videoLibrary.innerHTML = studioVideoCardsHtml(channelVideos);

  if (!selectedVideoId || !channelVideos.some((video) => video.id === selectedVideoId)) {
    selectedVideoId = channelVideos[0]?.id || "";
  }
  if (selectedVideoId && videoUrlInput && !parseVideoId(videoUrlInput.value)) {
    videoUrlInput.value = `https://www.youtube.com/watch?v=${selectedVideoId}`;
  }
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
  return readCachedYouTubeAccessToken(currentUser?.uid, activeYouTubeChannelId());
}

function clearCachedAccessToken() {
  clearCachedYouTubeAccessToken();
}

async function requestAccessToken() {
  if (!currentUser) throw new Error("Sign in before analyzing a video.");
  return getRenewedYouTubeAccessToken(currentUser.uid, activeYouTubeChannelId());
}

async function getAccessToken() {
  return readCachedAccessToken() || requestAccessToken();
}

function setMetric(index, value, trend = "") {
  const card = document.querySelectorAll(".metric-card")[index];
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  if (valueEl) valueEl.textContent = value === "" || value === null || value === undefined ? " " : value;
  if (trendEl) trendEl.textContent = trend || " ";
}

function drawActualRetention(points, video, retentionError = null) {
  const emptyState = document.getElementById("retentionEmptyState");
  const chart = document.getElementById("retentionChart");
  if (!points.length || typeof drawLineChart !== "function") {
    if (typeof drawLineChart === "function") drawLineChart("retentionChart", [], [], []);
    const emptyMessage = emptyState?.querySelector("span");
    if (emptyMessage) {
      emptyMessage.textContent = retentionError
        ? `YouTube Analytics could not load retention: ${retentionError.message}`
        : "YouTube returned no audience-retention segments for this upload.";
    }
    if (emptyState) emptyState.hidden = false;
    if (chart) chart.setAttribute("aria-hidden", "true");
    return;
  }

  if (emptyState) emptyState.hidden = true;
  if (chart) chart.removeAttribute("aria-hidden");

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

function channelVideoContext(videos) {
  return videos.slice(0, 6).map((video) => ({
    id: video.id || "",
    title: video.snippet?.title || "Untitled video",
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.ownerAnalytics?.views) || 0,
    likes: numberValue(video.ownerAnalytics?.likes) || 0,
    comments: numberValue(video.ownerAnalytics?.comments) || 0,
    analyticsPeriod: video.ownerAnalytics?.periodLabel || "90D",
    duration: durationFromIso(video.contentDetails?.duration),
    youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId)
  }));
}

function videoAnalysisContext(video, analytics, retentionPoints, searchTerms, channelProfile, videos) {
  const durationSeconds = secondsFromIso(video.contentDetails?.duration) || 0;
  const views = videos.map((item) => numberValue(item.ownerAnalytics?.views)).filter((value) => value !== null);
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
      privateAnalytics: analytics ? {
        period: analytics.periodLabel || "Analytics API",
        views: Number(analytics.views) || 0,
        likes: Number(analytics.likes) || 0,
        comments: Number(analytics.comments) || 0,
        shares: Number(analytics.shares) || 0,
        subscribersGained: Number(analytics.subscribersGained) || 0,
        subscribersLost: Number(analytics.subscribersLost) || 0,
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
    "Inspect the attached public YouTube video directly, then combine what you observe with the supplied private analytics, retention samples, search terms, and compact channel comparison.",
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
          parts: [
            {
              fileData: {
                fileUri: `https://www.youtube.com/watch?v=${video.id}`,
                mimeType: "video/*"
              }
            },
            { text: prompt }
          ]
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
    return normalizeGeminiVideoAnalysis(parseJsonObject(text));
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
  `).join("") : `
    <div class="video-library-empty analyzer-empty-action">
      <strong>No timestamped suggestions yet</strong>
      <span>Gemini could not return timestamped suggestions for this YouTube upload. Press Analyze to retry.</span>
    </div>`;

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
  const retentionEmptyState = document.getElementById("retentionEmptyState");
  if (retentionEmptyState) retentionEmptyState.hidden = true;
  document.getElementById("retentionChart")?.removeAttribute("aria-hidden");
  renderTimeline([], 0);
}

function updateMetrics(video, analytics, geminiAnalysis = null) {
  const labels = geminiAnalysis?.metricLabels || {};
  const studioLabel = analytics?.periodLabel ? `Studio ${analytics.periodLabel}` : "Studio unavailable";
  setMetric(0, analytics ? compactNumber(analytics.views) : "—", labels.views || studioLabel);
  setMetric(1, analytics ? compactNumber(analytics.likes) : "—", labels.likes || studioLabel);
  setMetric(2, analytics ? compactNumber(analytics.comments) : "—", labels.comments || studioLabel);
  setMetric(3, analytics ? durationFromSeconds(analytics.averageViewDuration) : "—", labels.averageViewDuration || studioLabel);
}

async function loadVideoDetailsWithRetry(videoId, accessToken) {
  try {
    return await fetchVideoById(videoId, accessToken);
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    clearCachedAccessToken();
    setStatus("YouTube access needs to be refreshed. Please approve once to continue.");
    const refreshedToken = await requestAccessToken();
    return fetchVideoById(videoId, refreshedToken);
  }
}

async function loadPrivateAnalytics(videoId, accessToken) {
  try {
    const data = await getPrivateVideoAnalytics(videoId, accessToken);
    return {...data, retentionError: null, needsRefresh: false, errors: []};
  } catch (error) {
    return {
      analytics: null,
      retentionPoints: [],
      searchTerms: [],
      retentionError: error,
      needsRefresh: false,
      errors: [error]
    };
  }
}

async function loadVideoAnalysisWithRetry(videoId) {
  let accessToken = "";
  let video = channelVideos.find((item) => item.id === videoId) || null;
  let privateData = {analytics: null, retentionPoints: [], searchTerms: [], errors: []};

  try {
    accessToken = await getAccessToken();
    video = await loadVideoDetailsWithRetry(videoId, accessToken);
    privateData = await loadPrivateAnalytics(videoId, accessToken);

  } catch (error) {
    if (!video) throw error;
    console.warn("Private YouTube Studio data was unavailable.", error);
    throw new Error("YouTube Studio analytics could not be loaded. Relink the channel and approve Analytics access.");
  }

  privateData.errors.forEach((error) => {
    console.warn("Some private video analytics were not available.", error);
  });

  return [
    video,
    privateData.analytics,
    privateData.retentionPoints,
    privateData.searchTerms,
    accessToken,
    privateData.errors,
    privateData.retentionError
  ];
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
    const [video, analytics, retentionPoints, searchTerms, accessToken, , retentionError] = await loadVideoAnalysisWithRetry(videoId);
    if (requestId !== analysisRequestId) return;
    latestLinkedVideoContext = {
      video,
      analytics,
      retentionPoints,
      searchTerms
    };

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
    requestAnimationFrame(() => drawActualRetention(retentionPoints, video, retentionError));
    const period = analytics?.periodLabel ? " (" + analytics.periodLabel + ")" : "";
    const retentionStatus = retentionPoints.length
      ? ` ${retentionPoints.length} YouTube retention segments loaded.`
      : retentionError
        ? ` Retention request failed: ${retentionError.message}`
        : " YouTube returned no audience-retention segments for this upload.";
    setStatus(geminiAnalysis
      ? "Gemini analysis generated from private YouTube Studio data" + period + "." + retentionStatus
      : "Private YouTube Studio analytics loaded" + period + "." + retentionStatus);
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
    setAnalyzerResultsVisible(true);
    console.error("Could not analyze video.", error);
    updateMetrics(channelVideos.find((video) => video.id === videoId) || {}, null);
    updateSearchTerms([]);
    renderTimeline([], 0);
    setStatus(error.message || "Could not analyze this video. Try refreshing the linked uploads.");
  } finally {
    if (requestId === analysisRequestId) {
      setAnalyzerLoading(false);
      setBusy(false);
    }
  }
}

async function analyzeVideo(event) {
  event.preventDefault();
  const videoId = parseVideoId(videoUrlInput?.value || "") ||
    selectedVideoId ||
    channelVideos[0]?.id || "";
  if (!videoId) {
    setStatus("No video is selected. Refresh your uploads or paste a valid YouTube video URL.");
    return;
  }
  setStatus("Starting video analysis...");
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
  startStudioAutoRefresh(async () => {
    if (!currentUser || !activeYouTubeChannelId()) return;
    await loadVideoLibrary({allowPrompt: true});
    if (!selectedVideoId) return;
    const accessToken = readCachedAccessToken() || await requestAccessToken();
    const privateData = await loadPrivateAnalytics(selectedVideoId, accessToken);
    if (!privateData.analytics) return;
    const video = channelVideos.find((item) => item.id === selectedVideoId);
    if (!video) return;
    latestLinkedVideoContext = {...privateData, video};
    updateMetrics(video, privateData.analytics);
    updateSearchTerms(privateData.searchTerms);
    requestAnimationFrame(() => drawActualRetention(
      privateData.retentionPoints,
      video,
      privateData.retentionError
    ));
    setLibraryStatus("Studio statistics updated automatically.");
  });
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
