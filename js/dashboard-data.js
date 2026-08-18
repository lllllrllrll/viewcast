import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const emptyValue = "\u00a0";
const connectionStorageKey = "viewcastYouTubeConnection";
const allConnectionsKey = "viewcastYouTubeAllConnections";
const channelStorageKey = "viewcastYouTubeChannel";
const tokenStorageKey = "viewcastYouTubeAccessToken";
const overviewStorageKeyPrefix = "viewcastOverviewData:";
const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";
const firstDayHistoryKeyPrefix = "viewcastFirstDayHistory:";
const metadataHistoryKeyPrefix = "viewcastVideoMetadataHistory:";
const metadataEventsKeyPrefix = "viewcastVideoMetadataEvents:";

const trafficSourceLabels = {
  ADVERTISING: "Advertising",
  ANNOTATION: "Cards and annotations",
  CAMPAIGN_CARD: "Campaign cards",
  END_SCREEN: "End screens",
  EXT_URL: "External",
  HASHTAGS: "Hashtags",
  LIVE_REDIRECT: "Live redirect",
  NO_LINK_EMBEDDED: "Embedded",
  NO_LINK_OTHER: "Other YouTube",
  NOTIFICATION: "Notifications",
  PLAYLIST: "Playlists",
  PROMOTED: "Promoted",
  RELATED_VIDEO: "Suggested",
  SHORTS: "Shorts",
  SOUND_PAGE: "Sound page",
  SUBSCRIBER: "Subscriptions",
  YT_CHANNEL: "Channel pages",
  YT_OTHER_PAGE: "Other YouTube pages",
  YT_SEARCH: "Search"
};

function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: number >= 1000 ? 1 : 0
  }).format(number);
}

function wholeNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en").format(Math.round(number));
}

function currency(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(number);
}

function watchHours(minutes) {
  const number = numberValue(minutes);
  if (number === null) return "";
  return compactNumber(number / 60);
}

