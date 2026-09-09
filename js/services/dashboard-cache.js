import {compactNumber, durationFromSeconds, numberValue, wholeNumber} from "../insights-format.js?v=1";

export const allConnectionsKey = "viewcastYouTubeAllConnections";
const connectionStorageKey = "viewcastYouTubeConnection";
const channelStorageKey = "viewcastYouTubeChannel";
const overviewStorageKeyPrefix = "viewcastOverviewData:";
const overviewCacheVersion = 3;

export function currency(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en", {
    style: "currency", currency: "USD", maximumFractionDigits: 2
  }).format(number);
}

export function watchHours(minutes) {
  const number = numberValue(minutes);
  return number === null ? "" : compactNumber(number / 60);
}

export function percent(value, total) {
  const number = numberValue(value);
  const denominator = numberValue(total);
  return number === null || !denominator ? "" : `${Math.round(number / denominator * 100)}%`;
}

export function formatDateLabel(value) {
  const raw = String(value || "");
  if (raw.length === 8) return `${raw.slice(4, 6)}/${raw.slice(6, 8)}`;
  if (raw.length >= 10) return `${raw.slice(5, 7)}/${raw.slice(8, 10)}`;
  return raw;
}

export function timeAgo(timestamp) {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return "Latest scan";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "Just scanned";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function overviewStorageKey(user, channelId = "guest") {
  return `${overviewStorageKeyPrefix}${user?.uid || "guest"}:${channelId}`;
}

export function hasUsableOverviewData(overview) {
  return Boolean(overview && (overview.daily?.length || overview.videos?.length || overview.videoAnalytics?.length));
}

export function readCachedOverview(user, channelId) {
  const key = overviewStorageKey(user, channelId);
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (saved?.cacheVersion === overviewCacheVersion) return saved;
    sessionStorage.removeItem(key);
  } catch (error) {
    sessionStorage.removeItem(key);
  }
  return null;
}

export function saveCachedOverview(user, channelId, data) {
  if (!data) return;
  sessionStorage.setItem(overviewStorageKey(user, channelId), JSON.stringify({
    ...data, cacheVersion: overviewCacheVersion, cachedAt: Date.now()
  }));
}

function normalizeConnection(value) {
  return value?.channel ? {channel: value.channel || {}, analyticsSummary: value.analyticsSummary || {}} : null;
}

export function readActiveConnection() {
  try {
    return normalizeConnection(JSON.parse(localStorage.getItem(connectionStorageKey) || "null"));
  } catch (error) {
    return null;
  }
}

export function saveCachedConnection(connection) {
  if (!connection) {
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(channelStorageKey);
    return;
  }
  localStorage.setItem(connectionStorageKey, JSON.stringify(connection));
  localStorage.setItem(channelStorageKey, JSON.stringify(connection.channel || {}));
}

export function connectionFieldValues(connection) {
  if (!connection) return {};
  const channel = connection.channel || {};
  const analytics = connection.analyticsSummary || {};
  return {
    "channel-title": channel.title || "",
    "total-views": compactNumber(channel.viewCount),
    "subscriber-count": compactNumber(channel.subscriberCount),
    "video-count": wholeNumber(channel.videoCount),
    "period-views": compactNumber(analytics.views),
    "watch-hours": watchHours(analytics.estimatedMinutesWatched),
    "average-view-duration": durationFromSeconds(analytics.averageViewDuration),
    "subscribers-gained": wholeNumber(analytics.subscribersGained),
    "estimated-revenue": currency(analytics.estimatedRevenue) || "Not available"
  };
}
