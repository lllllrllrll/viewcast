import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import { isGeminiAvailable, requestGeminiContent, requestGeminiText } from "./gemini-client.js?v=8";
import { addNotifications } from "./notifications.js";
import {getRenewedYouTubeAccessToken} from "./youtube-auth.js?v=3";
import {
  average,
  bestThumbnail,
  compactNumber,
  dateLabel,
  durationFromIso,
  durationFromSeconds,
  escapeHtml,
  median,
  numberValue,
  secondsFromIso,
  shortText,
  wholeNumber,
  youtubeCategoryName
} from "./insights-format.js?v=1";
import {
  fetchChannelProfile,
  fetchChannelVideos,
  fetchVideosByIds,
  fetchYouTubeJson as fetchJson
} from "./insights-youtube.js?v=1";
import * as insightsModel from "./insights-model.js?v=2";

const {
  bestUploadSlot,
  buildChannelSummary,
  buildCrossoverTrendSuggestions,
  buildNextVideoSuggestions,
  buildTopicIdeas,
  creatorContextLabel,
  currentTrendSignal,
  currentTrendSignals,
  detectChannelLane,
  diversifyTrendVideos,
  expansionTrendFallbacks,
  fetchTrendReferenceVideos,
  importantWords,
  isEnglishTrendVideo,
  isGroundedTrendLabel,
  isShort,
  isShortTrendVideo,
  lane,
  meaningfulCreatorContextWords,
  normalizedTitleWords,
  recommendedLength,
  readableTrendQuery,
  selectGlobalPopularTrends,
  selectOutsideTopicTrends,
  setInsightsCreatorContext,
  titleTopicPhrases,
  topVideos,
  trendAgeDays,
  trendEvidence,
  trendMomentumScore,
  trendQueriesForLane,
  trendReferenceText,
  uploadPerformanceContext
} = insightsModel;

const form = document.getElementById("videoAnalysisForm");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const refreshInsightsPageButton = document.getElementById("refreshInsightsPage");
const insightsHeaderActions = document.getElementById("insightsHeaderActions");
const insightRefreshEmpty = document.getElementById("insightRefreshEmpty");
const insightRefreshEmptyContent = document.getElementById("insightRefreshEmptyContent");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const insightErrorPanel = document.getElementById("insightErrorPanel");
const insightChannelEmpty = document.getElementById("insightChannelEmpty");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("insightChatForm");
const chatInput = document.getElementById("insightChatInput");
const insightTabs = [...document.querySelectorAll("[data-insights-tab]")];
const insightTabPanels = [...document.querySelectorAll("[data-insights-panel]")];

const tokenStorageKey = "viewcastYouTubeAccessToken";
const connectionStorageKey = "viewcastYouTubeConnection";
const allConnectionsStorageKey = "viewcastYouTubeAllConnections";
const channelStorageKey = "viewcastYouTubeChannel";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";
const insightsStorageKeyPrefix = "viewcastAiInsights:";
const recentTrendsStorageKeyPrefix = "viewcastRecentTrends:";
const channelContextStorageKeyPrefix = "viewcastChannelContext:";
const insightsCacheVersion = 29;
const insightsCacheMaxAge = 24 * 60 * 60 * 1000;

let currentUser = null;
let auth = null;
let db = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let latestChannelSummary = null;
let chatHistory = [];
let savedChannelContext = {channelTopic: "", channelContext: ""};

function setStatus(message) {
  let status = document.getElementById("videoAnalysisStatus");
  if (!status && analyzerLoading) {
    status = document.createElement("p");
    status.id = "videoAnalysisStatus";
    status.className = "analysis-status";
    analyzerLoading.querySelector(".analyzer-loader")?.append(status);
  }
  if (status) {
    status.textContent = message || "";
    status.hidden = !message;
  }
}

function setBusy(isBusy, label = latestChannelSummary ? "Refresh Insights" : "Generate Insights") {
  if (submitButton) {
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy ? "Analyzing..." : label;
  }
  if (refreshInsightsPageButton) {
    refreshInsightsPageButton.disabled = isBusy;
    const labelElement = refreshInsightsPageButton.querySelector("span");
    if (labelElement) labelElement.textContent = isBusy ? "Analyzing..." : label;
  }
}

function videosStorageKey() {
  return currentUser ? `${videosStorageKeyPrefix}${currentUser.uid}:${activeChannelId() || "none"}` : "";
}

function activeChannelId() {
  try {
    return JSON.parse(localStorage.getItem(connectionStorageKey) || "null")?.channel?.id || "";
  } catch (error) {
    return "";
  }
}

function readCachedVideos() {
  const key = videosStorageKey();
  if (!key) return [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    return Array.isArray(saved?.videos) ? saved.videos : [];
  } catch (error) {
    sessionStorage.removeItem(key);
    return [];
  }
}

function saveCachedVideos(videos) {
  const key = videosStorageKey();
  if (!key) return;
  sessionStorage.setItem(key, JSON.stringify({
    videos,
    savedAt: Date.now()
  }));
}

function insightsStorageKey(focusVideoId = "") {
  return currentUser ? `${insightsStorageKeyPrefix}${currentUser.uid}:${activeChannelId() || "none"}:${focusVideoId || "channel"}` : "";
}

function insightsFingerprint(videos, focusVideoId = "") {
  return JSON.stringify({
    version: insightsCacheVersion,
    focusVideoId,
    channelTopic: savedChannelContext.channelTopic,
    channelContext: savedChannelContext.channelContext,
    videos: videos.slice(0, 40).map((video) => ({
      id: video.id,
      publishedAt: video.snippet?.publishedAt || "",
      title: video.snippet?.title || "",
      views: video.statistics?.viewCount || "",
      likes: video.statistics?.likeCount || "",
      comments: video.statistics?.commentCount || ""
    }))
  });
}

function channelContextStorageKey() {
  return currentUser ? `${channelContextStorageKeyPrefix}${currentUser.uid}` : "";
}

function normalizeSavedChannelContext(value = {}) {
  return {
    channelTopic: String(value.channelTopic || "").trim().slice(0, 120),
    channelContext: String(value.channelContext || "").trim().slice(0, 1000)
  };
}

function restoreSavedConnections(profile = {}) {
  const cloudConnections = Array.isArray(profile.youtubeConnections)
    ? profile.youtubeConnections.filter((connection) => connection?.channel?.id)
    : [];
  const connections = cloudConnections.length
    ? cloudConnections
    : (profile.youtubeConnection?.channel?.id ? [profile.youtubeConnection] : []);
  if (!connections.length) return;

  let activeConnection = null;
  try {
    const cachedId = JSON.parse(localStorage.getItem(connectionStorageKey) || "null")?.channel?.id;
    activeConnection = connections.find((connection) => connection.channel.id === cachedId) || connections[0];
  } catch {
    activeConnection = connections[0];
  }

  localStorage.setItem(allConnectionsStorageKey, JSON.stringify(connections));
  localStorage.setItem(connectionStorageKey, JSON.stringify(activeConnection));
  localStorage.setItem(channelStorageKey, JSON.stringify(activeConnection.channel));
}

async function loadSavedChannelContext() {
  savedChannelContext = {channelTopic: "", channelContext: ""};
  setInsightsCreatorContext(savedChannelContext);
  const key = channelContextStorageKey();
  if (!key) return savedChannelContext;
  const hasLocalValue = Boolean(sessionStorage.getItem(key));

  try {
    savedChannelContext = normalizeSavedChannelContext(JSON.parse(sessionStorage.getItem(key) || "{}"));
    setInsightsCreatorContext(savedChannelContext);
  } catch {
    sessionStorage.removeItem(key);
  }

  if (!db || !currentUser) return savedChannelContext;
  try {
    const snapshot = await getDoc(doc(db, "users", currentUser.uid));
    if (snapshot.exists()) {
      const profile = snapshot.data();
      restoreSavedConnections(profile);
      if (!hasLocalValue) {
        savedChannelContext = normalizeSavedChannelContext(profile);
        setInsightsCreatorContext(savedChannelContext);
        sessionStorage.setItem(key, JSON.stringify(savedChannelContext));
      }
    }
  } catch (error) {
    console.warn("Could not refresh saved channel context for AI Insights.", error);
  }
  return savedChannelContext;
}

function readCachedInsights(videos, focusVideoId = "") {
  const key = insightsStorageKey(focusVideoId);
  if (!key) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!saved?.summary || saved.fingerprint !== insightsFingerprint(videos, focusVideoId)) return null;
    if (Date.now() - saved.savedAt > insightsCacheMaxAge) {
      sessionStorage.removeItem(key);
      return null;
    }
    return saved.summary;
  } catch (error) {
    sessionStorage.removeItem(key);
    return null;
  }
}

function saveCachedInsights(summary, videos, focusVideoId = "") {
  const key = insightsStorageKey(focusVideoId);
  if (!key || !summary) return;
  const savedAt = Date.now();
  sessionStorage.setItem(key, JSON.stringify({
    fingerprint: insightsFingerprint(videos, focusVideoId),
    summary,
    savedAt
  }));

  const trends = [
    ...(summary.geminiInsights?.validatedTrends || []),
    ...(summary.currentTrends || []),
    ...currentTrendSignals(summary.trendVideos || [])
  ].filter((trend, index, values) => {
    const normalized = String(trend || "").trim().toLowerCase();
    return normalized && values.findIndex(
      (candidate) => String(candidate || "").trim().toLowerCase() === normalized
    ) === index;
  }).slice(0, 4);

  localStorage.setItem(
    `${recentTrendsStorageKeyPrefix}${currentUser.uid}:${activeChannelId() || "none"}`,
    JSON.stringify({
      trends,
      category: summary.channelLane?.specificCategory ||
        summary.channelLane?.primaryCategory ||
        "Channel trend",
      savedAt
    })
  );
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
      + (thumbnail ? '<img src="' + escapeHtml(thumbnail) + '" alt="' + escapeHtml(title) + ' thumbnail">' : "")
      + (duration ? '<span class="video-library-duration">' + escapeHtml(duration) + '</span>' : "")
      + '</div>'
      + '<div class="video-library-body"><b>' + escapeHtml(title) + '</b><span>' + escapeHtml(meta || "Upload") + '</span></div>'
      + '</button>';
  }).join("");

  updateLibrarySelection(selectedVideoId);
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