function duration(seconds) {
  const number = numberValue(seconds);
  if (number === null) return "";
  const totalSeconds = Math.max(0, Math.round(number));
  const mins = Math.floor(totalSeconds / 60);
  const secs = String(totalSeconds % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function percent(value, total) {
  const number = numberValue(value);
  const denominator = numberValue(total);
  if (number === null || !denominator) return "";
  return `${Math.round((number / denominator) * 100)}%`;
}

function formatDateLabel(value) {
  const raw = String(value || "");
  if (raw.length === 8) return `${raw.slice(4, 6)}/${raw.slice(6, 8)}`;
  if (raw.length >= 10) return `${raw.slice(5, 7)}/${raw.slice(8, 10)}`;
  return raw;
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function timeAgo(timestamp) {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return "Latest scan";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "Just scanned";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function secondsFromIso(value = "") {
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

function readCachedAccessToken(user) {
  localStorage.removeItem(tokenStorageKey);
  try {
    const token = JSON.parse(sessionStorage.getItem(tokenStorageKey) || "null");
    if (!token?.accessToken || !token.expiresAt) return "";
    if (user?.uid && token.uid && token.uid !== user.uid) return "";
    if (token.channelId !== readActiveConnection()?.channel?.id) return "";
    if (Date.now() >= token.expiresAt) return "";
    return token.accessToken;
  } catch (error) {
    sessionStorage.removeItem(tokenStorageKey);
    return "";
  }
}

function overviewStorageKey(user, channelId = "guest") {
  return `${overviewStorageKeyPrefix}${user?.uid || "guest"}:${channelId}`;
}

function readCachedOverview(user, channelId) {
  try {
    return JSON.parse(sessionStorage.getItem(overviewStorageKey(user, channelId)) || "null");
  } catch (error) {
    sessionStorage.removeItem(overviewStorageKey(user, channelId));
    return null;
  }
}

function saveCachedOverview(user, channelId, data) {
  if (!data) return;
  sessionStorage.setItem(overviewStorageKey(user, channelId), JSON.stringify({
    ...data,
    cachedAt: Date.now()
  }));
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`}
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "YouTube API request failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function normalizeConnection(value) {
  if (!value) return null;
  if (value.channel) {
    return {
      channel: value.channel || {},
      analyticsSummary: value.analyticsSummary || {}
    };
  }
  return null;
}

function readActiveConnection() {
  try {
    return normalizeConnection(JSON.parse(localStorage.getItem(connectionStorageKey) || "null"));
  } catch (error) {
    return null;
  }
}

function saveCachedConnection(connection) {
  if (!connection) {
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(channelStorageKey);
    return;
  }
  localStorage.setItem(connectionStorageKey, JSON.stringify(connection));
  localStorage.setItem(channelStorageKey, JSON.stringify(connection.channel || {}));
}

function fieldValues(connection) {
  if (!connection) return {};
  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};
  return {
    "channel-title": channel.title || "",
    "total-views": compactNumber(channel.viewCount),
    "subscriber-count": compactNumber(channel.subscriberCount),
    "video-count": wholeNumber(channel.videoCount),
    "period-views": compactNumber(analyticsSummary.views),
    "watch-hours": watchHours(analyticsSummary.estimatedMinutesWatched),
    "average-view-duration": duration(analyticsSummary.averageViewDuration),
    "subscribers-gained": wholeNumber(analyticsSummary.subscribersGained),
    "estimated-revenue": currency(analyticsSummary.estimatedRevenue)
  };
}

async function fetchAnalyticsRows(accessToken, {metrics, dimensions = "", filters = "", sort = "", maxResults = "", days = 28}) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", daysAgo(days));
  url.searchParams.set("endDate", today());
  url.searchParams.set("metrics", metrics);
  if (dimensions) url.searchParams.set("dimensions", dimensions);
  if (filters) url.searchParams.set("filters", filters);
  if (sort) url.searchParams.set("sort", sort);
  if (maxResults) url.searchParams.set("maxResults", String(maxResults));
  const payload = await fetchJson(url, accessToken);
  return payload.rows || [];
}

async function fetchUploadsPlaylistId(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchJson(url, accessToken);
  const playlistId = payload.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("No uploads playlist was found.");
  return playlistId;
}

async function fetchRecentVideos(accessToken) {
  const playlistId = await fetchUploadsPlaylistId(accessToken);
  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  playlistUrl.searchParams.set("part", "contentDetails");
  playlistUrl.searchParams.set("playlistId", playlistId);
  playlistUrl.searchParams.set("maxResults", "50");
  const playlistPayload = await fetchJson(playlistUrl, accessToken);
  const ids = (playlistPayload.items || []).map((item) => item.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,statistics,contentDetails");
  videosUrl.searchParams.set("id", ids.join(","));
  const videosPayload = await fetchJson(videosUrl, accessToken);
  return videosPayload.items || [];
}

async function fetchLiveOverview(accessToken, days = 30) {
  const [dailyResult, trafficResult, videosResult, revenueResult, videoAnalyticsResult, videoRevenueResult, countriesResult, devicesResult, subscriptionResult, searchResult, suggestedResult] = await Promise.allSettled([
    fetchAnalyticsRows(accessToken, { metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained", dimensions: "day", sort: "day", days: days }),
    fetchAnalyticsRows(accessToken, { metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views", maxResults: 5, days: days }),
    fetchRecentVideos(accessToken),
    fetchAnalyticsRows(accessToken, { metrics: "estimatedRevenue", days: 28 }),
    fetchAnalyticsRows(accessToken, { metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments,shares", dimensions: "video", sort: "-views", maxResults: 50, days: days }),
    fetchAnalyticsRows(accessToken, { metrics: "estimatedRevenue", dimensions: "video", sort: "-estimatedRevenue", maxResults: 50, days: 28 }),
    fetchAnalyticsRows(accessToken, { metrics: "views", dimensions: "country", sort: "-views", maxResults: 5, days: days }),
    fetchAnalyticsRows(accessToken, { metrics: "views", dimensions: "deviceType", sort: "-views", maxResults: 5, days: days }),
    fetchAnalyticsRows(accessToken, { metrics: "views", dimensions: "subscribedStatus", sort: "-views", maxResults: 2, days: days }),
    fetchAnalyticsRows(accessToken, { metrics: "views", dimensions: "insightTrafficSourceDetail", filters: "insightTrafficSourceType==YT_SEARCH", sort: "-views", maxResults: 5, days: days }),
    fetchAnalyticsRows(accessToken, { metrics: "views", dimensions: "insightTrafficSourceDetail", filters: "insightTrafficSourceType==RELATED_VIDEO", sort: "-views", maxResults: 5, days: days })
  ]);
  return {
    daily: dailyResult.status === "fulfilled" ? dailyResult.value : [],
    traffic: trafficResult.status === "fulfilled" ? trafficResult.value : [],
    videos: videosResult.status === "fulfilled" ? videosResult.value : [],
    estimatedRevenue: revenueResult.status === "fulfilled" ? revenueResult.value?.[0]?.[0] ?? null : null,
    videoAnalytics: videoAnalyticsResult.status === "fulfilled" ? videoAnalyticsResult.value : [],
    videoRevenue: videoRevenueResult.status === "fulfilled" ? videoRevenueResult.value : [],
    countries: countriesResult.status === "fulfilled" ? countriesResult.value : [],
    devices: devicesResult.status === "fulfilled" ? devicesResult.value : [],
    subscriptionStatus: subscriptionResult.status === "fulfilled" ? subscriptionResult.value : [],
    searchTerms: searchResult.status === "fulfilled" ? searchResult.value : [],
    suggestedVideos: suggestedResult.status === "fulfilled" ? suggestedResult.value : [],
    latestVideoScannedAt: new Date().toISOString()
  };
}

function insightItems(connection) {
  if (!connection) {
    return [
      { title: "Connect YouTube", body: "Link your channel from My Channel so ViewCast can generate recommendations.", label: "Setup" },
      { title: "No channel data yet", body: "AI Insights stays blank until verified YouTube data is available.", label: "Waiting" },
      { title: "Avoid fake metrics", body: "Recommendations are generated only from real YouTube channel data.", label: "Data" }
    ];
  }
  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};
  const views = numberValue(analyticsSummary.views);
  const watchMinutes = numberValue(analyticsSummary.estimatedMinutesWatched);
  const avgDuration = numberValue(analyticsSummary.averageViewDuration);
  const subscribersGained = numberValue(analyticsSummary.subscribersGained);
  const totalSubscribers = numberValue(channel.subscriberCount);
  const totalViews = numberValue(channel.viewCount);
  const videos = numberValue(channel.videoCount);
  const items = [];
  if (views !== null && watchMinutes !== null) {
    const minutesPerView = views > 0 ? watchMinutes / views : 0;
    if (minutesPerView >= 3) {
      items.push({ title: "Double down on long-form retention", body: "Your recent viewers are averaging about " + (Math.round(minutesPerView * 10) / 10) + " minutes watched per view.", label: "Retention" });
    } else if (views > 0) {
      items.push({ title: "Tighten the opening minute", body: "Recent watch time is about " + (Math.round(minutesPerView * 10) / 10) + " minutes per view.", label: "Hook" });
    }
  }
  if (avgDuration !== null) {
    items.push({
      title: avgDuration >= 180 ? "Package deeper follow-ups" : "Improve pacing before the midpoint",
      body: avgDuration >= 180 ? "Average view duration is " + duration(avgDuration) + ", which can support deeper series." : "Average view duration is " + duration(avgDuration) + ". Use pattern breaks to keep viewers moving.",
      label: "AVD"
    });
  }
  if (subscribersGained !== null && views !== null) {
    const subRate = views > 0 ? (subscribersGained / views) * 100 : 0;
    items.push({
      title: subRate >= 0.5 ? "Turn high-intent viewers into a series" : "Strengthen subscriber calls-to-action",
      body: subRate >= 0.5 ? "Subscriber conversion is about " + (Math.round(subRate * 100) / 100) + "%. Create a recurring format." : "Add a specific reason to subscribe near your strongest moment.",
      label: "Growth"
    });
  }
  if (totalViews !== null && videos !== null && videos > 0) {
    items.push({ title: "Audit outlier videos", body: "Your channel averages about " + compactNumber(totalViews / videos) + " views per video.", label: "Audit" });
  }
  if (totalSubscribers !== null) {
    items.push({ title: "Build for returning viewers", body: compactNumber(totalSubscribers) + " subscribers gives you a base to test repeatable content pillars.", label: "Audience" });
  }
  return items.slice(0, 3);
}

function renderInsights(connection) {
  document.querySelectorAll("[data-ai-insights]").forEach((container) => {
    const items = insightItems(connection);
    container.innerHTML = items.map((item) => `
      <div class="activity-item">
        <i class="dot"></i>
        <div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.body)}</span></div>
        <time>${escapeHtml(item.label)}</time>
      </div>
    `).join("");
  });
}

function setElementText(selector, value) {
  document.querySelectorAll(selector).forEach((element) => { element.textContent = value || emptyValue; });
}

function setTrend(name, value, className = "good") {
  document.querySelectorAll(`[data-overview-trend="${name}"]`).forEach((element) => {
    element.textContent = value || emptyValue;
    element.className = ["trend", className].join(" ");
  });
}

function setProgress(name, value, label) {
  document.querySelectorAll(`[data-overview-health="${name}"]`).forEach((item) => {
    const valueEl = item.querySelector(".progress-meta span");
    const barEl = item.querySelector(".bar i");
    if (valueEl) valueEl.textContent = label || emptyValue;
    if (barEl) barEl.style.setProperty("--value", `${Math.max(0, Math.min(100, value || 0))}%`);
  });
}

function summarizeDaily(dailyRows = []) {
  return dailyRows.reduce((summary, row) => {
    summary.views += numberValue(row[1]) || 0;
    summary.watchMinutes += numberValue(row[2]) || 0;
    summary.durationTotal += numberValue(row[3]) || 0;
    summary.durationCount += row[3] === undefined ? 0 : 1;
    summary.subscribers += numberValue(row[4]) || 0;
    return summary;
  }, { views: 0, watchMinutes: 0, durationTotal: 0, durationCount: 0, subscribers: 0 });
}

function sampledSeries(rows = []) {
  if (rows.length <= 8) return rows;
  const step = Math.ceil(rows.length / 8);
  const sampled = rows.filter((_, index) => index % step === 0);
  const last = rows[rows.length - 1];
  return sampled[sampled.length - 1] === last ? sampled : sampled.concat([last]);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function recentMonthBuckets(count = 6) {
  const formatter = new Intl.DateTimeFormat("en", {month: "short"});
  return Array.from({length: count}, (_, index) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - (count - 1 - index));
    return {
      key: monthKey(date),
      label: formatter.format(date),
      value: 0
    };
  });
}

function renderSubscribersTrend(connection, overviewData) {
  if (!document.getElementById("subsChart") || typeof window.drawLineChart !== "function") return;
  const rows = overviewData?.daily || [];
  const buckets = recentMonthBuckets(6);
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  if (!rows.length) {
    const labels = buckets.map((bucket) => bucket.label);
    const baseline = Array.from({length: labels.length}, () => 0);
    window.drawLineChart("subsChart", baseline, baseline, labels, {ySuffix: ""});
    return;
  }

  rows.forEach((row) => {
    const date = new Date(row[0]);
    if (Number.isNaN(date.getTime())) return;
    const bucket = bucketMap.get(monthKey(date));
    if (bucket) bucket.value += numberValue(row[4]) || 0;
  });

  const actual = buckets.map((bucket) => Math.max(0, Math.round(bucket.value)));
  const labels = buckets.map((bucket) => bucket.label);
  const forecast = actual.map((value) => value);
  window.drawLineChart("subsChart", actual, forecast, labels, {ySuffix: ""});
}

function weekLabel(date) {
  return new Intl.DateTimeFormat("en", {month: "short", day: "numeric"}).format(date);
}

function fallbackWeekRows() {
  return recentWeekBuckets().map((bucket) => ({
    label: bucket.label,
    count: 0
  }));
}

function weekKey(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy.toISOString().slice(0, 10);
}

function recentWeekBuckets(count = 4) {
  return Array.from({length: count}, (_, index) => {
    const start = new Date();
    start.setDate(start.getDate() - ((3 - index) * 7));
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay());
    return {
      key: weekKey(start),
      label: `Week of ${weekLabel(start)}`,
      count: 0
    };
  });
}

function renderUploadFrequency(overviewData) {
  const container = document.querySelector("[data-channel-upload-frequency]");
  if (!container) return;
  const videos = overviewData?.videos || [];
  const buckets = recentWeekBuckets(4);
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  videos.forEach((video) => {
    const published = new Date(video.snippet?.publishedAt || "");
    if (Number.isNaN(published.getTime())) return;
    const bucket = bucketMap.get(weekKey(published));
    if (bucket) bucket.count += 1;
  });

  const rows = videos.length ? buckets : fallbackWeekRows();
  const max = Math.max(1, ...rows.map((row) => row.count));

  container.innerHTML = rows.map((row) => {
    const value = Math.round((row.count / max) * 100);
    const label = row.count === 1 ? "1 upload" : `${row.count} uploads`;
    return `<div class="region-row"><span>${escapeHtml(row.label)}</span><div class="bar"><i style="--value: ${value}%"></i></div><b>${escapeHtml(label)}</b></div>`;
  }).join("");
}

function renderViewsTrend(overviewData) {
  const rows = sampledSeries(overviewData?.daily || []);
  if (!document.getElementById("viewsChart") || typeof window.drawLineChart !== "function") return;
  if (!rows.length) { window.drawLineChart("viewsChart", [], [], []); return; }
  const actual = rows.map((row) => numberValue(row[1]) || 0);
  const first = actual[0] || 0;
  const last = actual[actual.length - 1] || first;
  const forecast = actual.map((_, index) => {
    const ratio = actual.length <= 1 ? 0 : index / (actual.length - 1);
    return Math.round(first + ((last - first) * ratio));
  });
  const labels = rows.map((row) => formatDateLabel(row[0]));
  window.drawLineChart("viewsChart", actual, forecast, labels, {ySuffix: ""});
}

function renderSparklineData(overviewData) {
  const dailyViews = (overviewData?.daily || []).map((row) => numberValue(row[1]) || 0);
  document.querySelectorAll(".sparkline").forEach((canvas) => {
    canvas.dataset.values = dailyViews.join(",");
    if (typeof window.drawSparkline === "function") window.drawSparkline(canvas);
  });
}

function renderTrafficSources(overviewData) {
  const container = document.querySelector("[data-overview-traffic]");
  if (!container) return;
  const rows = overviewData?.traffic || [];
  const total = rows.reduce((sum, row) => sum + (numberValue(row[1]) || 0), 0);
  if (!rows.length || !total) {
    container.innerHTML = ["Browse", "Search", "Shorts", "External", "Suggested"].map((label) => `
      <div class="region-row"><span>${label}</span><div class="bar"><i style="--value: 0%"></i></div><b>${emptyValue}</b></div>
    `).join("");
    return;
  }
  container.innerHTML = rows.map((row) => {
    const label = trafficSourceLabels[row[0]] || String(row[0] || "Other").replace(/_/g, " ");
    const share = percent(row[1], total);
    return `<div class="region-row"><span>${escapeHtml(label)}</span><div class="bar"><i style="--value: ${share}"></i></div><b>${share}</b></div>`;
  }).join("");
}

function renderHealth(connection, overviewData) {
  if (!connection) { setProgress("watch-hours", 0, emptyValue); setProgress("avg-duration", 0, emptyValue); setProgress("subscribers", 0, emptyValue); return; }
  const analyticsSummary = connection?.analyticsSummary || {};
  const dailySummary = summarizeDaily(overviewData?.daily || []);
  const views = dailySummary.views || numberValue(analyticsSummary.views) || 0;
  const watchMinutes = dailySummary.watchMinutes || numberValue(analyticsSummary.estimatedMinutesWatched) || 0;
  const avgDuration = dailySummary.durationCount ? dailySummary.durationTotal / dailySummary.durationCount : numberValue(analyticsSummary.averageViewDuration) || 0;
  const subscribers = dailySummary.subscribers || numberValue(analyticsSummary.subscribersGained) || 0;
  setProgress("watch-hours", Math.min(100, (watchMinutes / 60) / 10 * 100), `${watchHours(watchMinutes)} hrs`);
  setProgress("avg-duration", Math.min(100, avgDuration / 180 * 100), duration(avgDuration));
  setProgress("subscribers", Math.min(100, Math.max(0, subscribers) / Math.max(1, views) * 10000), wholeNumber(subscribers));
}

function videoFormat(video) {
  const seconds = secondsFromIso(video.contentDetails?.duration || "");
  if (seconds && seconds <= 60) return "Short";
  if (seconds && seconds >= 1200) return "Long-form";
  return "Video";
}

function dashboardFormatFilter() {
  return String(window.viewcastDashboardFormat || "all");
}

function visibleDashboardVideos(overviewData) {
  const filter = dashboardFormatFilter();
  const videos = overviewData?.videos || [];
  return filter === "all" ? videos : videos.filter((video) => videoFormat(video) === filter);
}

function decimal(value, digits = 1) {
  const number = numberValue(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("en", {maximumFractionDigits: digits, minimumFractionDigits: digits}).format(number);
}

function analyticsByVideo(overviewData) {
  const revenue = new Map((overviewData?.videoRevenue || []).map((row) => [String(row[0]), numberValue(row[1])]));
  return new Map((overviewData?.videoAnalytics || []).map((row) => [String(row[0]), {
    views: numberValue(row[1]) || 0,
    watchMinutes: numberValue(row[2]) || 0,
    averageViewDuration: numberValue(row[3]),
    averageViewPercentage: numberValue(row[4]),
    subscribersGained: numberValue(row[5]) || 0,
    likes: numberValue(row[6]) || 0,
    comments: numberValue(row[7]) || 0,
    shares: numberValue(row[8]) || 0,
    revenue: revenue.get(String(row[0])) ?? null
  }]));
}

function renderVideoTable(overviewData) {
  const tbody = document.querySelector("[data-overview-videos]");
  if (!tbody) return;
  const metrics = analyticsByVideo(overviewData);
  const videos = [...visibleDashboardVideos(overviewData)]
    .filter((video) => metrics.has(String(video.id)))
    .sort((a, b) => metrics.get(String(b.id)).views - metrics.get(String(a.id)).views)
    .slice(0, 4);
  if (!videos.length) { tbody.innerHTML = `<tr><td class="table-empty-state" colspan="7">Connect YouTube Analytics to compare video performance.</td></tr>`; return; }
  tbody.innerHTML = videos.map((video) => {
    const item = metrics.get(String(video.id));
    const engagement = item.likes + item.comments + item.shares;
    const perThousand = item.views ? 1000 / item.views : 0;
    const rpm = item.revenue !== null && item.views ? item.revenue * perThousand : null;
    return `<tr><td><a class="dashboard-video-link" href="pages/analyzer.html?video=${encodeURIComponent(video.id)}">${escapeHtml(video.snippet?.title || "Untitled")}</a><small class="table-secondary">${videoFormat(video)}</small></td><td>${wholeNumber(item.views)}</td><td>${item.averageViewPercentage !== null ? `${decimal(item.averageViewPercentage)}%` : "—"}</td><td>${decimal(item.watchMinutes / 60)}</td><td>${decimal(item.subscribersGained * perThousand, 2)}</td><td>${decimal(engagement * perThousand)}</td><td>${rpm !== null ? currency(rpm) : "—"}</td></tr>`;
  }).join("");
}

function setIntelligence(key, value) {
  document.querySelectorAll(`[data-intelligence="${key}"]`).forEach((element) => { element.textContent = value || "—"; });
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderSignalList(key, rows, labeler = (value) => value) {
  const container = document.querySelector(`[data-discovery="${key}"]`);
  if (!container) return;
  const cleanRows = (rows || []).filter((row) => row?.length >= 2 && numberValue(row[1]) !== null).slice(0, 5);
  const total = cleanRows.reduce((sum, row) => sum + (numberValue(row[1]) || 0), 0);
  if (!cleanRows.length) {
    container.innerHTML = '<p class="signal-empty">Not available for this channel or period.</p>';
    return;
  }
  container.innerHTML = cleanRows.map((row) => `<div><span>${escapeHtml(labeler(row[0]))}</span><b>${wholeNumber(row[1])}${total ? ` <small>${percent(row[1], total)}</small>` : ""}</b></div>`).join("");
}

function renderFormatBenchmarks(overviewData) {
  const videos = visibleDashboardVideos(overviewData);
  const metrics = analyticsByVideo(overviewData);
  const groups = new Map();
  videos.forEach((video) => {
    const item = metrics.get(String(video.id));
    if (!item) return;
    const format = videoFormat(video);
    const group = groups.get(format) || {views: 0, count: 0};
    group.views += item.views;
    group.count += 1;
    groups.set(format, group);
  });
  renderSignalList("formats", [...groups].map(([format, group]) => [format, group.count ? group.views / group.count : 0]).sort((a, b) => b[1] - a[1]), (value) => `${value} avg.`);
}

function renderGrowthIntelligence(connection, overviewData) {
  const metrics = [...analyticsByVideo(overviewData).values()];
  const totals = metrics.reduce((sum, item) => ({
    views: sum.views + item.views,
    watchMinutes: sum.watchMinutes + item.watchMinutes,
    subscribers: sum.subscribers + item.subscribersGained,
    engagements: sum.engagements + item.likes + item.comments + item.shares,
    weightedRetention: sum.weightedRetention + ((item.averageViewPercentage || 0) * item.views),
    revenue: sum.revenue + (item.revenue || 0),
    hasRevenue: sum.hasRevenue || item.revenue !== null
  }), {views: 0, watchMinutes: 0, subscribers: 0, engagements: 0, weightedRetention: 0, revenue: 0, hasRevenue: false});

  const perThousand = totals.views ? 1000 / totals.views : 0;
  setIntelligence("typical-video", metrics.length ? `${wholeNumber(median(metrics.map((item) => item.views)))} views` : "—");
  setIntelligence("retention", totals.views ? `${decimal(totals.weightedRetention / totals.views)}%` : "—");
  setIntelligence("subscriber-conversion", totals.views ? decimal(totals.subscribers * perThousand, 2) : "—");
  setIntelligence("engagement-rate", totals.views ? decimal(totals.engagements * perThousand) : "—");
  setIntelligence("watch-velocity", metrics.length ? `${decimal(totals.watchMinutes / 60 / 28)} hrs/day` : "—");
  setIntelligence("rpm", totals.hasRevenue && totals.views ? currency(totals.revenue * perThousand) : "Not available");
  setIntelligence("revenue-coverage", totals.hasRevenue ? "Available" : "Not available");
  setIntelligence("freshness", overviewData?.latestVideoScannedAt ? `Synced ${timeAgo(overviewData.latestVideoScannedAt)}` : "Waiting for sync");

  const weekdayTotals = new Map();
  (overviewData?.daily || []).forEach((row) => {
    const date = new Date(`${row[0]}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return;
    const day = new Intl.DateTimeFormat("en", {weekday: "long", timeZone: "UTC"}).format(date);
    const value = weekdayTotals.get(day) || {views: 0, count: 0};
    value.views += numberValue(row[1]) || 0;
    value.count += 1;
    weekdayTotals.set(day, value);
  });
  const bestDay = [...weekdayTotals].sort((a, b) => (b[1].views / b[1].count) - (a[1].views / a[1].count))[0];
  setIntelligence("best-day", bestDay?.[0] || "—");

  const lifetimeViews = numberValue(connection?.channel?.viewCount);
  const dailyViews = (overviewData?.daily || []).map((row) => numberValue(row[1]) || 0);
  const recentDailyAverage = dailyViews.length ? dailyViews.reduce((sum, value) => sum + value, 0) / dailyViews.length : 0;
  if (lifetimeViews !== null && recentDailyAverage > 0) {
    const milestones = [1000, 10000, 100000, 1000000, 10000000, 100000000];
    const next = milestones.find((value) => value > lifetimeViews) || Math.ceil(lifetimeViews / 100000000) * 100000000 + 100000000;
    const days = Math.ceil((next - lifetimeViews) / recentDailyAverage);
    setIntelligence("milestone", `${compactNumber(next)} views`);
    setIntelligence("milestone-detail", `About ${wholeNumber(days)} days at the recent pace`);
  } else {
    setIntelligence("milestone", "—");
    setIntelligence("milestone-detail", "Needs recent daily views");
  }

  const countryNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], {type: "region"}) : null;
  renderSignalList("countries", overviewData?.countries, (code) => countryNames?.of(String(code)) || String(code));
  renderSignalList("devices", overviewData?.devices, (value) => String(value).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()));
  renderSignalList("subscriptions", overviewData?.subscriptionStatus, (value) => value === "SUBSCRIBED" ? "Subscribed viewers" : "Not subscribed");
  renderSignalList("search", overviewData?.searchTerms);
  const titleById = new Map((overviewData?.videos || []).map((video) => [String(video.id), video.snippet?.title || video.id]));
  renderSignalList("suggested", overviewData?.suggestedVideos, (id) => titleById.get(String(id)) || `Video ${id}`);
  renderFormatBenchmarks(overviewData);
}

