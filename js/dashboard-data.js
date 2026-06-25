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
const channelStorageKey = "viewcastYouTubeChannel";
const tokenStorageKey = "viewcastYouTubeAccessToken";
const overviewStorageKeyPrefix = "viewcastOverviewData:";

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
  try {
    const token = JSON.parse(localStorage.getItem(tokenStorageKey) || "null");
    if (!token?.accessToken || !token.expiresAt) return "";
    if (user?.uid && token.uid && token.uid !== user.uid) return "";
    if (Date.now() >= token.expiresAt) return "";
    return token.accessToken;
  } catch (error) {
    localStorage.removeItem(tokenStorageKey);
    return "";
  }
}

function overviewStorageKey(user) {
  return `${overviewStorageKeyPrefix}${user?.uid || "guest"}`;
}

function readCachedOverview(user) {
  try {
    return JSON.parse(localStorage.getItem(overviewStorageKey(user)) || "null");
  } catch (error) {
    localStorage.removeItem(overviewStorageKey(user));
    return null;
  }
}

function saveCachedOverview(user, data) {
  if (!data) return;
  localStorage.setItem(overviewStorageKey(user), JSON.stringify({
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

function savedConnectionFromProfile(profile = {}) {
  const connection = profile.youtubeConnection || {};
  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};

  if (!channel.id && !channel.title && !profile.youtubeChannelUrl) return null;

  return {
    channel: {
      ...channel,
      title: channel.title || profile.youtubeChannelTitle || "",
      url: channel.url || profile.youtubeChannelUrl || ""
    },
    analyticsSummary
  };
}

function normalizeConnection(value) {
  if (!value) return null;
  if (value.channel) {
    return {
      channel: value.channel || {},
      analyticsSummary: value.analyticsSummary || {}
    };
  }
  if (value.id || value.title || value.url) {
    return {
      channel: value,
      analyticsSummary: {}
    };
  }
  return null;
}

function readCachedConnection() {
  try {
    const savedConnection = normalizeConnection(
      JSON.parse(localStorage.getItem(connectionStorageKey) || "null")
    );
    if (savedConnection) return savedConnection;

    return normalizeConnection(
      JSON.parse(localStorage.getItem(channelStorageKey) || "null")
    );
  } catch (error) {
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(channelStorageKey);
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
    "subscribers-gained": wholeNumber(analyticsSummary.subscribersGained)
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
  if (!playlistId) throw new Error("No uploads playlist was found for your linked channel.");
  return playlistId;
}

async function fetchRecentVideos(accessToken) {
  const playlistId = await fetchUploadsPlaylistId(accessToken);
  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  playlistUrl.searchParams.set("part", "contentDetails");
  playlistUrl.searchParams.set("playlistId", playlistId);
  playlistUrl.searchParams.set("maxResults", "4");
  const playlistPayload = await fetchJson(playlistUrl, accessToken);
  const ids = (playlistPayload.items || [])
    .map((item) => item.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return [];

  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,statistics,contentDetails");
  videosUrl.searchParams.set("id", ids.join(","));
  const videosPayload = await fetchJson(videosUrl, accessToken);
  return videosPayload.items || [];
}

async function fetchLiveOverview(accessToken, days = 30) {
  const [dailyResult, trafficResult, videosResult] = await Promise.allSettled([
    fetchAnalyticsRows(accessToken, {
      metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained",
      dimensions: "day",
      sort: "day",
      days: days
    }),
    fetchAnalyticsRows(accessToken, {
      metrics: "views",
      dimensions: "insightTrafficSourceType",
      sort: "-views",
      maxResults: 5,
      days: days
    }),
    fetchRecentVideos(accessToken)
  ]);

  return {
    daily: dailyResult.status === "fulfilled" ? dailyResult.value : [],
    traffic: trafficResult.status === "fulfilled" ? trafficResult.value : [],
    videos: videosResult.status === "fulfilled" ? videosResult.value : [],
    latestVideoScannedAt: new Date().toISOString()
  };
}

function insightItems(connection) {
  if (!connection) {
    return [
      {
        title: "Connect YouTube",
        body: "Link your channel from My Channel so ViewCast can generate recommendations from real analytics.",
        label: "Setup"
      },
      {
        title: "No channel data yet",
        body: "AI Insights stays blank until verified YouTube data is available.",
        label: "Waiting"
      },
      {
        title: "Avoid fake metrics",
        body: "Recommendations are generated only from saved YouTube channel and analytics values.",
        label: "Data"
      }
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
      items.push({
        title: "Double down on long-form retention",
        body: "Your recent viewers are averaging about " + (Math.round(minutesPerView * 10) / 10) + " minutes watched per view. Build follow-up videos around the formats that hold attention longest.",
        label: "Retention"
      });
    } else if (views > 0) {
      items.push({
        title: "Tighten the opening minute",
        body: "Recent watch time is about " + (Math.round(minutesPerView * 10) / 10) + " minutes per view. Test faster hooks, earlier payoff, and clearer video promises.",
        label: "Hook"
      });
    }
  }

  if (avgDuration !== null) {
    items.push({
      title: avgDuration >= 180 ? "Package deeper follow-ups" : "Improve pacing before the midpoint",
      body: avgDuration >= 180
        ? "Average view duration is " + duration(avgDuration) + ", which can support deeper sequels, series, and pinned playlists."
        : "Average view duration is " + duration(avgDuration) + ". Use chapters, pattern breaks, and earlier examples to keep viewers moving.",
      label: "AVD"
    });
  }

  if (subscribersGained !== null && views !== null) {
    const subRate = views > 0 ? (subscribersGained / views) * 100 : 0;
    items.push({
      title: subRate >= 0.5 ? "Turn high-intent viewers into a series" : "Strengthen subscriber calls-to-action",
      body: subRate >= 0.5
        ? "Subscriber conversion is about " + (Math.round(subRate * 100) / 100) + "% of recent views. Create a clear next episode or recurring format."
        : "Subscriber conversion is about " + (Math.round(subRate * 100) / 100) + "% of recent views. Add a specific reason to subscribe near your strongest moment.",
      label: "Growth"
    });
  }

  if (totalViews !== null && videos !== null && videos > 0) {
    items.push({
      title: "Audit outlier videos",
      body: "Your channel averages about " + compactNumber(totalViews / videos) + " views per video. Compare top performers against recent uploads for topic and title patterns.",
      label: "Audit"
    });
  }

  if (totalSubscribers !== null) {
    items.push({
      title: "Build for returning viewers",
      body: compactNumber(totalSubscribers) + " subscribers gives you a base to test community posts, premieres, and repeatable content pillars.",
      label: "Audience"
    });
  }

  if (!items.length) {
    items.push({
      title: "Reconnect YouTube analytics",
      body: "Channel metadata is available, but the 28-day analytics summary is missing. Reconnect YouTube from My Channel to refresh it.",
      label: "Refresh"
    });
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
  document.querySelectorAll(selector).forEach((element) => {
    element.textContent = value || emptyValue;
  });
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
  }, {
    views: 0,
    watchMinutes: 0,
    durationTotal: 0,
    durationCount: 0,
    subscribers: 0
  });
}

function sampledSeries(rows = []) {
  if (rows.length <= 8) return rows;
  const step = Math.ceil(rows.length / 8);
  const sampled = rows.filter((_, index) => index % step === 0);
  const last = rows[rows.length - 1];
  return sampled[sampled.length - 1] === last ? sampled : sampled.concat([last]);
}

function renderViewsTrend(overviewData) {
  const rows = sampledSeries(overviewData?.daily || []);
  if (!document.getElementById("viewsChart") || typeof window.drawLineChart !== "function") return;
  if (!rows.length) {
    window.drawLineChart("viewsChart", [], [], []);
    return;
  }

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
    return `
      <div class="region-row">
        <span>${escapeHtml(label)}</span>
        <div class="bar"><i style="--value: ${share}"></i></div>
        <b>${share}</b>
      </div>
    `;
  }).join("");
}

function renderHealth(connection, overviewData) {
  if (!connection) {
    setProgress("watch-hours", 0, emptyValue);
    setProgress("avg-duration", 0, emptyValue);
    setProgress("subscribers", 0, emptyValue);
    return;
  }

  const analyticsSummary = connection?.analyticsSummary || {};
  const dailySummary = summarizeDaily(overviewData?.daily || []);
  const views = dailySummary.views || numberValue(analyticsSummary.views) || 0;
  const watchMinutes = dailySummary.watchMinutes || numberValue(analyticsSummary.estimatedMinutesWatched) || 0;
  const avgDuration = dailySummary.durationCount
    ? dailySummary.durationTotal / dailySummary.durationCount
    : numberValue(analyticsSummary.averageViewDuration) || 0;
  const subscribers = dailySummary.subscribers || numberValue(analyticsSummary.subscribersGained) || 0;

  setProgress("watch-hours", Math.min(100, (watchMinutes / 60) / 10 * 100), `${watchHours(watchMinutes)} hrs`);
  setProgress("avg-duration", Math.min(100, avgDuration / 180 * 100), duration(avgDuration));
  setProgress("subscribers", Math.min(100, Math.max(0, subscribers) / Math.max(1, views) * 10000), wholeNumber(subscribers));
}

function renderActivity(connection, overviewData) {
  const container = document.querySelector("[data-overview-activity]");
  if (!container) return;
  if (!connection) {
    container.innerHTML = [
      ["Connect YouTube", "Link your channel from My Channel to populate Overview with verified data.", "Setup"],
      ["Waiting for analytics", "No private channel summary has been synced yet.", "Data"],
      ["No recent uploads loaded", "Recent video rows appear after YouTube access is available.", "Uploads"],
      ["Charts are blank", "View trend and traffic sources stay empty until real analytics are available.", "Charts"]
    ].map(([title, body, label]) => activityMarkup(title, body, label)).join("");
    return;
  }

  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};
  const videos = overviewData?.videos || [];
  const dailySummary = summarizeDaily(overviewData?.daily || []);
  const title = channel.title || "Linked channel";
  const items = [
    [title, "Channel totals and saved analytics are connected to this dashboard.", "Live"],
    ["28-day views", dailySummary.views || analyticsSummary.views
      ? `${wholeNumber(dailySummary.views || analyticsSummary.views)} verified views in the current analytics window.`
      : "YouTube Analytics views will appear after the next successful sync.", "Views"],
    ["Watch time", dailySummary.watchMinutes || analyticsSummary.estimatedMinutesWatched
      ? `${watchHours(dailySummary.watchMinutes || analyticsSummary.estimatedMinutesWatched)} watch hours synced from YouTube Analytics.`
      : "Watch time will appear after YouTube Analytics is available.", "Watch"],
    videos[0]
      ? ["Latest upload", `${videos[0].snippet?.title || "Recent video"} is loaded in the performance table.`, "Video"]
      : ["Recent uploads", "Use My Channel to refresh YouTube access if recent uploads are missing.", "Refresh"]
  ];
  container.innerHTML = items.map(([titleText, body, label]) => activityMarkup(titleText, body, label)).join("");
}

function activityMarkup(title, body, label) {
  return `
    <div class="activity-item">
      <i class="dot"></i>
      <div><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div>
      <time>${escapeHtml(label)}</time>
    </div>
  `;
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
  const videos = overviewData?.videos || [];
  if (!videos.length) {
    tbody.innerHTML = Array.from({length: 4}, () => `
      <tr>
        <td>${emptyValue}</td>
        <td>${emptyValue}</td>
        <td>${emptyValue}</td>
        <td>${emptyValue}</td>
        <td>${emptyValue}</td>
        <td>${emptyValue}</td>
      </tr>
    `).join("");
    return;
  }

  tbody.innerHTML = videos.map((video) => {
    const stats = video.statistics || {};
    const views = numberValue(stats.viewCount) || 0;
    const status = views > 0 ? "Loaded" : "Published";
    return `
      <tr>
        <td>${escapeHtml(video.snippet?.title || "Untitled video")}</td>
        <td>${videoFormat(video)}</td>
        <td>${wholeNumber(stats.viewCount)}</td>
        <td>${wholeNumber(stats.likeCount)}</td>
        <td>${wholeNumber(stats.commentCount)}</td>
        <td><span class="trend ${views > 0 ? "good" : "warn"}">${status}</span></td>
      </tr>
    `;
  }).join("");
}

function recentUploadAverage(videos, selectedVideoId = "") {
  const values = videos
    .filter((video) => video.id !== selectedVideoId)
    .map((video) => numberValue(video.statistics?.viewCount))
    .filter((value) => value !== null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function performanceNotificationItems(overviewData) {
  const videos = overviewData?.videos || [];
  if (videos.length < 2) return [];

  const latestVideo = videos[0];
  const views = numberValue(latestVideo.statistics?.viewCount);
  const average = recentUploadAverage(videos, latestVideo.id);
  if (views === null || !average) return [];

  const ratio = views / average;
  const title = latestVideo.snippet?.title || "Most recent upload";
  const scanTime = timeAgo(overviewData.latestVideoScannedAt);
  if (ratio >= 1.15) {
    return [{
      videoId: latestVideo.id,
      tone: "teal",
      title: "Latest Upload Above Average",
      body: `${title} is ${Math.round(ratio * 100)}% of your recent-upload average.`,
      time: scanTime
    }];
  }

  if (ratio <= 0.85) {
    return [{
      videoId: latestVideo.id,
      tone: "rose",
      title: "Latest Upload Below Average",
      body: `${title} is ${Math.round(ratio * 100)}% of your recent-upload average.`,
      time: scanTime
    }];
  }

  return [];
}

function renderPerformanceNotifications(overviewData) {
  const container = document.querySelector("[data-performance-notifications]");
  const badge = document.querySelector(".notif-badge");
  const markRead = document.getElementById("markRead");
  if (!container) return;

  const items = performanceNotificationItems(overviewData);
  if (!items.length) {
    container.innerHTML = '<div class="notif-empty">No latest-upload performance alert yet.</div>';
    if (badge) badge.hidden = true;
    if (markRead) markRead.hidden = true;
    return;
  }

  container.innerHTML = items.map((item) => `
    <a class="notif-item unread" href="pages/analyzer.html?video=${encodeURIComponent(item.videoId)}">
      <div class="notif-icon ${item.tone}">
        <svg viewBox="0 0 24 24"><path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" /></svg>
      </div>
      <div class="notif-body">
        <p><strong>${escapeHtml(item.title)}</strong>: ${escapeHtml(item.body)}</p>
        <time>${escapeHtml(item.time)}</time>
      </div>
    </a>
  `).join("");
  if (badge) badge.hidden = false;
  if (markRead) markRead.hidden = false;
}

function renderOverviewData(connection, overviewData = null) {
  const analyticsSummary = connection?.analyticsSummary || {};
  const channel = connection?.channel || {};
  const dailySummary = summarizeDaily(overviewData?.daily || []);
  const totalViews = numberValue(channel.viewCount);
  const subscribers = numberValue(channel.subscriberCount);
  const videos = numberValue(channel.videoCount);
  const avgDuration = dailySummary.durationCount
    ? dailySummary.durationTotal / dailySummary.durationCount
    : numberValue(analyticsSummary.averageViewDuration);

  setElementText("[data-overview-status]", connection
    ? "Overview is using verified channel totals plus the latest saved YouTube Analytics data."
    : "Connect your YouTube channel from My Channel to populate Overview with verified data.");
  setElementText('[data-overview-kpi="reach"]', totalViews !== null
    ? [
      `${wholeNumber(totalViews)} lifetime views`,
      analyticsSummary.views !== undefined ? `${compactNumber(analyticsSummary.views)} views in the current 28-day window` : ""
    ].filter(Boolean).join(" with ") + "."
    : "Connect YouTube to show verified reach and discovery movement.");
  setElementText('[data-overview-kpi="retention"]', avgDuration !== null
    ? `Average view duration is ${duration(avgDuration)} with ${watchHours(dailySummary.watchMinutes || analyticsSummary.estimatedMinutesWatched)} watch hours.`
    : "Average view duration and watch time appear after analytics sync.");
  setElementText('[data-overview-kpi="next"]', videos !== null
    ? `${wholeNumber(videos)} uploads are available for planning follow-up content and review.`
    : "Recent uploads and next actions update from your channel data.");

  setTrend("total-views", totalViews !== null ? "Lifetime" : "");
  setTrend("subscriber-count", subscribers !== null ? "Total" : "");
  setTrend("video-count", videos !== null ? "Uploads" : "", "warn");
  setTrend("average-view-duration", avgDuration !== null ? "28D" : (connection ? "Unavailable" : ""), avgDuration !== null ? "good" : "warn");

  renderViewsTrend(overviewData);
  renderSparklineData(overviewData);
  renderTrafficSources(overviewData);
  renderHealth(connection, overviewData);
  renderActivity(connection, overviewData);
  renderVideoTable(overviewData);
  renderPerformanceNotifications(overviewData);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyYouTubeData(connection, overviewData = null) {
  const values = fieldValues(connection);

  document.querySelectorAll("[data-youtube-field]").forEach((element) => {
    const value = values[element.dataset.youtubeField] || "";
    element.textContent = value || emptyValue;
  });

  document.querySelectorAll("[data-youtube-summary]").forEach((element) => {
    element.dataset.youtubeDefault ||= element.textContent;
  });

  if (!connection) {
    document.querySelectorAll("[data-youtube-summary]").forEach((element) => {
      element.textContent = element.dataset.youtubeDefault || "";
    });
    renderInsights(null);
    renderOverviewData(null, null);
    return;
  }

  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};
  const title = channel.title || "your linked channel";
  const summaryParts = [
    analyticsSummary.views !== undefined ? `${wholeNumber(analyticsSummary.views)} views` : "",
    analyticsSummary.estimatedMinutesWatched !== undefined ? `${watchHours(analyticsSummary.estimatedMinutesWatched)} watch hours` : "",
    analyticsSummary.subscribersGained !== undefined ? `${wholeNumber(analyticsSummary.subscribersGained)} subscribers gained` : ""
  ].filter(Boolean);

  const summary = summaryParts.length
    ? `Showing saved YouTube data for ${title}. Last 28 days: ${summaryParts.join(", ")}.`
    : `Showing saved YouTube channel data for ${title}.`;
  document.querySelectorAll("[data-youtube-summary]").forEach((element) => {
    element.textContent = summary;
  });
  renderInsights(connection);
  renderOverviewData(connection, overviewData);
}

async function loadYouTubeData(user, db, days = 30) {
  applyYouTubeData(readCachedConnection(), readCachedOverview(user));

  const snapshot = await getDoc(doc(db, "users", user.uid));
  const profile = snapshot.exists() ? snapshot.data() : {};
  const connection = savedConnectionFromProfile(profile);
  if (connection) saveCachedConnection(connection);
  const activeConnection = connection || readCachedConnection();
  applyYouTubeData(activeConnection, readCachedOverview(user));

  const accessToken = readCachedAccessToken(user);
  if (!activeConnection || !accessToken) return;

  try {
    const liveOverview = await fetchLiveOverview(accessToken, days);
    saveCachedOverview(user, liveOverview);
    applyYouTubeData(activeConnection, liveOverview);
  } catch (error) {
    console.warn("Could not refresh Overview with live YouTube data.", error);
  }
}

if (firebaseConfigured && document.querySelector("[data-youtube-field], [data-youtube-summary]")) {
  applyYouTubeData(readCachedConnection());
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    loadYouTubeData(user, db).catch((error) => {
      console.error("Could not load linked YouTube data.", error);
    });

    // Setup time range buttons
    document.querySelectorAll(".segmented button").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.classList.contains("active")) return;

        const range = button.textContent.trim();
        const daysMap = { "7D": 7, "30D": 30, "90D": 90 };
        const days = daysMap[range];

        if (!days) return;

        // Update UI
        button.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");

        // Refresh data
        loadYouTubeData(user, db, days).catch((error) => {
          console.error("Could not refresh data for range:", range, error);
        });
      });
    });
  });

  window.addEventListener("viewcast:youtube-connected", (event) => {
    saveCachedConnection(event.detail);
    applyYouTubeData(event.detail);
  });

  window.addEventListener("viewcast:youtube-unlinked", () => {
    saveCachedConnection(null);
    applyYouTubeData(null);
  });
}
