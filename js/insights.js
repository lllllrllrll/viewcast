import {isGeminiAvailable} from "./gemini-client.js?v=9";
import {getRenewedYouTubeAccessToken} from "./youtube-auth.js?v=5";
import {createBusySetter, createStatusSetter, ensureStatusElement} from "./services/ui-state.js?v=1";
import {createYouTubePageSession} from "./services/youtube-page-session.js?v=1";
import {activeYouTubeChannelId} from "./services/youtube-session.js?v=1";
import {setGeminiCreatorContext} from "./insights-gemini.js?v=8";
import {
  currentTrendSignals, setInsightsCreatorContext
} from "./insights-model.js?v=9";
import {createInsightsCache} from "./services/insights-cache.js?v=1";
import {createInsightsChat} from "./modules/insights-chat.js?v=1";
import {renderChannelInsights as renderInsightsSummary} from "./modules/insights-renderer.js?v=1";
import {createInsightsGenerator} from "./modules/insights-generator.js?v=1";
import {createInsightsPageView} from "./modules/insights-page-view.js?v=1";
import {createInsightsLibraryController} from "./modules/insights-library-controller.js?v=1";
import {startInsightsPage} from "./modules/insights-page-bootstrap.js?v=1";
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
let db = null;
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

const videoLibraryController = createInsightsLibraryController({
  library: videoLibrary,
  getUser: () => currentUser,
  clearCachedAccessToken,
  readCachedAccessToken,
  readCachedVideos,
  saveCachedVideos,
  requestAccessToken,
  setBusy: setLibraryBusy,
  setStatus: setLibraryStatus
});

const generateChannelInsights = createInsightsGenerator({
  clearCachedAccessToken,
  getChannelVideos: () => videoLibraryController.getVideos(),
  hasLinkedChannel,
  hideInsightError,
  insightsFingerprint,
  loadVideoLibrary: videoLibraryController.load,
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
  updateLibrarySelection: videoLibraryController.select
});

clearAnalyzerResults();
activateInsightsTab("analysis");

startInsightsPage({
  form,
  refreshInsightsButton: refreshInsightsPageButton,
  chatForm,
  chatInput,
  dashboard: analyzerDashboard,
  tabs: insightTabs,
  videoLibrary,
  refreshVideosButton,
  setStatus,
  async onAuthChange(user, firestore) {
    currentUser = user;
    db = firestore;
    clearAnalyzerResults();

    if (!currentUser) {
      videoLibraryController.reset();
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
      videoLibraryController.render(cachedVideos);
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
    const videos = await videoLibraryController.load({allowPrompt: false});
    if (!hasCachedSummary && videos.length) {
      await generateChannelInsights({allowPrompt: false});
    } else if (!hasCachedSummary) {
      setBusy(false, "Generate Insights");
    }
  },
  onGenerate: () => generateChannelInsights({allowPrompt: true}),
  onRefreshInsights: () => generateChannelInsights({allowPrompt: true, forceRefresh: true}),
  onChatQuestion: sendChatQuestion,
  onActivateTab: activateInsightsTab,
  onTabKeydown: handleInsightsTabKeydown,
  onSelectVideo: (videoId) => generateChannelInsights({allowPrompt: true, focusVideoId: videoId}),
  onRefreshVideos: () => videoLibraryController.load({allowPrompt: true}),
  async onStudioRefresh() {
    if (!currentUser || !hasLinkedChannel()) return;
    const videos = await videoLibraryController.load({allowPrompt: true});
    if (videos.length) setLibraryStatus("Studio statistics updated automatically.");
  }
});