function launchAgeLabel(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  return minutes ? `${wholeHours}h ${minutes}m` : `${wholeHours}h`;
}

function readLocalJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function renderFirstDayRanking(overviewData, connection, user) {
  const tbody = document.querySelector("[data-first-day-ranking]");
  if (!tbody) return;

  const now = Date.now();
  const channelId = connection?.channel?.id || "none";
  const historyKey = `${firstDayHistoryKeyPrefix}${user?.uid || "guest"}:${channelId}`;
  const history = readLocalJson(historyKey, {});
  const videoRows = visibleDashboardVideos(overviewData)
    .map((video) => {
      const publishedAt = new Date(video.snippet?.publishedAt || "").getTime();
      const ageHours = (now - publishedAt) / 3600000;
      const views = numberValue(video.statistics?.viewCount) || 0;
      return {
        video,
        ageHours,
        views,
        viewsPerHour: views / Math.max(ageHours, 1 / 60)
      };
    });
  const rankedVideos = videoRows
    .filter((item) => Number.isFinite(item.ageHours) && item.ageHours >= 0 && item.ageHours <= 24);

  rankedVideos.forEach((item) => {
    history[item.video.id] = {
      views: item.views,
      ageHours: item.ageHours,
      capturedAt: now
    };
  });
  const trimmedHistory = Object.fromEntries(Object.entries(history)
    .sort((a, b) => Number(b[1]?.capturedAt || 0) - Number(a[1]?.capturedAt || 0))
    .slice(0, 50));
  if (channelId !== "none") localStorage.setItem(historyKey, JSON.stringify(trimmedHistory));
  const activeIds = new Set(rankedVideos.map((item) => String(item.video.id)));
  const historicalFirstDays = Object.entries(trimmedHistory)
    .filter(([id, snapshot]) => !activeIds.has(id) && numberValue(snapshot?.ageHours) >= 18)
    .map(([, snapshot]) => numberValue(snapshot.views))
    .filter(Number.isFinite);
  const typicalFirstDay = median(historicalFirstDays);

  rankedVideos
    .sort((a, b) => b.viewsPerHour - a.viewsPerHour || b.views - a.views)
    .splice(5);

  if (!rankedVideos.length) {
    const message = overviewData?.videos?.length
      ? "No uploads are currently within their first 24 hours. This ranking will appear after your next upload."
      : "Connect YouTube to track videos during their first 24 hours.";
    tbody.innerHTML = `<tr><td class="table-empty-state" colspan="6">${message}</td></tr>`;
    return;
  }

  tbody.innerHTML = rankedVideos.map((item, index) => {
    const projectedFirstDay = item.viewsPerHour * 24;
    const delta = typicalFirstDay ? ((projectedFirstDay / typicalFirstDay) - 1) * 100 : null;
    const comparison = delta === null ? "Building baseline" : `${delta >= 0 ? "+" : ""}${decimal(delta, 0)}%`;
    return `
    <tr>
      <td><span class="launch-rank">${index + 1}</span></td>
      <td><a class="dashboard-video-link" href="pages/analyzer.html?video=${encodeURIComponent(item.video.id)}">${escapeHtml(item.video.snippet?.title || "Untitled")}</a></td>
      <td>${launchAgeLabel(item.ageHours)} / 24h</td>
      <td>${wholeNumber(item.views)}</td>
      <td><strong>${compactNumber(item.viewsPerHour)}</strong></td>
      <td><span class="trend ${delta === null || delta >= 0 ? "good" : "bad"}">${comparison}</span></td>
    </tr>
  `;
  }).join("");
}

