import {
  activeYouTubeChannelId,
  clearCachedYouTubeAccessToken,
  readCachedYouTubeAccessToken
} from "./youtube-session.js?v=1";
import {readCachedYouTubeVideos, saveCachedYouTubeVideos} from "./youtube-video-cache.js?v=1";

export function createYouTubePageSession(getCurrentUser) {
  const currentUser = () => getCurrentUser?.() || null;

  return {
    readCachedVideos() {
      return readCachedYouTubeVideos(currentUser()?.uid, activeYouTubeChannelId());
    },
    saveCachedVideos(videos) {
      saveCachedYouTubeVideos(currentUser()?.uid, activeYouTubeChannelId(), videos);
    },
    readCachedAccessToken() {
      return readCachedYouTubeAccessToken(currentUser()?.uid, activeYouTubeChannelId());
    },
    clearCachedAccessToken() {
      clearCachedYouTubeAccessToken();
    }
  };
}
