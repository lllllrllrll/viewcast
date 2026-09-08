import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import {isGeminiAvailable} from "./gemini-client.js?v=8";
import { addNotifications } from "../components/notifications.js";
import {startStudioAutoRefresh} from "./services/studio-auto-refresh.js?v=1";
import {createBusySetter, createStatusSetter, ensureStatusElement} from "./services/ui-state.js?v=1";
import {createYouTubePageSession} from "./services/youtube-page-session.js?v=1";
import {createVideoAnalysisCache} from "./services/video-analysis-cache.js?v=1";
import {activeYouTubeChannelId} from "./services/youtube-session.js?v=1";
import {buildGeminiVideoAnalysis} from "./modules/video-gemini-analysis.js?v=1";
import {drawRetention, fallbackTimeline, renderSearchTerms, renderTimeline} from "./modules/video-analysis-renderer.js?v=1";
import {
  clearAnalyzerResults,
  setAnalyzerLoading,
  setAnalyzerResultsVisible,
  updateAnalyzerMetrics
} from "./modules/video-analysis-view.js?v=1";
import {
  fetchChannelProfile,
  fetchChannelVideos
} from "./insights-youtube.js?v=5";
import {secondsFromIso} from "./insights-format.js?v=1";
import {
  parseVideoId, renderAnalyzerVideoLibrary, selectLibraryVideo
} from "./modules/analyzer-video-library.js?v=1";
import {createVideoAnalysisLoader} from "./modules/video-analysis-loader.js?v=1";

const form = document.getElementById("videoAnalysisForm");
const videoUrlInput = document.getElementById("videoUrl");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";
let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let initialVideoId = "";
const {
  clearCachedAccessToken,
  readCachedAccessToken,
  readCachedVideos,
  saveCachedVideos
} = createYouTubePageSession(() => currentUser);
const {
  read: readCachedGeminiVideoAnalysis,
  save: saveCachedGeminiVideoAnalysis
} = createVideoAnalysisCache(() => currentUser);

const setStatus = createStatusSetter(ensureStatusElement({
  id: "videoAnalysisStatus",
  parent: form,
  className: "analysis-status"
}));
const setBusy = createBusySetter(submitButton, {
  busyLabel: "Analyzing...",
  idleLabel: "Analyze"
});
const setLibraryStatus = createStatusSetter(videoLibraryStatus);
const setLibraryBusy = createBusySetter(refreshVideosButton, {
  busyLabel: "Loading...",
  idleLabel: "Refresh Videos"
});


function updateLibrarySelection(videoId) {
  selectedVideoId = selectLibraryVideo(videoLibrary, videoId);
}

function renderVideoLibrary(videos = channelVideos) {
  const result = renderAnalyzerVideoLibrary({
    videos, library: videoLibrary, input: videoUrlInput, selectedVideoId
  });
  channelVideos = result.videos;
  selectedVideoId = result.selectedVideoId;
}
const {
  getAccessToken,
  loadPrivateAnalytics,
  loadVideoAnalysisWithRetry,
  requestAccessToken
} = createVideoAnalysisLoader({
  getUser: () => currentUser,
  getVideos: () => channelVideos,
  clearCachedAccessToken,
  readCachedAccessToken,
  setStatus
});
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
    updateAnalyzerMetrics(analytics, geminiAnalysis);
    renderSearchTerms(searchTerms);
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
    requestAnimationFrame(() => drawRetention(retentionPoints, video, retentionError));
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
    updateAnalyzerMetrics(null);
    renderSearchTerms([]);
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
    updateAnalyzerMetrics(privateData.analytics);
    renderSearchTerms(privateData.searchTerms);
    requestAnimationFrame(() => drawRetention(
      privateData.retentionPoints,
      video,
      privateData.retentionError
    ));
    setLibraryStatus("Studio statistics updated automatically.");
  });
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