function clearCachedAccessToken() {
  localStorage.removeItem(tokenStorageKey);
  sessionStorage.removeItem(tokenStorageKey);
}

async function requestAccessToken() {
  if (!currentUser) throw new Error("Sign in before generating insights.");
  return getRenewedYouTubeAccessToken(currentUser.uid, activeChannelId());
}

function setMetric(index, value, trend = "", trendClass = "") {
  const card = document.querySelectorAll(".metric-card")[index];
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  if (valueEl) valueEl.textContent = value === "" || value === null || value === undefined ? " " : value;
  if (trendEl) {
    trendEl.textContent = trend || " ";
    trendEl.className = ["trend", trendClass].filter(Boolean).join(" ");
  }
}

function setTrendMetric(values = [], detail = "", trendClass = "good") {
  const card = document.querySelector(".insights-trends-card");
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  const trends = values.filter(Boolean).slice(0, 3);

  if (valueEl) {
    valueEl.textContent = "";
    const list = document.createElement("ol");
    list.className = "youtube-trend-list";
    trends.forEach((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      list.append(item);
    });
    valueEl.append(list);
  }
  if (trendEl) {
    trendEl.textContent = detail || "Niche trends";
    trendEl.className = ["trend", trendClass].filter(Boolean).join(" ");
  }
}

function updateActivityItems(selector, items, relatedVideoGroups = []) {
  document.querySelectorAll(selector).forEach((item, index) => {
    const hasInsight = Boolean(items[index]);
    item.hidden = !hasInsight;
    const insight = items[index] || {title: " ", body: " ", label: " "};
    const timeEl = item.querySelector("time");
    const bodyEl = item.querySelector("span");
    const contentEl = item.querySelector("div");
    const existingToggle = item.querySelector(".read-more-button");
    const existingExamples = item.querySelector(".trend-video-examples");
    if (existingToggle) existingToggle.remove();
    if (existingExamples) existingExamples.remove();

    item.querySelector("b").textContent = insight.title;
    bodyEl.textContent = insight.body;
    timeEl.textContent = insight.label;
    timeEl.className = ["comparison-badge", insight.tone].filter(Boolean).join(" ");

    item.classList.remove("is-expanded");
    item.classList.add("is-collapsible");
    if (contentEl) {
      const relatedVideos = relatedVideoGroups[index] || [];
      if (relatedVideos.length) {
        const examples = document.createElement("div");
        examples.className = "trend-video-examples";
        const heading = document.createElement("small");
        heading.textContent = "Videos from other creators";
        examples.append(heading);

        relatedVideos.slice(0, 3).forEach((video) => {
          const link = document.createElement("a");
          link.className = "trend-video-example";
          link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";

          const thumbnail = bestThumbnail(video.snippet?.thumbnails);
          if (thumbnail) {
            const image = document.createElement("img");
            image.src = thumbnail;
            image.alt = "";
            image.loading = "lazy";
            link.append(image);
          }

          const title = document.createElement("span");
          title.textContent = video.snippet?.title || "Watch on YouTube";
          link.append(title);
          examples.append(link);
        });
        contentEl.append(examples);
      }

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "read-more-button";
      toggle.textContent = "Read more";
      toggle.setAttribute("aria-expanded", "false");
      contentEl.append(toggle);
    }

    requestAnimationFrame(() => updateReadMoreVisibility(item));
  });
}

function updateReadMoreVisibility(item) {
  const bodyEl = item.querySelector("span");
  const toggle = item.querySelector(".read-more-button");
  if (!bodyEl || !toggle || item.classList.contains("is-expanded")) return;

  const isOverflowing = bodyEl.scrollHeight > bodyEl.clientHeight + 1;
  item.classList.toggle("is-collapsible", isOverflowing);
  toggle.hidden = !isOverflowing;
}

function updateRecommendations(items) {
  updateActivityItems(".search-terms-panel .activity-item", items);
}

function relatedVideosForSuggestions(items = [], trendVideos = []) {
  return items.map((item, index) => {
    if (!/trend/i.test(item?.label || "")) return [];
    const suggestionText = `${item.title || ""} ${item.body || ""}`.toLowerCase();
    const referencedVideo = trendVideos.find((video) => {
      const title = String(video.snippet?.title || "").trim().toLowerCase();
      return title && suggestionText.includes(title);
    }) || trendVideos[index];
    if (!referencedVideo) return [];

    const sameQuery = trendVideos.filter((video) => (
      video.trendQuery
      && video.trendQuery === referencedVideo.trendQuery
      && video.id !== referencedVideo.id
    ));
    return [referencedVideo, ...sameQuery]
      .filter((video, videoIndex, values) => values.findIndex((candidate) => candidate.id === video.id) === videoIndex)
      .slice(0, 3);
  });
}

function updateNextVideoSuggestions(items, trendVideos = []) {
  updateActivityItems(
    "#nextVideoSuggestions .activity-item",
    items,
    relatedVideosForSuggestions(items, trendVideos)
  );
}

function updateOutsideTopicTrends(videos = [], summary = {}) {
  const contextLabel = creatorContextLabel(summary);
  const items = videos.slice(0, 3).map((video) => {
    const evidence = trendEvidence(video);
    const category = youtubeCategoryName(video.snippet?.categoryId) || "Popular video";
    const format = isShort(video) ? "Short" : "video";
    return {
      title: evidence?.title || "Popular YouTube video",
      body: `${category} · ${evidence?.publishedLabel || "Recently published"} · ${compactNumber(evidence?.views || 0)} views · about ${compactNumber(evidence?.viewsPerDay || 0)} views per day. For ${contextLabel}, study this ${format}'s opening promise, pacing, thumbnail hierarchy, and payoff, then adapt those mechanics to the channel's existing voice and viewer expectations.`,
      label: "Outside your topic",
      tone: "warn"
    };
  });

  expansionTrendFallbacks(summary).forEach((fallback) => {
    if (items.length < 3) items.push(fallback);
  });
  updateActivityItems("#outsideTopicTrends .activity-item", items);
}

function updateCrossoverTrends(items = [], outsideTrendVideos = []) {
  const relatedVideos = items.map((item, index) => {
    const text = `${item?.title || ""} ${item?.body || ""}`.toLowerCase();
    const referencedVideo = outsideTrendVideos.find((video) => {
      const title = String(video.snippet?.title || "").trim().toLowerCase();
      return title && text.includes(title);
    }) || outsideTrendVideos[index];
    return referencedVideo ? [referencedVideo] : [];
  });
  updateActivityItems("#targetedCrossoverTrends .activity-item", items, relatedVideos);
}

function videoEngagementRate(video) {
  const views = numberValue(video.statistics?.viewCount) || 0;
  if (!views) return 0;
  const likes = numberValue(video.statistics?.likeCount) || 0;
  const comments = numberValue(video.statistics?.commentCount) || 0;
  return ((likes + comments) / views) * 100;
}

function videosShareTrend(first, second) {
  if (first.trendQuery && first.trendQuery === second.trendQuery) return true;
  const firstWords = new Set(importantWords(first.snippet?.title || ""));
  const secondWords = new Set(importantWords(second.snippet?.title || ""));
  const shared = [...firstWords].filter((word) => secondWords.has(word)).length;
  return shared >= 2;
}

const platformTrendNoiseWords = new Set([
  "episode", "season", "today", "watch", "every", "thing", "really",
  "could", "would", "should", "people", "world", "time", "years",
  "million", "hours", "minutes", "day", "week"
]);

function platformTrendTerms(video) {
  return [...new Set(importantWords(video.snippet?.title || "")
    .filter((word) => !platformTrendNoiseWords.has(word) && !/^\d+$/.test(word)))];
}

