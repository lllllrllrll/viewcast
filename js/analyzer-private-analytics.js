import {fetchOwnedVideoAnalysis} from "./services/youtube-studio-analytics.js?v=2";

export async function getPrivateVideoAnalytics(videoId, accessToken) {
  return fetchOwnedVideoAnalysis(videoId, accessToken);
}
