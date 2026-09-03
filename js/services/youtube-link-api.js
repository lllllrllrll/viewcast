import {exchangeYouTubeCode} from "../youtube-auth.js?v=4";
import {fetchYouTubeJson} from "../insights-youtube.js?v=5";
import {fetchStudioReport} from "./youtube-studio-analytics.js?v=2";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
];
let googleIdentityScriptPromise = null;

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;
  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Identity Services could not load."));
    document.head.append(script);
  });
  return googleIdentityScriptPromise;
}

export async function requestYouTubeAccessToken(clientId, user) {
  if (!clientId) throw new Error("Missing Google OAuth client ID. Add your Web OAuth client ID in js/firebase-config.js.");
  await loadGoogleIdentityServices();
  return new Promise((resolve, reject) => {
    const codeClient = window.google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: scopes.join(" "),
      access_type: "offline",
      include_granted_scopes: true,
      prompt: "consent select_account",
      callback: async (response) => {
        if (response.error) return reject(new Error(response.error_description || response.error));
        try {
          const result = await exchangeYouTubeCode(response.code, window.location.origin, user.uid);
          resolve(result.accessToken);
        } catch (error) {
          reject(error);
        }
      },
      error_callback: (error) => reject(new Error(
        error.type === "popup_closed" ? "Connection canceled." : error.message || error.type || "Google authorization failed."
      ))
    });
    codeClient.requestCode();
  });
}

export async function fetchOwnedChannel(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,brandingSettings,status,contentDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchYouTubeJson(url, accessToken);
  const source = payload.items?.[0];
  if (!source) throw new Error("No YouTube channel found.");
  return {
    channel: {
      id: source.id,
      title: source.snippet?.title || "",
      url: `https://www.youtube.com/channel/${source.id}`,
      thumbnail: source.snippet?.thumbnails?.default?.url || "",
      subscriberCount: source.statistics?.subscriberCount || "",
      viewCount: source.statistics?.viewCount || "",
      videoCount: source.statistics?.videoCount || ""
    },
    ownerData: {
      customUrl: String(source.snippet?.customUrl || "").slice(0, 200),
      country: String(source.snippet?.country || "").slice(0, 8),
      description: String(source.snippet?.description || "").slice(0, 2000),
      keywords: String(source.brandingSettings?.channel?.keywords || "").slice(0, 1000),
      privacyStatus: String(source.status?.privacyStatus || "").slice(0, 32),
      longUploadsStatus: String(source.status?.longUploadsStatus || "").slice(0, 32),
      isLinked: Boolean(source.status?.isLinked),
      madeForKids: Boolean(source.status?.madeForKids),
      selfDeclaredMadeForKids: Boolean(source.status?.selfDeclaredMadeForKids),
      uploadsPlaylistId: String(source.contentDetails?.relatedPlaylists?.uploads || "").slice(0, 128),
      analyticsAccess: true,
      monetaryAnalyticsAccess: false
    }
  };
}

export async function fetchAnalyticsSummary(accessToken) {
  const payload = await fetchStudioReport(accessToken, {
    days: 28,
    metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained"
  });
  const row = payload.rows?.[0] || [];
  const optional = (await fetchStudioReport(accessToken, {
    days: 28,
    metrics: "views,subscribersLost,likes,comments,shares,videosAddedToPlaylists,videosRemovedFromPlaylists"
  }).catch(() => ({rows: []}))).rows?.[0] || [];
  const summary = {
    views: Number(row[0]) || 0,
    estimatedMinutesWatched: Number(row[1]) || 0,
    averageViewDuration: Number(row[2]) || 0,
    averageViewPercentage: Number(row[3]) || 0,
    subscribersGained: Number(row[4]) || 0,
    subscribersLost: Number(optional[1]) || 0,
    likes: Number(optional[2]) || 0,
    comments: Number(optional[3]) || 0,
    shares: Number(optional[4]) || 0,
    videosAddedToPlaylists: Number(optional[5]) || 0,
    videosRemovedFromPlaylists: Number(optional[6]) || 0,
    estimatedRevenue: null
  };
  try {
    const revenue = await fetchStudioReport(accessToken, {days: 28, metrics: "estimatedRevenue"});
    summary.estimatedRevenue = revenue.rows?.[0]?.[0] ?? null;
  } catch (error) {
    console.warn("Revenue data is unavailable for this channel.", error);
  }
  return summary;
}