function titleCaseTrend(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function platformTrendLabel(terms, videos) {
  const categoryCounts = new Map();
  videos.forEach((video) => {
    const category = youtubeCategoryName(video.snippet?.categoryId);
    if (category) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  });
  const category = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const topic = titleCaseTrend(terms.join(" "));
  const categoryAddsContext = category &&
    !terms.some((term) => category.toLowerCase().includes(term));
  return categoryAddsContext && terms.length === 1
    ? `${topic} ${category} Shorts`
    : `${topic} Shorts`;
}

function buildPlatformTrendGroups(videos = []) {
  const recent = videos
    .filter((video, index, values) => (
      video?.id &&
      isShortTrendVideo(video) &&
      isEnglishTrendVideo(video) &&
      trendAgeDays(video) <= 30 &&
      values.findIndex((candidate) => candidate.id === video.id) === index
    ))
    .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  const candidates = new Map();

  recent.forEach((video) => {
    const terms = platformTrendTerms(video);
    const keys = [];
    for (let first = 0; first < terms.length; first += 1) {
      keys.push(terms[first]);
      for (let second = first + 1; second < terms.length; second += 1) {
        keys.push([terms[first], terms[second]].sort().join(" "));
      }
    }
    [...new Set(keys)].forEach((key) => {
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(video);
    });
  });

  const groups = [...candidates.entries()]
    .map(([key, matches]) => {
      const channelCount = new Set(matches.map((video) =>
        video.snippet?.channelId || video.snippet?.channelTitle
      ).filter(Boolean)).size;
      if (matches.length < 3 || channelCount < 3) return null;
      const groupVideos = [...matches]
        .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a))
        .slice(0, 5);
      const averageViewsPerDay = Math.round(average(groupVideos.map((video) =>
        (numberValue(video.statistics?.viewCount) || 0) /
        Math.max(1, trendAgeDays(video))
      )) || 0);
      const engagementRate = average(groupVideos.map(videoEngagementRate)) || 0;
      const terms = key.split(" ");
      return {
        key,
        title: platformTrendLabel(terms, groupVideos),
        videos: groupVideos,
        videoCount: matches.length,
        channelCount,
        averageViewsPerDay,
        engagementRate,
        searchMomentum: matches.length >= 4
          ? "Widespread creator adoption"
          : "Growing creator adoption",
        score: averageViewsPerDay * (1 + engagementRate / 10) *
          (1 + Math.min(matches.length, 8) * 0.18) *
          (terms.length === 2 ? 1.3 : 1)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  groups.forEach((group) => {
    if (selected.length >= 3) return;
    const groupIds = new Set(group.videos.map((video) => video.id));
    const overlaps = selected.some((existing) => {
      const sharedVideos = existing.videos.filter((video) => groupIds.has(video.id)).length;
      return sharedVideos / Math.min(existing.videos.length, group.videos.length) >= 0.6;
    });
    if (!overlaps) selected.push(group);
  });
  return selected;
}

function buildTrendGroups(videos = []) {
  const recent = videos
    .filter((video) => (
      video?.id &&
      isShortTrendVideo(video) &&
      isEnglishTrendVideo(video) &&
      trendAgeDays(video) <= 30
    ))
    .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  const usedIds = new Set();
  const groups = [];

  recent.forEach((seed) => {
    if (groups.length >= 3 || usedIds.has(seed.id)) return;
    const matches = recent
      .filter((video) => !usedIds.has(video.id) && videosShareTrend(seed, video))
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a))
      .slice(0, 3);
    const groupVideos = matches.length ? matches : [seed];
    groupVideos.forEach((video) => usedIds.add(video.id));
    const averageViewsPerDay = Math.round(average(
      groupVideos.map((video) => (
        (numberValue(video.statistics?.viewCount) || 0) /
        Math.max(1, trendAgeDays(video))
      ))
    ) || 0);
    const engagementRate = average(
      groupVideos.map(videoEngagementRate)
    ) || 0;
    const searchMomentum = groupVideos.length >= 3
      ? "High search momentum"
      : groupVideos.length === 2
        ? "Rising search momentum"
        : "Early search signal";
    const queryTitle = readableTrendQuery(seed.trendQuery || "");
    groups.push({
      title: queryTitle || shortText(seed.snippet?.title || "YouTube trend", 80),
      videos: groupVideos,
      averageViewsPerDay,
      engagementRate,
      searchMomentum,
      score: averageViewsPerDay * (1 + engagementRate / 10) *
        (1 + (groupVideos.length - 1) * 0.2)
    });
  });

  return groups.sort((a, b) => b.score - a.score).slice(0, 3);
}

function trendGroupItems(groups, label) {
  return groups.map((group) => ({
    title: group.title,
    body: `${group.videoCount ? `${group.videoCount} recent Shorts across ${group.channelCount} channels · ` : ""}${compactNumber(group.averageViewsPerDay)} average views per day · ${group.engagementRate.toFixed(1)}% engagement · ${group.searchMomentum}. Metrics use Shorts published during the past 30 days.`,
    label,
    tone: "good"
  }));
}

function opportunityGroups(platformGroups = [], nicheGroups = []) {
  const contextWords = new Set(meaningfulCreatorContextWords());
  const nicheWords = new Set(nicheGroups.flatMap((group) =>
    importantWords(group.title || "")
  ));
  const outsideGroups = platformGroups.filter((group) => {
    const words = importantWords(group.title || "");
    const contextOverlap = words.filter((word) => contextWords.has(word)).length;
    const nicheOverlap = words.filter((word) => nicheWords.has(word)).length;
    return contextOverlap === 0 && nicheOverlap < Math.max(1, words.length / 2);
  });
  return [...outsideGroups, ...platformGroups]
    .filter((group, index, groups) =>
      groups.findIndex((candidate) => candidate.title === group.title) === index
    )
    .slice(0, 3);
}

function opportunityItems(groups, summary) {
  const contextLabel = creatorContextLabel(summary);
  const preferredFormat = "Short";
  const strategies = [
    {
      angle: `Turn the outside trend into a challenge governed by ${contextLabel} rules`,
      concept: `I Tried ${groupTitlePlaceholder(0)} Using Only ${contextLabel} Rules`,
      execution: "Show the payoff in the first two seconds, state one constraint immediately, and let the familiar channel expertise drive a 20–45 second experiment."
    },
    {
      angle: `Translate the outside trend for a ${contextLabel} audience`,
      concept: `What ${contextLabel} Creators Can Learn From ${groupTitlePlaceholder(1)}`,
      execution: "Show one recognizable example, name one transferable technique, and demonstrate it in the channel’s normal style before the halfway point."
    },
    {
      angle: `Let viewers decide how the outside trend enters ${contextLabel}`,
      concept: `${groupTitlePlaceholder(2)}, Rebuilt for ${contextLabel} Viewers`,
      execution: "Offer two crossover directions in on-screen text, ask viewers to choose in comments, and turn the winning option into the next Short."
    }
  ];
  return groups.map((group, index) => {
    const strategy = strategies[index] || strategies[0];
    const trendName = group.title.replace(/\s+(videos|shorts)$/i, "");
    const concept = strategy.concept.replace(
      groupTitlePlaceholder(index),
      trendName
    );
    return {
      title: strategy.angle,
      body: `Suggested Short: “${concept}.” How to bridge it: ${strategy.execution} Keep roughly 70% of the Short grounded in ${contextLabel} and use the remaining 30% to test ${trendName}. If viewed-versus-swiped-away and retention beat the channel median, develop it into a series. Evidence: ${compactNumber(group.averageViewsPerDay)} views per day across ${group.channelCount || group.videos.length} channels.`,
      label: "Crossover playbook",
      tone: "warn"
    };
  });
}

function groupTitlePlaceholder(index) {
  return `__OUTSIDE_TREND_${index}__`;
}

function trendSectionFallbackItems(type, summary) {
  const contextLabel = creatorContextLabel(summary);
  if (type === "platform") {
    return [
      {
        title: "Fast-payoff challenge Shorts",
        body: "Look for repeatable challenges that reveal the result in the opening two seconds, establish one rule, and reach a visible payoff within 60 seconds.",
        label: "Shorts signal",
        tone: "warn"
      },
      {
        title: "Transformation and before-after Shorts",
        body: "Track fast visual transformations, progress reveals, and process edits repeated across multiple Shorts creators with strong completion and engagement signals.",
        label: "Shorts signal",
        tone: "warn"
      },
      {
        title: "Comment-driven reaction Shorts",
        body: "Watch concise reactions, rankings, and viewer-response formats that create a clear opinion and invite a specific comment or follow-up request.",
        label: "Shorts signal",
        tone: "warn"
      }
    ];
  }
  if (type === "niche") {
    return [
      {
        title: `${contextLabel}: instant update Shorts`,
        body: `Monitor 15–45 second Shorts that turn a fresh ${contextLabel} release, update, or announcement into one immediate takeaway.`,
        label: "Niche Shorts",
        tone: "warn"
      },
      {
        title: `${contextLabel}: rapid comparisons`,
        body: `Look for repeated A-versus-B, ranking, and “best option” Shorts that make the choice understandable without long-form setup.`,
        label: "Niche Shorts",
        tone: "warn"
      },
      {
        title: `${contextLabel}: loopable challenges and reactions`,
        body: `Track challenge, reaction, and transformation Shorts with an opening that naturally connects back to the ending and encourages a rewatch.`,
        label: "Niche Shorts",
        tone: "warn"
      }
    ];
  }
  return [
    {
      title: `Bring challenge storytelling into ${contextLabel}`,
      body: `Suggested Short: “I Tried My Hardest ${contextLabel} Goal With One Major Constraint.” Show the result in the first two seconds, state the rule immediately, and reach a measurable payoff in 20–45 seconds.`,
      label: "Shorts crossover",
      tone: "warn"
    },
    {
      title: `Use documentary-style transformation in ${contextLabel}`,
      body: `Suggested Short: “I Changed My ${contextLabel} Process—Here’s the Before and After.” Start with a split-screen comparison, show one setback, and finish on the same framing so the Short loops cleanly.`,
      label: "Shorts crossover",
      tone: "warn"
    },
    {
      title: `Add audience participation to ${contextLabel}`,
      body: `Suggested Short: “You Control My Next ${contextLabel} Project.” Put two choices on screen, ask for a one-word comment, and make the winning option the hook for the next Short.`,
      label: "Shorts crossover",
      tone: "warn"
    }
  ];
}

