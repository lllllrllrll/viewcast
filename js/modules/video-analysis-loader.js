import {getPrivateVideoAnalytics} from "../analyzer-private-analytics.js?v=3";
import {getRenewedYouTubeAccessToken} from "../youtube-auth.js?v=4";
import {activeYouTubeChannelId} from "../services/youtube-session.js?v=1";
import {fetchVideoById} from "../insights-youtube.js?v=5";

export function createVideoAnalysisLoader({
  getUser, getVideos, clearCachedAccessToken, readCachedAccessToken, setStatus
}) {
async function requestAccessToken() {
  if (!getUser()) throw new Error("Sign in before analyzing a video.");
  return getRenewedYouTubeAccessToken(getUser().uid, activeYouTubeChannelId());
}

async function getAccessToken() {
  return readCachedAccessToken() || requestAccessToken();
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
  let video = getVideos().find((item) => item.id === videoId) || null;
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
  return {getAccessToken, loadPrivateAnalytics, loadVideoAnalysisWithRetry, requestAccessToken};
}
