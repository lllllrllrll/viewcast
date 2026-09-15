import {isGeminiAvailable} from "./gemini-client.js?v=9";
import {createBusySetter, createStatusSetter, ensureStatusElement} from "./services/ui-state.js?v=1";
import {createYouTubePageSession} from "./services/youtube-page-session.js?v=1";
import {createVideoAnalysisCache} from "./services/video-analysis-cache.js?v=1";
import {buildGeminiVideoAnalysis} from "./modules/video-gemini-analysis.js?v=2";
import {drawRetention, fallbackTimeline, renderSearchTerms, renderTimeline} from "./modules/video-analysis-renderer.js?v=1";
import {
  clearAnalyzerResults,
  setAnalyzerLoading,
  setAnalyzerResultsVisible,
  updateAnalyzerMetrics
} from "./modules/video-analysis-view.js?v=1";
import {
  fetchChannelProfile
} from "./insights-youtube.js?v=5";
import {secondsFromIso} from "./insights-format.js?v=1";
import {parseVideoId} from "./modules/analyzer-video-library.js?v=1";
import {createVideoAnalysisLoader} from "./modules/video-analysis-loader.js?v=1";
import {createAnalyzerLibraryController} from "./modules/analyzer-library-controller.js?v=1";
import {notifyVideoAnalysisComplete} from "./modules/video-analysis-notifications.js?v=1";
import {
  initialAnalyzerVideoId,
  pendingAnalyzerVideoKey,
  startAnalyzerPage
} from "./modules/analyzer-page-bootstrap.js?v=1";

const form = document.getElementById("videoAnalysisForm");
const videoUrlInput = document.getElementById("videoUrl");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
let currentUser = null;
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


const {
  getAccessToken,
  loadPrivateAnalytics,
  loadVideoAnalysisWithRetry,
  requestAccessToken
} = createVideoAnalysisLoader({
  getUser: () => currentUser,
  getVideos: () => videoLibraryController.getVideos(),
  clearCachedAccessToken,
  readCachedAccessToken,
  setStatus
});
const videoLibraryController = createAnalyzerLibraryController({
  library: videoLibrary,
  input: videoUrlInput,
  getUser: () => currentUser,
  clearCachedAccessToken,
  readCachedAccessToken,
  readCachedVideos,
  saveCachedVideos,
  getAccessToken,
  requestAccessToken,
  setBusy: setLibraryBusy,
  setStatus: setLibraryStatus
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
    videoLibraryController.select(videoId);
    const [video, analytics, retentionPoints, searchTerms, accessToken, , retentionError] = await loadVideoAnalysisWithRetry(videoId);
    if (requestId !== analysisRequestId) return;
    const cachedGeminiAnalysis = readCachedGeminiVideoAnalysis(video, analytics, retentionPoints, searchTerms);
    let geminiAnalysis = cachedGeminiAnalysis;
    setStatus(cachedGeminiAnalysis
      ? "Using recently generated Gemini analysis..."
      : isGeminiAvailable() ? "Asking Gemini to analyze this video..." : "AI service unavailable. Showing YouTube API data only.");
    const channelVideos = videoLibraryController.getVideos();
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

    videoLibraryController.select(video.id);
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
    notifyVideoAnalysisComplete(video, geminiAnalysis);
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

async function analyzeVideo(videoId = "") {
  videoId = videoId || parseVideoId(videoUrlInput?.value || "") ||
    videoLibraryController.getSelectedVideoId() ||
    videoLibraryController.getVideos()[0]?.id || "";
  if (!videoId) {
    setStatus("No video is selected. Refresh your uploads or paste a valid YouTube video URL.");
    return;
  }
  setStatus("Starting video analysis...");
  await analyzeVideoById(videoId);
}

clearAnalyzerResults();
initialVideoId = initialAnalyzerVideoId();
if (initialVideoId && videoUrlInput) {
  videoUrlInput.value = "https://www.youtube.com/watch?v=" + initialVideoId;
  setStatus("Opening selected video for analysis...");
}

startAnalyzerPage({
  form,
  videoLibrary,
  refreshVideosButton,
  initialVideoId,
  setStatus,
  onAuthChange(user, requestedVideoId) {
    currentUser = user;
    clearAnalyzerResults();
    if (!currentUser) {
      videoLibraryController.reset();
      setStatus("Sign in before analyzing a video.");
      setLibraryStatus("Sign in and link a channel to load your videos.");
      return;
    }
    const cachedVideos = readCachedVideos();
    if (cachedVideos.length) {
      videoLibraryController.render(cachedVideos);
      setLibraryStatus("Showing saved uploads. Refresh videos to check for new uploads.");
    } else {
      setLibraryStatus("Loading your linked channel uploads...");
    }
    videoLibraryController.load({allowPrompt: false});
    if (requestedVideoId) analyzeVideoById(requestedVideoId);
  },
  onAnalyze: analyzeVideo,
  onRefreshVideos: () => videoLibraryController.load({allowPrompt: true}),
  async onStudioRefresh() {
    if (!currentUser) return;
    await videoLibraryController.load({allowPrompt: true});
    const selectedVideoId = videoLibraryController.getSelectedVideoId();
    if (!selectedVideoId) return;
    const accessToken = readCachedAccessToken() || await requestAccessToken();
    const privateData = await loadPrivateAnalytics(selectedVideoId, accessToken);
    if (!privateData.analytics) return;
    const video = videoLibraryController.getVideos().find((item) => item.id === selectedVideoId);
    if (!video) return;
    updateAnalyzerMetrics(privateData.analytics);
    renderSearchTerms(privateData.searchTerms);
    requestAnimationFrame(() => drawRetention(
      privateData.retentionPoints,
      video,
      privateData.retentionError
    ));
    setLibraryStatus("Studio statistics updated automatically.");
  }
});