function renderTrendSections(summary) {
  const adjacentGroups = buildPlatformTrendGroups(summary.outsideTrendVideos || []);
  const nicheGroups = buildTrendGroups(summary.trendVideos || []);
  const crossoverGroups = opportunityGroups(adjacentGroups, nicheGroups);
  const nicheItems = nicheGroups.length
    ? trendGroupItems(nicheGroups, "Niche Shorts")
    : trendSectionFallbackItems("niche", summary);
  const opportunities = crossoverGroups.length
    ? opportunityItems(crossoverGroups, summary)
    : trendSectionFallbackItems("opportunities", summary);
  const nicheTitle = document.getElementById("nicheTrendsTitle");
  if (nicheTitle) nicheTitle.textContent = `Trends for ${creatorContextLabel(summary)}`;
  updateActivityItems(
    "#nicheTrends .activity-item",
    nicheItems,
    nicheGroups.map((group) => group.videos)
  );
  updateActivityItems(
    "#trendOpportunities .activity-item",
    opportunities,
    crossoverGroups.map((group) => group.videos)
  );
}

function orderExpansionVideosByCrossover(videos = [], items = []) {
  const ordered = [];
  items.forEach((item) => {
    const text = `${item?.title || ""} ${item?.body || ""}`.toLowerCase();
    const match = videos.find((video) => {
      const title = String(video.snippet?.title || "").trim().toLowerCase();
      return title && text.includes(title);
    });
    if (match && !ordered.some((video) => video.id === match.id)) {
      ordered.push(match);
    }
  });
  videos.forEach((video) => {
    if (!ordered.some((candidate) => candidate.id === video.id)) {
      ordered.push(video);
    }
  });
  return ordered.slice(0, 3);
}

function setChatSeedMessage(message = "Hi! I'm your ViewCast assistant. To give you the best advice, should we focus on growing your views, increasing your subscribers, or improving your retention today?") {
  if (!chatMessages) return;
  chatMessages.innerHTML = "";
  chatHistory = [];
  appendChatMessage("assistant", message);
}

function showMissingGeminiKeyMessage() {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  if (insightErrorPanel) insightErrorPanel.hidden = false;
  setRefreshButtonPlacement(true, insightErrorPanel?.querySelector(".insight-error-content"));
  setStatus("An error has occurred. AI Insights could not be generated right now.");
  setLibraryStatus("AI Insights could not be generated right now.");
}

function showInsightGenerationError(message = "AI Insights could not be generated right now. Check your connection and try again.") {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  if (insightErrorPanel) {
    insightErrorPanel.hidden = false;
    const detail = insightErrorPanel.querySelector("p");
    if (detail) detail.textContent = message;
  }
  setRefreshButtonPlacement(true, insightErrorPanel?.querySelector(".insight-error-content"));
  setStatus(message);
  setLibraryStatus(message);
}

function hideInsightError() {
  if (insightErrorPanel) insightErrorPanel.hidden = true;
}

function appendChatMessage(role, message, addToHistory = true) {
  if (!chatMessages) return;
  const bubble = document.createElement("div");
  bubble.className = ["chat-message", role].join(" ");
  bubble.textContent = message;
  chatMessages.append(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (addToHistory) {
    const geminiRole = role === "user" ? "user" : "model";
    chatHistory.push({ role: geminiRole, parts: [{ text: message }] });
  }

  return bubble;
}

function compactAdviceSummary(summary) {
  const trendTitle = summary.trendVideos[0]?.snippet?.title || "Similar trend signals unavailable";
  return `I classified this as ${summary.channelLane?.label || "a general creator channel"}. Start with ${summary.topicIdeas[0]?.title || "a direct follow-up"}, post long-form near ${summary.videoUploadTime}, test Shorts near ${summary.shortUploadTime}, aim for ${summary.nextVideoLength} on the next video and ${summary.nextShortLength} on the next Short. Trend reference: ${trendTitle}.`;
}

function channelVideoContext(videos) {
  return videos.slice(0, 40).map((video) => ({
    title: video.snippet?.title || "Untitled video",
    description: shortText(video.snippet?.description || "", 260),
    tags: (video.snippet?.tags || []).slice(0, 12),
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.statistics?.viewCount) || 0,
    likes: numberValue(video.statistics?.likeCount) || 0,
    comments: numberValue(video.statistics?.commentCount) || 0,
    duration: durationFromIso(video.contentDetails?.duration),
    format: isShort(video) ? "Short" : "Video",
    youtubeCategoryId: video.snippet?.categoryId || "",
    youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId)
  }));
}

function channelScanContext(videos, profile = {}, {includeCatalog = true} = {}) {
  const uploads = Array.isArray(videos) ? videos : [];
  const sortedByViews = [...uploads].sort(
    (a, b) => numberValue(b.statistics?.viewCount) - numberValue(a.statistics?.viewCount)
  );
  const tagCounts = new Map();
  const categoryCounts = new Map();
  let shorts = 0;

  uploads.forEach((video) => {
    if (isShort(video)) shorts += 1;
    const category = youtubeCategoryName(video.snippet?.categoryId) || "Uncategorized";
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    (video.snippet?.tags || []).forEach((tag) => {
      const normalized = String(tag || "").trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      const existing = tagCounts.get(key) || {label: normalized, count: 0};
      existing.count += 1;
      tagCounts.set(key, existing);
    });
  });

  const compactUpload = (video) => ({
    title: video.snippet?.title || "Untitled video",
    description: shortText(video.snippet?.description || "", 220),
    tags: (video.snippet?.tags || []).slice(0, 10),
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.statistics?.viewCount) || 0,
    likes: numberValue(video.statistics?.likeCount) || 0,
    comments: numberValue(video.statistics?.commentCount) || 0,
    duration: durationFromIso(video.contentDetails?.duration),
    format: isShort(video) ? "Short" : "Video"
  });

  return {
    scanAvailable: uploads.length > 0,
    channel: compactChannelProfile(profile),
    uploadsScanned: uploads.length,
    totalChannelVideos: numberValue(profile.videoCount) || uploads.length,
    scanCoveragePercent: profile.videoCount
      ? Math.min(100, Math.round((uploads.length / numberValue(profile.videoCount)) * 100))
      : 100,
    formatMix: {shorts, longForm: Math.max(0, uploads.length - shorts)},
    categories: [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({name, count})),
    recurringTags: [...tagCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    inferredNicheTerms: inferChannelNicheTerms(uploads, profile),
    uploadCatalog: includeCatalog ? uploads.slice(0, 200).map((video) => ({
      title: video.snippet?.title || "Untitled video",
      tags: (video.snippet?.tags || []).slice(0, 4),
      category: youtubeCategoryName(video.snippet?.categoryId),
      format: isShort(video) ? "Short" : "Video",
      publishedAt: video.snippet?.publishedAt || "",
      views: numberValue(video.statistics?.viewCount) || 0
    })) : [],
    recentUploads: uploads.slice(0, 24).map(compactUpload),
    topPerformers: sortedByViews.slice(0, 10).map(compactUpload)
  };
}

function compactChannelProfile(profile = {}) {
  return {
    title: profile.title || profile.snippet?.title || "",
    description: shortText(profile.description || profile.snippet?.description || "", 180),
    subscriberCount: profile.subscriberCount || profile.statistics?.subscriberCount || "",
    videoCount: profile.videoCount || profile.statistics?.videoCount || ""
  };
}

function inferChannelNicheTerms(videos, profile = {}) {
  const scores = new Map();
  const generic = new Set([
    "gaming", "games", "gameplay", "video", "videos", "short", "shorts",
    "youtube", "viral", "trending", "funny", "official", "channel"
  ]);
  const add = (value, weight) => importantWords(value).forEach((word) => {
    if (!generic.has(word)) scores.set(word, (scores.get(word) || 0) + weight);
  });
  add(profile.keywords || "", 5);
  add(profile.description || "", 3);
  videos.slice(0, 30).forEach((video, index) => {
    const performanceWeight = index < 8 ? 3 : 1;
    add(video.snippet?.title || "", performanceWeight);
    (video.snippet?.tags || []).slice(0, 12).forEach(
      (tag) => add(tag, performanceWeight + 2)
    );
  });
  return [...scores.entries()]
    .filter(([, score]) => score >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 10);
}

function nicheQueriesFromTerms(terms, fallbackLane) {
  if (!terms.length) return trendQueriesForLane(fallbackLane);
  const pairs = [
    terms.slice(0, 2),
    [terms[0], terms[2]].filter(Boolean),
    [terms[1] || terms[0], terms[3]].filter(Boolean),
    [terms[0], terms[4]].filter(Boolean)
  ];
  return pairs.map((parts, index) => `${parts.join(" ")} ${[
    "updates", "challenge", "explained", "community"
  ][index]}`.trim());
}

