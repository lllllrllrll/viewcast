export const YOUTUBE_CONNECTION_KEY = "viewcastYouTubeConnection";
export const YOUTUBE_TOKEN_KEY = "viewcastYouTubeAccessToken";

export function readActiveYouTubeConnection() {
  try {
    return JSON.parse(localStorage.getItem(YOUTUBE_CONNECTION_KEY) || "null");
  } catch {
    return null;
  }
}

export function activeYouTubeChannelId() {
  return readActiveYouTubeConnection()?.channel?.id || "";
}

export function clearCachedYouTubeAccessToken() {
  localStorage.removeItem(YOUTUBE_TOKEN_KEY);
  sessionStorage.removeItem(YOUTUBE_TOKEN_KEY);
}

export function readCachedYouTubeAccessToken(uid, channelId = activeYouTubeChannelId()) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(YOUTUBE_TOKEN_KEY) || "null");
    if (saved?.accessToken && saved.uid === uid && saved.channelId === channelId &&
        saved.expiresAt > Date.now() + 60 * 1000) {
      return saved.accessToken;
    }
  } catch {
    // The shared cleanup below handles malformed entries.
  }
  clearCachedYouTubeAccessToken();
  return "";
}
