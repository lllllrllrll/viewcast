import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {getFirestore} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import {isGeminiAvailable} from "./gemini-client.js?v=8";
import {studioVideoCardsHtml, syncVideoLibrarySelection} from "../components/youtube-video-library.js?v=1";
import {getRenewedYouTubeAccessToken} from "./youtube-auth.js?v=4";
import {startStudioAutoRefresh} from "./services/studio-auto-refresh.js?v=1";
import {createBusySetter, createStatusSetter, ensureStatusElement} from "./services/ui-state.js?v=1";
import {createYouTubePageSession} from "./services/youtube-page-session.js?v=1";
import {activeYouTubeChannelId} from "./services/youtube-session.js?v=1";
import {fetchChannelVideos} from "./insights-youtube.js?v=5";
import {setGeminiCreatorContext} from "./insights-gemini.js?v=8";
import {
  currentTrendSignals, setInsightsCreatorContext
} from "./insights-model.js?v=9";
import {createInsightsCache} from "./services/insights-cache.js?v=1";
import {createInsightsChat} from "./modules/insights-chat.js?v=1";
import {renderChannelInsights as renderInsightsSummary} from "./modules/insights-renderer.js?v=1";
import {createInsightsGenerator} from "./modules/insights-generator.js?v=1";
import {createInsightsPageView} from "./modules/insights-page-view.js?v=1";
const form = document.getElementById("videoAnalysisForm");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const refreshInsightsPageButton = document.getElementById("refreshInsightsPage");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("insightChatForm");
const chatInput = document.getElementById("insightChatInput");
const insightTabs = [...document.querySelectorAll("[data-insights-tab]")];
const connectionStorageKey = "viewcastYouTubeConnection";


let currentUser = null;
let auth = null;
let db = null;
let channelVideos = [];
let selectedVideoId = "";
let latestChannelSummary = null;
const {
  clearCachedAccessToken,
  readCachedAccessToken,
  readCachedVideos,
  saveCachedVideos
} = createYouTubePageSession(() => currentUser);
const {
  fingerprint: insightsFingerprint,
  loadContext: loadSavedChannelContext,
  read: readCachedInsights,
  save: saveCachedInsights
} = createInsightsCache({
  getUser: () => currentUser,
  getDb: () => db,
  setCreatorContext: (context) => {
    setInsightsCreatorContext(context);
    setGeminiCreatorContext(context);
  },
  currentTrendSignals
});

const setStatus = createStatusSetter(ensureStatusElement({
  id: "videoAnalysisStatus",
  parent: analyzerLoading?.querySelector(".analyzer-loader"),
  tagName: "p",
  className: "analysis-status"
}), {hideWhenEmpty: true});
const setBusy = createBusySetter([
  submitButton,
  {
    element: refreshInsightsPageButton,
    labelElement: () => refreshInsightsPageButton?.querySelector("span")
  }
], {
  busyLabel: "Analyzing...",
  idleLabel: () => latestChannelSummary ? "Refresh Insights" : "Generate Insights"
});

const setLibraryStatus = createStatusSetter(videoLibraryStatus);
const setLibraryBusy = createBusySetter(refreshVideosButton, {
  busyLabel: "Loading...",
  idleLabel: "Refresh Videos"
});
const {seed: setChatSeedMessage, send: sendChatQuestion} = createInsightsChat({
  messages: chatMessages,
  input: chatInput,
  getSummary: () => latestChannelSummary
});

function updateLibrarySelection(videoId) {
  selectedVideoId = videoId || "";
  syncVideoLibrarySelection(videoLibrary, selectedVideoId);
}

function renderVideoLibrary(videos = channelVideos) {
  channelVideos = Array.isArray(videos) ? videos : [];
  if (!videoLibrary) return;

  if (!channelVideos.length) {
    videoLibrary.innerHTML = '<div class="video-library-empty">No uploads are loaded yet. Refresh videos to pull from your linked channel.</div>';
    return;
  }

  videoLibrary.innerHTML = studioVideoCardsHtml(channelVideos);

  updateLibrarySelection(selectedVideoId);
}

async function requestAccessToken() {
  if (!currentUser) throw new Error("Sign in before generating insights.");
  return getRenewedYouTubeAccessToken(currentUser.uid, activeYouTubeChannelId());
}

const {
  activateTab: activateInsightsTab,
  clear: clearAnalyzerResults,
  handleTabKeydown: handleInsightsTabKeydown,
  hideError: hideInsightError,
  setLoading: setAnalyzerLoading,
  setResultsVisible: setAnalyzerResultsVisible,
  showChannelLinkPrompt,
  showError: showInsightGenerationError,
  showMissingKey: showMissingGeminiKeyMessage
} = createInsightsPageView({
  setStatus,
  setLibraryStatus,
  setChatSeedMessage,
  clearSummary: () => { latestChannelSummary = null; }
});

function hasLinkedChannel() {
  try {
    return Boolean(JSON.parse(localStorage.getItem(connectionStorageKey) || "null")?.channel?.id);
  } catch {
    return false;
  }
}
function renderChannelInsights(summary) {
  latestChannelSummary = summary;
  renderInsightsSummary(summary, setChatSeedMessage);
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

const generateChannelInsights = createInsightsGenerator({
  clearCachedAccessToken,
  getChannelVideos: () => channelVideos,
  hasLinkedChannel,
  hideInsightError,
  insightsFingerprint,
  loadVideoLibrary,
  readCachedAccessToken,
  readCachedInsights,
  readCachedVideos,
  renderChannelInsights,
  requestAccessToken,
  saveCachedInsights,
  setAnalyzerLoading,
  setAnalyzerResultsVisible,
  setBusy,
  setLibraryStatus,
  setStatus,
  showChannelLinkPrompt,
  showInsightGenerationError,
  showMissingGeminiKeyMessage,
  updateLibrarySelection
});
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
  startStudioAutoRefresh(async () => {
    if (!currentUser || !hasLinkedChannel()) return;
    const videos = await loadVideoLibrary({allowPrompt: true});
    if (videos.length) setLibraryStatus("Studio statistics updated automatically.");
  });
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