function normalizeGeminiTrendPlan(value, fallbackLane) {
  if (!value || typeof value !== "object") return null;
  const creatorContextText = `${savedChannelContext.channelTopic} ${savedChannelContext.channelContext}`.trim();
  const creatorContextWords = new Set(importantWords(creatorContextText));
  const rawQueries = Array.isArray(value.queries) ? value.queries : [];
  let queries = rawQueries
    .map((query) => String(query || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (creatorContextWords.size) {
    queries = queries.filter((query) => importantWords(query).some((word) => creatorContextWords.has(word)));
    if (!queries.length) {
      const contextSeed = savedChannelContext.channelTopic
        || importantWords(savedChannelContext.channelContext).slice(0, 6).join(" ");
      queries = [
        `${contextSeed} news`,
        `${contextSeed} new releases`,
        `${contextSeed} reviews`,
        `${contextSeed} challenges`
      ];
    }
  }
  if (!queries.length) return null;

  const primaryCategory = String(value.primaryCategory || value.categoryLabel || fallbackLane.label || "General").slice(0, 60);
  const specificCategory = String(value.specificCategory || value.categorySeed || fallbackLane.seed || primaryCategory).slice(0, 80);
  const categoryLabel = specificCategory && specificCategory.toLowerCase() !== primaryCategory.toLowerCase()
    ? `${primaryCategory} - ${specificCategory}`
    : primaryCategory;
  const contentInterpretations = (Array.isArray(value.contentInterpretations) ? value.contentInterpretations : [])
    .slice(0, 12)
    .map((item) => ({
      title: String(item?.title || "").slice(0, 160),
      mediaReferences: (Array.isArray(item?.mediaReferences) ? item.mediaReferences : [])
        .map((reference) => String(reference || "").trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 4),
      premise: String(item?.premise || "").trim().slice(0, 240),
      audienceAppeal: String(item?.audienceAppeal || "").trim().slice(0, 180),
      confidence: ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "low"
    }))
    .filter((item) => item.title && item.premise);
  const allowedExpansionCategoryIds = new Set([
    "1", "10", "17", "20", "23", "24", "27", "28"
  ]);
  const expansionCategoryIds = (Array.isArray(value.expansionCategoryIds)
    ? value.expansionCategoryIds
    : [])
    .map((categoryId) => String(categoryId || ""))
    .filter((categoryId, index, values) => (
      allowedExpansionCategoryIds.has(categoryId) &&
      values.indexOf(categoryId) === index
    ))
    .slice(0, 5);
  const nicheTerms = (Array.isArray(value.nicheTerms) ? value.nicheTerms : [])
    .map((term) => String(term || "").trim().slice(0, 60))
    .filter((term, index, values) => term && values.indexOf(term) === index)
    .slice(0, 10);

  return {
    lane: {
      key: String(value.categoryKey || primaryCategory.toLowerCase().replace(/\s+/g, "-") || fallbackLane.key || "general").slice(0, 40),
      label: categoryLabel.slice(0, 80),
      seed: specificCategory || queries[0],
      primaryCategory,
      specificCategory,
      confidence: String(value.categoryConfidence || "medium").slice(0, 20)
    },
    queries,
    nicheTerms,
    contentInterpretations,
    expansionCategoryIds
  };
}

async function buildGeminiTrendPlan(videos, channelProfile = null) {
  const fallbackLane = detectChannelLane(videos);
  const inferredNicheTerms = inferChannelNicheTerms(videos, channelProfile || {});
  const fallbackQueries = nicheQueriesFromTerms(inferredNicheTerms, fallbackLane);
  if (!isGeminiAvailable()) {
    return {
      lane: fallbackLane,
      queries: fallbackQueries,
      nicheTerms: inferredNicheTerms,
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  }

  const prompt = [
    "You are classifying a YouTube channel for ViewCast.",
    "Scan the complete channel evidence supplied below before choosing trends. Use the creator-provided topic and context first, then repeated patterns across the channel profile, recent uploads, top performers, descriptions, tags, YouTube categories, formats, dates, and performance.",
    "Treat uploadsScanned and scanCoveragePercent as confidence signals. When only part of the channel is available, say so internally and rely only on repeated evidence; never invent unavailable channel details.",
    "TREND SOURCE RULE: when creator-provided context is non-empty, it is the exclusive source for queries and trend discovery. Do not use, quote, paraphrase, or derive any trend query from upload titles. Uploads may still be interpreted for later performance analysis, but they must not steer what counts as a current trend.",
    "Decide the channel's broad category and, when possible, a specific subcategory. Do not classify from one ambiguous word or one outlier upload.",
    "Use clean creator categories. Examples: Music, Gaming, Roblox, Minecraft, Fortnite, Anime, Memes, Sports, Beauty, Education, Tech, Vlogs, Cooking.",
    "If the channel is broad gaming, primaryCategory should be Gaming and specificCategory should be General gaming. If it is mostly Roblox, primaryCategory should be Gaming and specificCategory should be Roblox.",
    "If a channel has music videos, songs, covers, albums, beats, or artist content, classify it as Music. Use a specific subcategory like Rap, Covers, Beats, or Artist edits only when clear.",
    "If the channel mixes memes with another fandom, game, anime, or music niche, classify the primary content type and put the fandom/game/style in specificCategory.",
    "Semantically interpret every upload title using its description, tags, category, and the repeated context across the channel. Identify what the title actually means, the media or real-world entity it references (game, show, film, song, artist, character, person, event, product, or meme), the video's underlying premise, and why that premise appeals to viewers.",
    "Do not treat title wording as the topic by itself. Resolve slang, abbreviations, character names, quotes, episode references, memes, and fandom-specific language when the surrounding metadata supports it.",
    "Never invent a media reference. If a reference is ambiguous, use an empty mediaReferences list, explain the likely premise conservatively, and set confidence to low.",
    "Then choose exactly 4 trend-search queries from the resolved media references and premises, not by copying full upload titles. The queries must cover 4 meaningfully different subtopics within the same category—not synonyms, rephrasings, or the same event/person/title. For example, a gaming category could cover a new release, a competitive meta, a creator challenge format, and an industry event.",
    "Every query must contain a specific named game, franchise, fandom, genre, product, skill, audience problem, or recurring subject proven by the channel evidence. Never return broad queries such as gaming trends, viral gaming, popular games, YouTube trends, or general entertainment.",
    "Return 4-10 nicheTerms that uniquely identify this creator's actual lane. Prefer repeated named entities, subgenres, recurring audience problems, and signature formats. Exclude generic category words such as gaming, videos, Shorts, trends, funny, and viral.",
    "When creator-provided context exists, ignore resolved upload media references while choosing queries and use only that creator context. Each query must contain at least one meaningful term written in the creator context.",
    "Also choose exactly 5 expansionCategoryIds for popular trends outside the current topic. Choose from Film & Animation=1, Music=10, Sports=17, Gaming=20, Comedy=23, Entertainment=24, Education=27, and Science & Technology=28.",
    "The expansion categories must remain outside the creator's current topic, but they must offer a credible bridge to the audience interests, tone, skills, goals, or presentation style explicitly described in creator-provided context. Rank the strongest bridge first.",
    "Return JSON only with this shape. No trailing commas. Also include nicheTerms as a top-level array of 4-10 strings:",
    `{"categoryKey":"","primaryCategory":"","specificCategory":"","categoryLabel":"","categorySeed":"","categoryConfidence":"high","contentInterpretations":[{"title":"","mediaReferences":[""],"premise":"","audienceAppeal":"","confidence":"high"}],"queries":["","","",""],"expansionCategoryIds":["","","","",""]}`,
    "",
    "Channel profile:",
    JSON.stringify(channelProfile || {}),
    "",
    "Channel-wide scan (available YouTube metadata, up to 200 uploads):",
    JSON.stringify(channelScanContext(videos, channelProfile || {})),
    "",
    "Creator-provided channel topic and context (use this as the primary niche guidance):",
    JSON.stringify(savedChannelContext),
    ""
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
        maxOutputTokens: 800
      }
    });
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    const plan = normalizeGeminiTrendPlan(safeJsonParse(text), fallbackLane);
    if (plan) {
      if (!plan.nicheTerms.length) plan.nicheTerms = inferredNicheTerms;
      return plan;
    }
    return {
      lane: fallbackLane,
      queries: fallbackQueries,
      nicheTerms: inferredNicheTerms,
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  } catch (error) {
    console.warn("Gemini trend plan failed.", error);
    return {
      lane: fallbackLane,
      queries: fallbackQueries,
      nicheTerms: inferredNicheTerms,
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  }
}

function geminiContext(summary) {
  const trendReferences = summary.trendVideos
    .slice(0, 5)
    .map((video) => ({
      ...trendEvidence(video),
      likes: numberValue(video.statistics?.likeCount) || 0,
      comments: numberValue(video.statistics?.commentCount) || 0,
      format: isShort(video) ? "Short" : "Video",
      category: youtubeCategoryName(video.snippet?.categoryId),
    }))
    .filter((video) => video.title);
  const outsideTrendReferences = (summary.outsideTrendVideos || [])
    .slice(0, 4)
    .map((video) => ({
      ...trendEvidence(video),
      category: youtubeCategoryName(video.snippet?.categoryId) || "Popular video",
      format: isShort(video) ? "Short" : "Video"
    }))
    .filter((video) => video.title);
  const visibleIdeas = summary.geminiInsights?.recommendations || summary.topicIdeas;
  const ideas = visibleIdeas.slice(0, 3).map((idea) => `${idea.title}: ${shortText(idea.body, 120)}`);
  return {
    creatorProvidedContext: summary.creatorProvidedContext || savedChannelContext,
    channelProfile: compactChannelProfile(summary.channelProfile || {}),
    channelCategory: summary.channelLane?.label || "General creator channel",
    primaryCategory: summary.channelLane?.primaryCategory || summary.channelLane?.label || "General",
    specificCategory: summary.channelLane?.specificCategory || summary.channelLane?.seed || "",
    categoryConfidence: summary.channelLane?.confidence || "medium",
    currentYouTubeTrend: summary.geminiInsights?.cards?.topTopicSignal?.value || summary.currentTrend || summary.topSignal,
    bestUploadTime: summary.geminiInsights?.cards?.bestUploadTime?.value || summary.bestUploadTime,
    videoUploadTime: summary.videoUploadTime,
    shortUploadTime: summary.shortUploadTime,
    nextVideoLength: summary.geminiInsights?.cards?.nextVideoLength?.value || summary.nextVideoLength,
    nextShortLength: summary.geminiInsights?.cards?.nextShortLength?.value || summary.nextShortLength,
    suggestedIdeas: ideas,
    trendReferences,
    outsideTrendReferences,
    trendQueries: summary.trendVideos.trendQueries || [],
    contentInterpretations: (summary.contentInterpretations || []).slice(0, 5)
  };
}

function geminiPageContext(summary, videos) {
  return {
    ...geminiContext(summary),
    averageViews: Math.round(summary.avgViews || 0),
    bestUploadViews: summary.bestViews || 0,
    uploadPerformance: uploadPerformanceContext(videos),
    channelWideScan: channelScanContext(
      videos,
      summary.channelProfile || {},
      {includeCatalog: false}
    )
  };
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

function normalizeRecommendation(item = {}, fallback = {}) {
  return {
    title: String(item.title || fallback.title || "Make a direct follow-up").slice(0, 160),
    body: String(item.body || fallback.body || "Use your strongest topic and connect it to a timely viewer problem.").slice(0, 900),
    label: String(item.label || fallback.label || "Gemini").slice(0, 36),
    tone: ["good", "warn", "bad"].includes(item.tone) ? item.tone : (fallback.tone || "good")
  };
}

function isGenericSuggestionTitle(value = "") {
  return /\b(follow[\s-]?up|part\s*2|extend|post more|make another|do another|continue)\b/i.test(String(value || ""));
}

function normalizeConceptSuggestion(item = {}, fallback = {}) {
  const normalized = normalizeRecommendation(item, fallback);
  if (isGenericSuggestionTitle(normalized.title)) {
    return normalizeRecommendation(fallback, {
      title: "Turn a current trend into a new concept",
      body: normalized.body,
      label: normalized.label,
      tone: normalized.tone
    });
  }
  return normalized;
}

function filledInsightItems(items, fallbacks, normalizer) {
  const normalizedItems = Array.isArray(items)
    ? items.slice(0, 3).map((item, index) => normalizer(item, fallbacks[index]))
    : [];
  const seen = new Set(normalizedItems.map((item) => item.title.toLowerCase()));

  fallbacks.slice(0, 3).forEach((fallback) => {
    if (normalizedItems.length >= 3) return;
    const normalizedFallback = normalizer(fallback, fallback);
    const key = normalizedFallback.title.toLowerCase();
    if (seen.has(key)) return;
    normalizedItems.push(normalizedFallback);
    seen.add(key);
  });

  while (normalizedItems.length < 3) {
    normalizedItems.push(normalizer({}, {
      title: "Turn the strongest pattern into a clearer next step",
      body: "Use your highest-performing recent upload as the packaging reference, then make the next idea more specific, timely, and easy to understand in the first few seconds.",
      label: "Action",
      tone: "good"
    }));
  }

  return normalizedItems.slice(0, 3);
}

function normalizeCrossoverTrends(items, summary) {
  const outsideTitles = (summary.outsideTrendVideos || [])
    .map((video) => String(video.snippet?.title || "").trim())
    .filter(Boolean);
  const fallbacks = buildCrossoverTrendSuggestions(summary);
  const normalized = (Array.isArray(items) ? items : [])
    .filter((item) => {
      const text = `${item?.title || ""} ${item?.body || ""}`.toLowerCase();
      return outsideTitles.some((title) => text.includes(title.toLowerCase()));
    })
    .map((item, index) => normalizeConceptSuggestion(item, fallbacks[index]))
    .slice(0, 3);
  const seen = new Set(normalized.map((item) => item.title.toLowerCase()));

  fallbacks.forEach((fallback) => {
    if (normalized.length >= 3 || seen.has(fallback.title.toLowerCase())) return;
    normalized.push(fallback);
    seen.add(fallback.title.toLowerCase());
  });

  return normalized;
}

function normalizeGeminiInsights(value, summary) {
  if (!value || typeof value !== "object") return null;
  const cards = value.cards || {};
  const fallbackIdeas = summary.topicIdeas || [];
  const fallbackSuggestions = summary.nextVideoSuggestions || fallbackIdeas;
  // Accept Gemini's readable label only when its words occur in the actual
  // niche search queries/results. Otherwise show the clean niche query.
  const generatedTrendValue = String(cards.topTopicSignal?.value || "").trim();
  const trendValue = isGroundedTrendLabel(generatedTrendValue, summary.trendVideos)
    ? generatedTrendValue
    : summary.currentTrend;
  const trendDetail = `${summary.channelLane?.specificCategory
    || summary.channelLane?.primaryCategory
    || summary.channelLane?.label
    || "Niche"} on YouTube`;
  const recommendations = filledInsightItems(value.recommendations, fallbackIdeas, normalizeRecommendation);
  const nextVideoSuggestions = filledInsightItems(value.nextVideoSuggestions, fallbackSuggestions, normalizeConceptSuggestion);
  const crossoverTrends = normalizeCrossoverTrends(value.crossoverTrends, summary);
  const allowedTrendTitles = new Map(summary.trendVideos.map((video) => [
    normalizedTitleWords(video.snippet?.title || "").join(" "),
    String(video.snippet?.title || "").trim()
  ]));
  const validatedTrends = (Array.isArray(value.validatedTrends) ? value.validatedTrends : [])
    .map((title) => {
      const normalized = normalizedTitleWords(title).join(" ");
      if (allowedTrendTitles.has(normalized)) return allowedTrendTitles.get(normalized);

      const titleWords = new Set(normalizedTitleWords(title));
      if (!titleWords.size) return "";
      const closest = [...allowedTrendTitles.entries()].find(([candidate]) => {
        const candidateWords = new Set(candidate.split(" ").filter(Boolean));
        const shared = [...titleWords].filter((word) => candidateWords.has(word)).length;
        return shared / Math.max(titleWords.size, candidateWords.size) >= 0.8;
      });
      return closest?.[1] || "";
    })
    .filter(Boolean)
    .filter((title, index, values) => values.indexOf(title) === index)
    .slice(0, 3);

  return {
    cards: {
      bestUploadTime: {
        value: String(cards.bestUploadTime?.value || summary.bestUploadTime || "").slice(0, 24),
        detail: String(cards.bestUploadTime?.detail || "Gemini").slice(0, 32),
        tone: cards.bestUploadTime?.tone || "good"
      },
      nextVideoLength: {
        value: String(cards.nextVideoLength?.value || summary.nextVideoLength || "").slice(0, 24),
        detail: String(cards.nextVideoLength?.detail || summary.videoUploadTime || "Gemini").slice(0, 32),
        tone: cards.nextVideoLength?.tone || "good"
      },
      nextShortLength: {
        value: String(cards.nextShortLength?.value || summary.nextShortLength || "").slice(0, 24),
        detail: String(cards.nextShortLength?.detail || summary.shortUploadTime || "Gemini").slice(0, 32),
        tone: cards.nextShortLength?.tone || "warn"
      },
      topTopicSignal: {
        value: String(trendValue || summary.currentTrend || summary.topSignal || "").slice(0, 40),
        detail: String(trendDetail || "Current YouTube trend").slice(0, 32),
        tone: cards.topTopicSignal?.tone || "good"
      }
    },
    validatedTrends,
    crossoverTrends,
    nextVideoSuggestions,
    recommendations,
    chatIntro: String(value.chatIntro || compactAdviceSummary(summary)).slice(0, 360)
  };
}

async function buildGeminiPageInsights(summary, videos) {
  if (!isGeminiAvailable()) return null;

  const prompt = [
    "You are ViewCast's YouTube strategist. Return compact JSON only. No trailing commas.",
    "Use only supplied channel stats, trend references, and upload patterns. Do not invent analytics.",
    "Before writing any card or recommendation, scan channelWideScan across the available uploadCatalog, recurringTags, categories, formatMix, recentUploads, and topPerformers. Base advice on repeated channel-wide evidence rather than one upload.",
    "Use uploadsScanned and scanCoveragePercent as confidence signals. If the scan is partial or metadata is missing, make narrower claims and never imply Gemini watched video or accessed data that is not supplied.",
    "Treat creatorProvidedContext as the primary source for the channel niche, audience, goals, and requested content direction.",
    "Classify the channel niche from repeated upload patterns, then make every card and suggestion match that niche.",
    "Use contentInterpretations to understand what the creator's titles mean and which media they reference. Treat the raw title only as a lookup key and performance label, never as a ready-made topic.",
    "Base concepts on the resolved mediaReferences, premise, audienceAppeal, and external trend evidence. Do not paste a creator title into a suggestion, tell the creator to expand it, or merely propose a follow-up/part 2.",
    "When an interpretation has low confidence or no resolved media reference, do not build a recommendation around that interpretation.",
    "Use 12-hour time like 'Tue 6 PM'. Avoid generic advice such as make a follow-up, post more, extend the video, or improve the hook.",
    "Return exactly 3 nextVideoSuggestions and exactly 3 recommendations. Every item needs a non-empty title, body, label, and tone.",
    "Exactly 2 of the 3 nextVideoSuggestions must be specific new concepts grounded in two different external trendReferences. The third must be grounded in the creator's own channel performance.",
    "For each trend-grounded suggestion, name the external reference, state its published date and viewsPerDay, explain why it fits this channel, and use the label 'Current trend'. Never present a search query itself as proof of a trend.",
    "For the channel-grounded suggestion, cite a supplied performance number and use the label 'Channel data'.",
    "A trend reference is supporting evidence, not a concept to copy. Transform its viewer demand into an original angle for this channel.",
    "recommendations must be 3 important strategic tips the creator can act on now, such as packaging, upload timing, format length, niche/trend fit, Shorts strategy, or weak-angle avoidance.",
    "topTopicSignal.value must be a short, recognizable trend name (2-6 words), not a sentence or a fragment copied from a video title.",
    "Every word in topTopicSignal.value must be supported by the supplied external YouTube trend references or trend queries. Do not invent a trend.",
    "Review every trendReference for semantic relevance to creatorProvidedContext and present-day usefulness. Reject videos that only share a broad category word, discuss an old event/topic despite being newly uploaded, are archival/reuploads, or do not help this specific creator.",
    "Return validatedTrends as up to 3 exact, character-for-character title strings copied from distinct accepted trendReferences. Use fewer than 3 when fewer are genuinely current and relevant; never fill space with a weak match.",
    "Use only references included in validatedTrends for trend-grounded nextVideoSuggestions. If fewer than 2 references pass, replace the unsupported trend suggestion with channel-data advice instead of using a rejected reference.",
    "Return exactly 3 crossoverTrends using outsideTrendReferences. Each must keep the outside subject as the primary topic while connecting it to this channel's audience perspective, strongest format, presentation style, or creator expertise.",
    "Every crossover trend must name its exact outside reference, explain why the existing audience could enter it, and use the label 'Targeted crossover'. Do not turn the outside subject into another video about the existing channel topic.",
    "JSON shape:",
    `{"cards":{"bestUploadTime":{"value":"","detail":"","tone":"good"},"nextVideoLength":{"value":"","detail":"","tone":"good"},"nextShortLength":{"value":"","detail":"","tone":"warn"},"topTopicSignal":{"value":"","detail":"","tone":"good"}},"validatedTrends":["","",""],"nextVideoSuggestions":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"crossoverTrends":[{"title":"","body":"","label":"Targeted crossover","tone":"good"},{"title":"","body":"","label":"Targeted crossover","tone":"good"},{"title":"","body":"","label":"Targeted crossover","tone":"good"}],"recommendations":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"chatIntro":""}`,
    "",
    "Channel data:",
    JSON.stringify(geminiPageContext(summary, videos))
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
        maxOutputTokens: 850
      }
    });

    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    const parsedInsights = safeJsonParse(text);
    if (!parsedInsights) {
      // Gemini can occasionally hit its output limit mid-object. The page still
      // has complete deterministic channel analysis, so render that instead of
      // discarding the entire result or spending credits on an automatic retry.
      console.warn("Gemini returned incomplete JSON; using channel-data insights.");
      return normalizeGeminiInsights({}, summary);
    }
    return normalizeGeminiInsights(parsedInsights, summary);
  } catch (error) {
    console.warn("Gemini page insights failed.", error);
    if (error.message === "AI_INSIGHTS_RATE_LIMITED" || error.code === "functions/resource-exhausted") {
      throw new Error("AI_INSIGHTS_RATE_LIMITED");
    }
    throw error;
  }
}

