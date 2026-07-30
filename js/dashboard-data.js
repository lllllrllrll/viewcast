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
const insightsStorageKeyPrefix = "viewcastAiInsights:";
const recentTrendsStorageKeyPrefix = "viewcastRecentTrends:";
const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";

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
    return JSON.parse(localStorage.getItem(overviewStorageKey(user, channelId)) || "null");
  } catch (error) {
    localStorage.removeItem(overviewStorageKey(user, channelId));
    return null;
  }
}

function saveCachedOverview(user, channelId, data) {
  if (!data) return;
  localStorage.setItem(overviewStorageKey(user, channelId), JSON.stringify({
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

async function fetchAnalyticsRows(accessToken, {metrics, dimensions = "", sort = "", maxResults = "", days = 28}) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", daysAgo(days));
  url.searchParams.set("endDate", today());
  url.searchParams.set("metrics", metrics);
  if (dimensions) url.searchParams.set("dimensions", dimensions);
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
  const [dailyResult, trafficResult, videosResult, revenueResult] = await Promise.allSettled([
    fetchAnalyticsRows(accessToken, { metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained", dimensions: "day", sort: "day", days: days }),
    fetchAnalyticsRows(accessToken, { metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views", maxResults: 5, days: days }),
    fetchRecentVideos(accessToken),
    fetchAnalyticsRows(accessToken, { metrics: "estimatedRevenue", days: 28 })
  ]);
  return {
    daily: dailyResult.status === "fulfilled" ? dailyResult.value : [],
    traffic: trafficResult.status === "fulfilled" ? trafficResult.value : [],
    videos: videosResult.status === "fulfilled" ? videosResult.value : [],
    estimatedRevenue: revenueResult.status === "fulfilled" ? revenueResult.value?.[0]?.[0] ?? null : null,
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

function readRecentTrends(user) {
  if (!user?.uid) return null;
  const feedKey = `${recentTrendsStorageKeyPrefix}${user.uid}`;
  try {
    const feed = JSON.parse(localStorage.getItem(feedKey) || "null");
    if (feed?.trends) return feed;

    const legacy = JSON.parse(
      localStorage.getItem(`${insightsStorageKeyPrefix}${user.uid}:channel`) || "null"
    );
    if (!legacy?.summary) return null;
    const summary = legacy.summary;
    return {
      trends: [
        ...(summary.geminiInsights?.validatedTrends || []),
        ...(summary.currentTrends || [])
      ],
      category: summary.channelLane?.specificCategory ||
        summary.channelLane?.primaryCategory ||
        "Channel trend",
      savedAt: legacy.savedAt
    };
  } catch {
    localStorage.removeItem(feedKey);
    return null;
  }
}

function renderRecentTrends(user) {
  const container = document.querySelector("[data-overview-trends]");
  if (!container) return;
  const cached = readRecentTrends(user);
  const trends = (cached?.trends || []).slice(0, 4);

  if (!trends.length) {
    container.innerHTML = `
      <div class="activity-item">
        <i class="dot"></i>
        <div><b>No saved trends yet</b><span>Generate Trend Suggestions in AI Insights to populate this section.</span></div>
        <time>Insights</time>
      </div>`;
    return;
  }

  const category = cached.category || "Channel trend";
  const savedLabel = cached?.savedAt ? timeAgo(cached.savedAt) : "Recent";
  container.innerHTML = trends.map((trend) => `
    <div class="activity-item">
      <i class="dot"></i>
      <div><b>${escapeHtml(trend)}</b><span>${escapeHtml(category)}</span></div>
      <time>${escapeHtml(savedLabel)}</time>
    </div>
  `).join("");
}

function videoFormat(video) {
  const seconds = secondsFromIso(video.contentDetails?.duration || "");
  if (seconds && seconds <= 60) return "Short";
  if (seconds && seconds >= 1200) return "Long-form";
  return "Video";
}

function renderVideoTable(overviewData) {
  const tbody = document.querySelector("[data-overview-videos]");
  if (!tbody) return;
  const videos = [...(overviewData?.videos || [])]
    .sort((a, b) => {
      const viewDifference = (numberValue(b.statistics?.viewCount) || 0) -
        (numberValue(a.statistics?.viewCount) || 0);
      if (viewDifference) return viewDifference;

      const likeDifference = (numberValue(b.statistics?.likeCount) || 0) -
        (numberValue(a.statistics?.likeCount) || 0);
      if (likeDifference) return likeDifference;

      return (numberValue(b.statistics?.commentCount) || 0) -
        (numberValue(a.statistics?.commentCount) || 0);
    })
    .slice(0, 4);
  if (!videos.length) { tbody.innerHTML = Array.from({length: 4}, () => `<tr>${"<td>" + emptyValue + "</td>".repeat(6)}</tr>`).join(""); return; }
  tbody.innerHTML = videos.map((video) => {
    const stats = video.statistics || {};
    const views = numberValue(stats.viewCount) || 0;
    return `<tr><td>${escapeHtml(video.snippet?.title || "Untitled")}</td><td>${videoFormat(video)}</td><td>${wholeNumber(stats.viewCount)}</td><td>${wholeNumber(stats.likeCount)}</td><td>${wholeNumber(stats.commentCount)}</td><td><span class="trend good">Loaded</span></td></tr>`;
  }).join("");
}

function renderPerformanceNotifications(overviewData) {
  const container = document.querySelector("[data-performance-notifications]");
  if (!container) return;
  const videos = overviewData?.videos || [];
  if (videos.length < 2) return;
  const latestVideo = videos[0];
  const views = numberValue(latestVideo.statistics?.viewCount);
  const average = videos.slice(1).reduce((sum, v) => sum + (numberValue(v.statistics?.viewCount) || 0), 0) / (videos.length - 1);
  if (views === null || !average) return;
  const ratio = views / average;
  if (ratio >= 1.15 || ratio <= 0.85) {
    const tone = ratio >= 1.15 ? "teal" : "rose";
    const title = ratio >= 1.15 ? "Above Average" : "Below Average";
    container.innerHTML = `<a class="notif-item unread" href="pages/analyzer.html?video=${encodeURIComponent(latestVideo.id)}"><div class="notif-icon ${tone}"><svg viewBox="0 0 24 24"><path d="M12 20V10M18 20V4M6 20v-4"/></svg></div><div class="notif-body"><p><strong>${title}</strong>: ${escapeHtml(latestVideo.snippet?.title)}</p><time>Just scanned</time></div></a>`;
  }
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

  setElementText("[data-overview-status]", connection ? "Overview is using verified channel totals." : "Connect your YouTube channel to populate Overview.");
  setElementText("[data-youtube-field=\"estimated-revenue\"]", currency(estimatedRevenue));
  setTrend("total-views", totalViews !== null ? "Lifetime" : "");
  setTrend("subscriber-count", subscribers !== null ? "Total" : "");
  setTrend("video-count", videos !== null ? "Uploads" : "", "warn");
  setTrend("average-view-duration", avgDuration !== null ? "28D" : "", "good");

  renderViewsTrend(overviewData);
  renderSparklineData(overviewData);
  renderTrafficSources(overviewData);
  renderHealth(connection, overviewData);
  renderRecentTrends(user);
  renderVideoTable(overviewData);
  renderPerformanceNotifications(overviewData);
  renderSubscribersTrend(connection, overviewData);
  renderUploadFrequency(overviewData);
}

function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function applyYouTubeData(connection, overviewData = null, user = null) {
  const values = fieldValues(connection);
  document.querySelectorAll("[data-youtube-field]").forEach((element) => { element.textContent = values[element.dataset.youtubeField] || emptyValue; });
  if (!connection) { renderInsights(null); renderOverviewData(null, null, user); return; }
  const summary = `Showing saved YouTube data for ${connection.channel.title}.`;
  document.querySelectorAll("[data-youtube-summary]").forEach((element) => { element.textContent = summary; });
  renderInsights(connection);
  renderOverviewData(connection, overviewData, user);
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
    if (!user?.emailVerified) return;
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
    if (auth.currentUser?.emailVerified) loadYouTubeData(auth.currentUser, getFirestore());
  });

  window.addEventListener("viewcast:youtube-unlinked", () => {
    applyYouTubeData(null, null, getAuth().currentUser);
  });
}