function trackVideoMetadata(overviewData, connection, user) {
  const channelId = connection?.channel?.id;
  if (!channelId || !user?.uid) {
    setIntelligence("metadata-tracking", "Tracking starts after sync");
    return;
  }
  const key = `${metadataHistoryKeyPrefix}${user.uid}:${channelId}`;
  const previous = readLocalJson(key, {});
  const eventsKey = `${metadataEventsKeyPrefix}${user.uid}:${channelId}`;
  const events = readLocalJson(eventsKey, []);
  let changes = 0;
  const next = {};
  (overviewData?.videos || []).forEach((video) => {
    const id = String(video.id || "");
    if (!id) return;
    const metadata = {
      title: String(video.snippet?.title || ""),
      thumbnail: String(video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || ""),
      checkedAt: Date.now()
    };
    if (previous[id] && previous[id].title !== metadata.title) {
      changes += 1;
      events.unshift({videoId: id, title: metadata.title, type: "Title", detectedAt: Date.now()});
    }
    if (previous[id] && previous[id].thumbnail !== metadata.thumbnail) {
      changes += 1;
      events.unshift({videoId: id, title: metadata.title, type: "Thumbnail", detectedAt: Date.now()});
    }
    next[id] = metadata;
  });
  localStorage.setItem(key, JSON.stringify(next));
  localStorage.setItem(eventsKey, JSON.stringify(events.slice(0, 50)));
  setIntelligence("metadata-tracking", changes ? `${changes} change${changes === 1 ? "" : "s"} detected` : "Tracking active");
}

