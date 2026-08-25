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
import {isGeminiAvailable} from "./gemini-client.js?v=8";
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
import * as insightsModel from "./insights-model.js?v=5";
import {
  buildGeminiTrendPlan,
  compactAdviceSummary,
  setGeminiCreatorContext
} from "./insights-gemini.js?v=2";
import {
  buildGeminiChatReply,
  buildGeminiPageInsights,
  normalizeGeminiInsights
} from "./insights-gemini-page.js?v=2";
import {renderTrendSections} from "./insights-trend-renderer.js?v=1";

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
const insightsCacheVersion = 32;
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
  setGeminiCreatorContext(savedChannelContext);
  const key = channelContextStorageKey();
  if (!key) return savedChannelContext;
  const hasLocalValue = Boolean(sessionStorage.getItem(key));

  try {
    savedChannelContext = normalizeSavedChannelContext(JSON.parse(sessionStorage.getItem(key) || "{}"));
    setInsightsCreatorContext(savedChannelContext);
    setGeminiCreatorContext(savedChannelContext);
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
        setGeminiCreatorContext(savedChannelContext);
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

    const otherSameTopicVideos = trendVideos
      .filter((video) => video.id !== referencedVideo.id)
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
    return [referencedVideo, ...otherSameTopicVideos]
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
  setTrendMetric(
    [cards.topTopicSignal?.value || summary.currentTrend || summary.topSignal],
    cards.topTopicSignal?.detail || "Based on current same-topic videos",
    cards.topTopicSignal?.tone || "good"
  );
  updateRecommendations(geminiInsights?.recommendations || summary.topicIdeas);
  renderTrendSections(summary, geminiInsights, updateActivityItems);
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
    const reply = await buildGeminiChatReply(question, latestChannelSummary, chatHistory);
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