async function buildGeminiChatReply(question, summary) {
  if (!isGeminiAvailable()) return "An error has occurred. The AI assistant is unavailable right now.";

  const fullContext = summary ? geminiContext(summary) : null;
  const chatContext = fullContext ? {
    creatorProvidedContext: fullContext.creatorProvidedContext,
    channelCategory: fullContext.channelCategory,
    currentYouTubeTrend: fullContext.currentYouTubeTrend,
    bestUploadTime: fullContext.bestUploadTime,
    nextVideoLength: fullContext.nextVideoLength,
    nextShortLength: fullContext.nextShortLength,
    suggestedIdeas: fullContext.suggestedIdeas,
    trendReferences: fullContext.trendReferences.slice(0, 3)
  } : null;
  const systemInstruction = [
    "Give concise, practical YouTube advice using only the supplied channel context.",
    "Do not invent analytics. Answer in 2-3 short sentences.",
    "",
    "Channel context:",
    chatContext ? JSON.stringify(chatContext) : "No channel data yet. Ask one focused question."
  ].join("\n");

  try {
    const text = await requestGeminiText({
      contents: chatHistory.slice(-4),
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 120
      }
    });

    return text || "I couldn't generate a response. Please try again.";
  } catch (error) {
    console.error("Gemini advice failed.", error);
    return "I'm having trouble connecting to my brain right now.";
  }
}

