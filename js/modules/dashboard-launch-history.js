import {escapeHtml, median, numberValue, wholeNumber} from "../insights-format.js?v=1";
import {analyticsByVideo, decimal, setIntelligence, visibleDashboardVideos} from "./dashboard-video-intelligence.js?v=1";

const firstDayHistoryKeyPrefix = "viewcastFirstDayHistory:";
const metadataHistoryKeyPrefix = "viewcastVideoMetadataHistory:";
const metadataEventsKeyPrefix = "viewcastVideoMetadataEvents:";

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

export function renderFirstDayRanking(overviewData, connection, user) {
  const tbody = document.querySelector("[data-first-day-ranking]");
  if (!tbody) return;

  const now = Date.now();
  const channelId = connection?.channel?.id || "none";
  const historyKey = `${firstDayHistoryKeyPrefix}${user?.uid || "guest"}:${channelId}`;
  const history = readLocalJson(historyKey, {});
  const videos = visibleDashboardVideos(overviewData);
  const studioMetrics = analyticsByVideo(overviewData);

  videos.forEach((video) => {
    const publishedAt = new Date(video.snippet?.publishedAt || "").getTime();
    const ageHours = (now - publishedAt) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > 24) return;
    const previous = history[video.id];
    if (!previous || ageHours >= (numberValue(previous.ageHours) || 0)) {
      history[video.id] = {
        views: studioMetrics.get(String(video.id))?.views || 0,
        ageHours,
        title: video.snippet?.title || "Untitled",
        capturedAt: now
      };
    }
  });

  const trimmedHistory = Object.fromEntries(Object.entries(history)
    .sort((a, b) => Number(b[1]?.capturedAt || 0) - Number(a[1]?.capturedAt || 0))
    .slice(0, 50));
  if (channelId !== "none") localStorage.setItem(historyKey, JSON.stringify(trimmedHistory));

  const rankedVideos = videos.map((video) => {
    const id = String(video.id || "");
    const publishedAt = new Date(video.snippet?.publishedAt || "").getTime();
    const ageHours = Math.max(1, (now - publishedAt) / 3600000);
    const currentViews = studioMetrics.get(id)?.views || 0;
    const snapshot = trimmedHistory[id];
    const snapshotAge = numberValue(snapshot?.ageHours);
    const snapshotViews = numberValue(snapshot?.views);
    const isTracked = snapshotAge !== null && snapshotViews !== null &&
      snapshotAge >= 23 && snapshotAge <= 24;
    return {
      id,
      title: video.snippet?.title || snapshot?.title || "Untitled",
      firstDayViews: isTracked
        ? snapshotViews
        : Math.max(0, Math.round((currentViews / ageHours) * 24)),
      timing: isTracked ? launchAgeLabel(snapshotAge) : "24h estimate",
      status: isTracked ? "Tracked" : "Estimated",
      isTracked
    };
  })
    .filter((item) => item.id && Number.isFinite(item.firstDayViews))
    .sort((a, b) => b.firstDayViews - a.firstDayViews)
    .slice(0, 5);
  const typicalFirstDay = median(rankedVideos.map((item) => item.firstDayViews));

  if (!rankedVideos.length) {
    tbody.innerHTML = '<tr><td class="table-empty-state" colspan="6">No uploaded videos were found for this channel.</td></tr>';
    return;
  }

  tbody.innerHTML = rankedVideos.map((item, index) => {
    const delta = typicalFirstDay ? ((item.firstDayViews / typicalFirstDay) - 1) * 100 : null;
    const comparison = delta === null ? "Building baseline" : `${delta >= 0 ? "+" : ""}${decimal(delta, 0)}%`;
    return `
    <tr>
      <td><span class="launch-rank">${index + 1}</span></td>
      <td><a class="dashboard-video-link" href="pages/analyzer.html?video=${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a></td>
      <td><strong>${wholeNumber(item.firstDayViews)}</strong></td>
      <td>${item.timing}</td>
      <td><span class="trend ${delta === null || delta >= 0 ? "good" : "bad"}">${comparison}</span></td>
      <td><span class="comparison-badge ${item.isTracked ? "good" : "warn"}">${item.status}</span></td>
    </tr>
  `;
  }).join("");
}
export function trackVideoMetadata(overviewData, connection, user) {
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
