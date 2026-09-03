import {revokeStoredYouTubeAuthorization} from "../youtube-auth.js?v=4";

const TOKEN_KEY = "viewcastYouTubeAccessToken";
const exactKeys = new Set([
  TOKEN_KEY,
  "viewcastYouTubeConnection",
  "viewcastYouTubeAllConnections",
  "viewcastYouTubeChannel",
  "viewcastPendingAnalyzerVideo",
  "viewcastNotifications",
  "viewcastNotificationsRead",
  "viewcastLatestThumbnailResult",
  "viewcastLatestThumbnailComparison"
]);
const prefixes = [
  "viewcastYouTubeVideos:",
  "viewcastOverviewData:",
  "viewcastAiInsights:",
  "viewcastRecentTrends:",
  "viewcastGeminiVideoAnalysis:",
  "viewcastChannelContext:",
  "viewcastThumbnailAnalysis:",
  "viewcastThumbnailComparison:"
];

function cachedYouTubeToken() {
  try {
    return JSON.parse(
      localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "null"
    )?.accessToken || "";
  } catch {
    return "";
  }
}

export async function revokeYouTubeAccessToken(accessToken = cachedYouTubeToken()) {
  if (!accessToken) return;
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({token: accessToken})
    });
  } catch {
    // Local cleanup still runs when Google cannot be reached.
  }
}

export function clearCreatorDataCaches() {
  [localStorage, sessionStorage].forEach((storage) => {
    Object.keys(storage)
      .filter((key) => exactKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))
      .forEach((key) => storage.removeItem(key));
  });
}

export async function secureSignOut(auth, signOut) {
  await revokeStoredYouTubeAuthorization().catch(() => revokeYouTubeAccessToken());
  clearCreatorDataCaches();
  await signOut(auth);
}