function setAnalyzerLoading(isLoading) {
  if (analyzerLoading) analyzerLoading.hidden = !isLoading;
  if (isLoading) setRefreshButtonPlacement(false);
}

function setAnalyzerResultsVisible(isVisible) {
  analyzerDashboard?.classList.toggle("analyzer-results-hidden", !isVisible);
  setRefreshButtonPlacement(!isVisible);
}

function activateInsightsTab(tabName, {focus = false} = {}) {
  const activeName = tabName === "trends" ? "trends" : "analysis";
  insightTabs.forEach((tab) => {
    const isActive = tab.dataset.insightsTab === activeName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    if (isActive && focus) tab.focus();
  });
  insightTabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.insightsPanel !== activeName;
  });
}

function handleInsightsTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const currentIndex = Math.max(0, insightTabs.indexOf(event.currentTarget));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? insightTabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + insightTabs.length) % insightTabs.length;
  activateInsightsTab(insightTabs[nextIndex]?.dataset.insightsTab, {focus: true});
}

function setRefreshButtonPlacement(centered, target = insightRefreshEmptyContent) {
  if (!refreshInsightsPageButton) return;
  const destination = centered ? target : insightsHeaderActions;
  if (destination && refreshInsightsPageButton.parentElement !== destination) {
    destination.append(refreshInsightsPageButton);
  }
  if (insightRefreshEmpty) {
    insightRefreshEmpty.hidden = !centered || destination !== insightRefreshEmptyContent;
  }
}

function hasLinkedChannel() {
  try {
    const connection = JSON.parse(localStorage.getItem(connectionStorageKey) || "null");
    return Boolean(connection?.channel?.id);
  } catch (error) {
    return false;
  }
}

function showChannelLinkPrompt(show) {
  if (insightChannelEmpty) insightChannelEmpty.hidden = !show;
  if (show) {
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(false);
    setRefreshButtonPlacement(false);
  }
}

function clearAnalyzerResults() {
  latestChannelSummary = null;
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  hideInsightError();
  document.querySelectorAll(".metric-card").forEach((card) => {
    const valueEl = card.querySelector(".metric-value");
    const trendEl = card.querySelector(".trend");
    if (valueEl) valueEl.textContent = " ";
    if (trendEl) {
      trendEl.textContent = " ";
      trendEl.className = "trend";
    }
  });
  document.querySelectorAll(".activity-item").forEach((item) => {
    item.classList.remove("is-collapsible", "is-expanded");
    item.querySelector(".read-more-button")?.remove();
    item.querySelector("b").textContent = " ";
    item.querySelector("span").textContent = " ";
    const timeEl = item.querySelector("time");
    timeEl.textContent = " ";
    timeEl.className = "comparison-badge";
  });
  setChatSeedMessage();
}

function renderChannelInsights(summary) {
  latestChannelSummary = summary;
  const geminiInsights = summary.geminiInsights
    ? normalizeGeminiInsights(summary.geminiInsights, summary)
    : null;
  const cards = geminiInsights?.cards || {};
  setMetric(
    0,
    cards.bestUploadTime?.value || summary.bestUploadTime,
    cards.bestUploadTime?.detail || "Best performers",
    cards.bestUploadTime?.tone || "good"
  );
  setMetric(
    1,
    cards.nextVideoLength?.value || summary.nextVideoLength,
    cards.nextVideoLength?.detail || summary.videoUploadTime,
    cards.nextVideoLength?.tone || "good"
  );
  setMetric(
    2,
    cards.nextShortLength?.value || summary.nextShortLength,
    cards.nextShortLength?.detail || summary.shortUploadTime,
    cards.nextShortLength?.tone || "warn"
  );
  updateRecommendations(geminiInsights?.recommendations || summary.topicIdeas);
  renderTrendSections(summary);
  setChatSeedMessage(geminiInsights?.chatIntro || compactAdviceSummary(summary));
}

async function loadVideosWithRetry(allowPrompt) {
  let accessToken = readCachedAccessToken();
  if (!accessToken && !allowPrompt) return readCachedVideos();
  accessToken = accessToken || await requestAccessToken();

  try {
    return await fetchChannelVideos(accessToken);
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    clearCachedAccessToken();
    if (!allowPrompt) throw error;
    setLibraryStatus("YouTube access expired. Please approve once to refresh insights.");
    const refreshedToken = await requestAccessToken();
    return fetchChannelVideos(refreshedToken);
  }
}

async function loadVideoLibrary({allowPrompt = false} = {}) {
  if (!currentUser) return [];

  const cachedVideos = readCachedVideos();
  if (cachedVideos.length) renderVideoLibrary(cachedVideos);

  if (!readCachedAccessToken() && !allowPrompt) {
    setLibraryStatus(cachedVideos.length ? "Showing saved uploads. Generate insights from saved data or refresh for current data." : "Refresh videos to load uploads from your linked channel.");
    return cachedVideos;
  }

  try {
    setLibraryBusy(true);
    setLibraryStatus("Loading uploads from YouTube...");
    const videos = await loadVideosWithRetry(allowPrompt);
    saveCachedVideos(videos);
    renderVideoLibrary(videos);
    setLibraryStatus(videos.length ? "Uploads loaded. Generate insights for your channel." : "No uploads were found on your linked channel.");
    return videos;
  } catch (error) {
    console.error("Could not load channel videos.", error);
    setLibraryStatus(error.message || "Could not load videos from YouTube.");
    // A user-triggered refresh/generation must preserve the real YouTube or
    // credential error. Returning an empty cache here caused the caller to
    // replace it with the misleading "Load your channel uploads" message.
    if (allowPrompt) throw error;
    return cachedVideos;
  } finally {
    setLibraryBusy(false);
  }
}

