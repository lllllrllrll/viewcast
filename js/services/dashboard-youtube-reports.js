import {getRenewedYouTubeAccessToken} from "../youtube-auth.js?v=5";
import {fetchStudioReport} from "./youtube-studio-analytics.js?v=2";
import {fetchYouTubeJson} from "../insights-youtube.js?v=5";
import {clearCachedYouTubeAccessToken} from "./youtube-session.js?v=1";
import {numberValue} from "../insights-format.js?v=1";

export async function fetchAnalyticsRows(accessToken, options) {
  return (await fetchStudioReport(accessToken, options)).rows || [];
}

async function fetchRecentVideos(accessToken) {
  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.searchParams.set("part", "contentDetails");
  channelUrl.searchParams.set("mine", "true");
  const channel = await fetchYouTubeJson(channelUrl, accessToken);
  const playlistId = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("No uploads playlist was found.");
  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  playlistUrl.searchParams.set("part", "contentDetails");
  playlistUrl.searchParams.set("playlistId", playlistId);
  playlistUrl.searchParams.set("maxResults", "50");
  const playlist = await fetchYouTubeJson(playlistUrl, accessToken);
  const ids = (playlist.items || []).map((item) => item.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,contentDetails");
  videosUrl.searchParams.set("id", ids.join(","));
  return (await fetchYouTubeJson(videosUrl, accessToken)).items || [];
}

export async function fetchLiveOverview(accessToken, days = 30) {
  const reports = await Promise.allSettled([
    fetchAnalyticsRows(accessToken, {metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained", dimensions: "day", sort: "day", days}),
    fetchAnalyticsRows(accessToken, {metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views", maxResults: 5, days}),
    fetchRecentVideos(accessToken),
    fetchAnalyticsRows(accessToken, {metrics: "estimatedRevenue", days: 28}),
    fetchAnalyticsRows(accessToken, {metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage", dimensions: "video", sort: "-views", maxResults: 50, days}),
    fetchAnalyticsRows(accessToken, {metrics: "views,subscribersGained,likes,comments,shares", dimensions: "video", sort: "-views", maxResults: 50, days}),
    fetchAnalyticsRows(accessToken, {metrics: "estimatedRevenue", dimensions: "video", sort: "-estimatedRevenue", maxResults: 50, days: 28}),
    fetchAnalyticsRows(accessToken, {metrics: "views", dimensions: "country", sort: "-views", maxResults: 5, days}),
    fetchAnalyticsRows(accessToken, {metrics: "views", dimensions: "deviceType", sort: "-views", maxResults: 5, days}),
    fetchAnalyticsRows(accessToken, {metrics: "views", dimensions: "subscribedStatus", sort: "-views", maxResults: 2, days}),
    fetchAnalyticsRows(accessToken, {metrics: "views", dimensions: "insightTrafficSourceDetail", filters: "insightTrafficSourceType==YT_SEARCH", sort: "-views", maxResults: 10, days}),
    fetchAnalyticsRows(accessToken, {metrics: "views", dimensions: "insightTrafficSourceDetail", filters: "insightTrafficSourceType==RELATED_VIDEO", sort: "-views", maxResults: 5, days}),
    fetchAnalyticsRows(accessToken, {metrics: "views", startDate: "2005-02-14"})
  ]);
  const [daily, traffic, videos, revenue, performance, engagement, videoRevenue,
    countries, devices, subscriptions, search, suggested, lifetime] = reports;
  if (videos.status === "rejected") throw videos.reason;
  if (daily.status === "rejected") throw daily.reason;
  const failures = {};
  [["traffic", traffic], ["revenue", revenue], ["videoAnalytics", performance],
    ["videoEngagement", engagement], ["videoRevenue", videoRevenue], ["countries", countries],
    ["devices", devices], ["subscriptionStatus", subscriptions], ["searchTerms", search],
    ["suggestedVideos", suggested], ["lifetimeViews", lifetime]].forEach(([key, result]) => {
    if (result.status === "rejected") failures[key] = {
      status: Number(result.reason?.status) || null,
      message: String(result.reason?.message || "YouTube did not return this report.").slice(0, 300)
    };
  });
  const engagementByVideo = new Map((engagement.status === "fulfilled" ? engagement.value : [])
    .map((row) => [String(row[0]), row]));
  const videoAnalytics = (performance.status === "fulfilled" ? performance.value : []).map((row) => {
    const values = engagementByVideo.get(String(row[0])) || [];
    return [row[0], row[1], row[2], row[3], row[4], values[2] ?? null,
      values[3] ?? null, values[4] ?? null, values[5] ?? null];
  });
  const value = (result, fallback = []) => result.status === "fulfilled" ? result.value : fallback;
  return {
    daily: value(daily), traffic: value(traffic), videos: value(videos),
    estimatedRevenue: revenue.status === "fulfilled" ? revenue.value?.[0]?.[0] ?? null : null,
    revenueStatus: revenue.status === "fulfilled" ? "available" : "permission-required",
    videoAnalytics, videoRevenue: value(videoRevenue), countries: value(countries),
    devices: value(devices), subscriptionStatus: value(subscriptions), searchTerms: value(search),
    suggestedVideos: value(suggested),
    lifetimeViews: lifetime.status === "fulfilled" ? numberValue(lifetime.value?.[0]?.[0]) : null,
    reportFailures: failures, latestVideoScannedAt: new Date().toISOString()
  };
}

export async function fetchOverviewWithRenewal(user, channelId, accessToken, days) {
  try {
    return await fetchLiveOverview(accessToken, days);
  } catch (error) {
    if (error?.status !== 401 && error?.status !== 403) throw error;
    clearCachedYouTubeAccessToken();
    const token = await getRenewedYouTubeAccessToken(user.uid, channelId);
    return fetchLiveOverview(token, days);
  }
}

export async function renewedStudioToken(user, channelId) {
  clearCachedYouTubeAccessToken();
  return getRenewedYouTubeAccessToken(user.uid, channelId);
}