function renderOverviewData(connection, overviewData = null, user = null) {
  const analyticsSummary = connection?.analyticsSummary || {};
  const channel = connection?.channel || {};
  const dailySummary = summarizeDaily(overviewData?.daily || []);
  const totalViews = numberValue(channel.viewCount);
  const subscribers = numberValue(channel.subscriberCount);
  const videos = numberValue(channel.videoCount);
  const avgDuration = dailySummary.durationCount ? dailySummary.durationTotal / dailySummary.durationCount : numberValue(analyticsSummary.averageViewDuration);
  const estimatedRevenue = numberValue(overviewData?.estimatedRevenue) ?? numberValue(analyticsSummary.estimatedRevenue);

  setElementText("[data-youtube-field=\"estimated-revenue\"]", currency(estimatedRevenue));
  setTrend("total-views", totalViews !== null ? "Lifetime" : "");
  setTrend("subscriber-count", subscribers !== null ? "Total" : "");
  setTrend("video-count", videos !== null ? "Uploads" : "", "warn");
  setTrend("average-view-duration", avgDuration !== null ? "28D" : "", "good");

  renderViewsTrend(overviewData);
  renderSparklineData(overviewData);
  renderTrafficSources(overviewData);
  renderHealth(connection, overviewData);
  renderVideoTable(overviewData);
  renderFirstDayRanking(overviewData, connection, user);
  renderGrowthIntelligence(connection, overviewData);
  trackVideoMetadata(overviewData, connection, user);
  renderSubscribersTrend(connection, overviewData);
  renderUploadFrequency(overviewData);
}