async function generateChannelInsights({allowPrompt = true, focusVideoId = "", forceRefresh = false} = {}) {
  if (!hasLinkedChannel()) {
    showChannelLinkPrompt(true);
    return;
  }
  showChannelLinkPrompt(false);
  if (!isGeminiAvailable()) {
    showMissingGeminiKeyMessage();
    return;
  }
  const requestId = ++analysisRequestId;

  try {
    hideInsightError();
    setBusy(true);
    setAnalyzerResultsVisible(false);
    setAnalyzerLoading(true);
    setStatus(readCachedAccessToken() ? "Analyzing your channel..." : "Requesting YouTube access...");

    let videos = channelVideos.length ? channelVideos : readCachedVideos();
    if (!videos.length) {
      videos = await loadVideoLibrary({allowPrompt});
    }
    if (requestId !== analysisRequestId) return;
    if (!videos.length) {
      throw new Error("No uploads were found on the linked YouTube channel.");
    }

    updateLibrarySelection(focusVideoId);
    const cachedSummary = forceRefresh ? null : readCachedInsights(videos, focusVideoId);
    if (cachedSummary) {
      renderChannelInsights(cachedSummary);
      setAnalyzerLoading(false);
      setAnalyzerResultsVisible(true);
      setStatus("");
      setLibraryStatus("Showing recently generated AI insights.");
      return;
    }

    let accessToken = readCachedAccessToken();
    if (!accessToken && allowPrompt) {
      setStatus("YouTube access is required to search current trends...");
      accessToken = await requestAccessToken();
      if (requestId !== analysisRequestId) return;
    }
    let channelProfile = null;
    if (accessToken) {
      setStatus("Loading channel profile...");
      try {
        channelProfile = await fetchChannelProfile(accessToken);
      } catch (error) {
        console.warn("Could not load channel profile for Gemini classification.", error);
      }
      if (requestId !== analysisRequestId) return;
    }
    setStatus(`Gemini is scanning ${videos.length} available channel upload${videos.length === 1 ? "" : "s"}...`);
    const trendPlan = await buildGeminiTrendPlan(videos, channelProfile);
    if (requestId !== analysisRequestId) return;
    setStatus("Searching trends chosen by Gemini...");
    let trendVideos = accessToken
      ? await fetchTrendReferenceVideos(accessToken, videos, trendPlan)
      : [];
    if (accessToken &&
        !trendVideos.length &&
        !trendVideos.outsideTrendVideos?.length &&
        allowPrompt) {
      clearCachedAccessToken();
      setStatus("Renewing YouTube access to load current trends...");
      accessToken = await requestAccessToken();
      if (requestId !== analysisRequestId) return;
      trendVideos = await fetchTrendReferenceVideos(
        accessToken,
        videos,
        trendPlan
      );
    }
    if (requestId !== analysisRequestId) return;

    const orderedVideos = focusVideoId
      ? [videos.find((video) => video.id === focusVideoId), ...videos.filter((video) => video.id !== focusVideoId)].filter(Boolean)
      : videos;
    const summary = buildChannelSummary(orderedVideos, trendVideos, channelProfile);
    setStatus("Asking Gemini for AI insights...");
    summary.geminiInsights = await buildGeminiPageInsights(summary, orderedVideos);
    if (!summary.geminiInsights) throw new Error("AI_INSIGHTS_GENERATION_FAILED");
    if (requestId !== analysisRequestId) return;
    renderChannelInsights(summary);
    saveCachedInsights(summary, videos, focusVideoId);
    const insightResult = summary.geminiInsights;
    addNotifications([
      {
        id: `insights:${insightsFingerprint(videos, focusVideoId)}:trend`,
        title: "New trend signal",
        message: insightResult.cards?.topTopicSignal?.value || summary.currentTrend,
        href: "pages/insights.html?result=latest",
        tone: "teal"
      },
      ...((insightResult.recommendations || []).slice(0, 2).map((item, index) => ({
        id: `insights:${insightsFingerprint(videos, focusVideoId)}:recommendation:${index}`,
        title: item.title || "New channel recommendation",
        message: item.body,
        href: "pages/insights.html?result=latest",
        tone: item.tone === "warn" ? "amber" : "blue"
      })))
    ]);
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    setStatus("");
    setLibraryStatus(forceRefresh
      ? (focusVideoId ? "Selected-upload insights refreshed." : "Channel-level insights refreshed.")
      : (focusVideoId ? "Insights weighted toward the selected upload." : "Channel-level insights are ready."));
  } catch (error) {
    if (requestId !== analysisRequestId) return;
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(false);
    if (error.message === "Connection canceled.") {
      setStatus("");
      return;
    }
    console.error("Could not generate channel insights.", error);
    if (error.message === "AI_INSIGHTS_RATE_LIMITED") {
      showInsightGenerationError("AI Insights usage limit reached. Try again in about a minute.");
    } else if (error.message === "AI_INSIGHTS_GENERATION_FAILED") {
      showInsightGenerationError();
    } else {
      showInsightGenerationError(error.message || "Could not generate channel insights.");
    }
  } finally {
    if (requestId === analysisRequestId) {
      setAnalyzerLoading(false);
      setBusy(false);
    }
  }
}

async function handleGenerateInsights(event) {
  event.preventDefault();
  await generateChannelInsights({allowPrompt: true});
}

async function handleRefreshInsightsPage() {
  await generateChannelInsights({allowPrompt: true, forceRefresh: true});
}

async function handleChatQuestion(event) {
  event.preventDefault();
  const question = chatInput?.value.trim() || "";
  await sendChatQuestion(question);
}

async function sendChatQuestion(question) {
  if (!question) return;
  appendChatMessage("user", question);
  if (chatInput) chatInput.value = "";
  const thinking = appendChatMessage("assistant", "Thinking...", false);
  if (chatInput) chatInput.disabled = true;

  try {
    const reply = await buildGeminiChatReply(question, latestChannelSummary);
    if (thinking) {
      thinking.textContent = reply;
      const geminiRole = "model";
      chatHistory.push({ role: geminiRole, parts: [{ text: reply }] });
    }
  } catch (error) {
    console.warn("Gemini advice failed.", error);
    if (thinking) {
      thinking.textContent = "I'm having trouble connecting to my brain right now.";
    }
  } finally {
    if (chatInput) {
      chatInput.disabled = false;
      chatInput.focus();
    }
  }
}

function handleReadMoreClick(event) {
  const button = event.target instanceof Element ? event.target.closest(".read-more-button") : null;
  if (!button) return;
  const item = button.closest(".activity-item");
  if (!item) return;
  const isExpanded = item.classList.toggle("is-expanded");
  button.textContent = isExpanded ? "Show less" : "Read more";
  button.setAttribute("aria-expanded", String(isExpanded));
}

clearAnalyzerResults();
activateInsightsTab("analysis");

if (form && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;
    selectedVideoId = "";
    clearAnalyzerResults();

    if (!currentUser) {
      channelVideos = [];
      renderVideoLibrary([]);
      setStatus("Sign in before generating AI insights.");
      setLibraryStatus("Sign in and link a channel to generate channel insights.");
      return;
    }
    await loadSavedChannelContext();

    if (!hasLinkedChannel()) {
      showChannelLinkPrompt(true);
      return;
    }
    showChannelLinkPrompt(false);

    const cachedVideos = readCachedVideos();
    let hasCachedSummary = false;
    if (cachedVideos.length) {
      renderVideoLibrary(cachedVideos);
      const cachedSummary = readCachedInsights(cachedVideos);
      if (cachedSummary) {
        hasCachedSummary = true;
        renderChannelInsights(cachedSummary);
        setAnalyzerResultsVisible(true);
        setBusy(false, "Refresh Insights");
        setLibraryStatus("Showing your latest saved AI insights.");
      } else {
        setLibraryStatus("Showing saved uploads. Generate insights or refresh for current data.");
      }
    } else {
      setLibraryStatus("Loading uploads for channel insights...");
    }
    if (!isGeminiAvailable()) {
      showMissingGeminiKeyMessage();
      return;
    }
    const videos = await loadVideoLibrary({allowPrompt: false});
    if (!hasCachedSummary && videos.length) {
      await generateChannelInsights({allowPrompt: false});
    } else if (!hasCachedSummary) {
      setBusy(false, "Generate Insights");
    }
  });

  form.addEventListener("submit", handleGenerateInsights);
  refreshInsightsPageButton?.addEventListener("click", handleRefreshInsightsPage);
  chatForm?.addEventListener("submit", handleChatQuestion);
  document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
    button.addEventListener("click", () => sendChatQuestion(button.dataset.chatPrompt || button.textContent.trim()));
  });
  analyzerDashboard?.addEventListener("click", handleReadMoreClick);
  insightTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.insightsTab;
      activateInsightsTab(tabName);
    });
    tab.addEventListener("keydown", handleInsightsTabKeydown);
  });
  videoLibrary?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest("[data-video-id]");
    if (!card) return;
    generateChannelInsights({allowPrompt: true, focusVideoId: card.dataset.videoId});
  });
  refreshVideosButton?.addEventListener("click", () =>
    loadVideoLibrary({allowPrompt: true}));
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
