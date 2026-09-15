import {addNotifications} from "../../components/notifications.js";
import {isGeminiAvailable} from "../gemini-client.js?v=9";
import {fetchChannelProfile} from "../insights-youtube.js?v=5";
import {buildGeminiTrendPlan} from "../insights-gemini.js?v=8";
import {buildGeminiPageInsights} from "../insights-gemini-page.js?v=5";
import {buildChannelSummary, fetchTrendReferenceVideos} from "../insights-model.js?v=9";

export function createInsightsGenerator(dependencies) {
  const {
    clearCachedAccessToken, getChannelVideos, hasLinkedChannel,
    hideInsightError, insightsFingerprint, loadVideoLibrary,
    readCachedAccessToken, readCachedInsights, readCachedVideos,
    renderChannelInsights, requestAccessToken, saveCachedInsights,
    setAnalyzerLoading, setAnalyzerResultsVisible, setBusy,
    setLibraryStatus, setStatus, showChannelLinkPrompt,
    showInsightGenerationError, showMissingGeminiKeyMessage,
    updateLibrarySelection
  } = dependencies;
  let analysisRequestId = 0;

return async function generateChannelInsights({allowPrompt = true, focusVideoId = "", forceRefresh = false} = {}) {
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

    let videos = getChannelVideos().length ? getChannelVideos() : readCachedVideos();
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
      setLibraryStatus(cachedSummary.geminiInsights?.aiUnavailable
        ? "Showing channel-data insights. Gemini is temporarily unavailable."
        : "Showing recently generated AI insights.");
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
    summary.trendPlan = {
      queries: trendPlan.queries || [],
      nicheTerms: trendPlan.nicheTerms || []
    };
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
    setLibraryStatus(summary.geminiInsights.aiUnavailable
      ? "Channel-data insights are ready. Gemini is temporarily unavailable."
      : forceRefresh
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
}