function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function applyYouTubeData(connection, overviewData = null, user = null) {
  const values = fieldValues(connection);
  document.querySelectorAll("[data-youtube-field]").forEach((element) => { element.textContent = values[element.dataset.youtubeField] || emptyValue; });
  if (!connection) {
    renderInsights(null);
    renderOverviewData(null, null, user);
    window.viewcastDashboardState = {connection: null, overviewData: null, user: user || null};
    window.dispatchEvent(new CustomEvent("viewcast:dashboard-data", {detail: window.viewcastDashboardState}));
    return;
  }
  const summary = `Showing saved YouTube data for ${connection.channel.title}.`;
  document.querySelectorAll("[data-youtube-summary]").forEach((element) => { element.textContent = summary; });
  renderInsights(connection);
  renderOverviewData(connection, overviewData, user);
  window.viewcastDashboardState = {connection, overviewData, user: user || null};
  window.dispatchEvent(new CustomEvent("viewcast:dashboard-data", {detail: window.viewcastDashboardState}));
}

async function loadYouTubeData(user, db, days = 30) {
  const shouldLoadChannelHistory = Boolean(document.getElementById("subsChart"));
  if (shouldLoadChannelHistory) days = Math.max(days, 180);
  const activeConnection = readActiveConnection();
  applyYouTubeData(activeConnection, readCachedOverview(user, activeConnection?.channel?.id), user);

  const snapshot = await getDoc(doc(db, "users", user.uid));
  const data = snapshot.exists() ? snapshot.data() : {};
  const connections = data.youtubeConnections || [];
  if (data.youtubeConnection && !connections.some(c => c.channel.id === data.youtubeConnection.channel.id)) connections.push(data.youtubeConnection);

  localStorage.setItem(allConnectionsKey, JSON.stringify(connections));
  const currentActive = connections.find(c => c.channel.id === activeConnection?.channel?.id) || connections[0];
  if (currentActive) saveCachedConnection(currentActive);

  const accessToken = readCachedAccessToken(user);
  if (!currentActive || !accessToken) return;

  try {
    const liveOverview = await fetchLiveOverview(accessToken, days);
    saveCachedOverview(user, currentActive.channel.id, liveOverview);
    applyYouTubeData(currentActive, liveOverview, user);
  } catch (error) { console.warn(error); }
}

if (firebaseConfigured && document.querySelector("[data-youtube-field], [data-youtube-summary]")) {
  applyYouTubeData(readActiveConnection());
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    loadYouTubeData(user, db).catch(console.error);

    document.querySelectorAll(".segmented button").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.classList.contains("active")) return;
        const days = { "7D": 7, "30D": 30, "90D": 90 }[button.textContent.trim()];
        if (!days) return;
        button.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        loadYouTubeData(user, db, days).catch(console.error);
      });
    });
  });

  window.addEventListener("viewcast:youtube-connected", (event) => {
    saveCachedConnection(event.detail);
    const auth = getAuth();
    applyYouTubeData(event.detail, null, auth.currentUser);
    if (auth.currentUser) loadYouTubeData(auth.currentUser, getFirestore());
  });

  window.addEventListener("viewcast:youtube-unlinked", () => {
    applyYouTubeData(null, null, getAuth().currentUser);
  });

  window.addEventListener("viewcast:dashboard-filter", () => {
    const current = window.viewcastDashboardState;
    if (current) renderOverviewData(current.connection, current.overviewData, current.user);
  });
}
