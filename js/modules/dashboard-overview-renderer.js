import {durationFromSeconds, escapeHtml, numberValue, wholeNumber} from "../insights-format.js?v=1";
import {formatDateLabel, watchHours} from "../services/dashboard-cache.js?v=1";

const emptyValue = "\u00a0";
const trafficSourceLabels = {"ADVERTISING":"Advertising","ANNOTATION":"Cards and annotations","CAMPAIGN_CARD":"Campaign cards","END_SCREEN":"End screens","EXT_URL":"External","HASHTAGS":"Hashtags","LIVE_REDIRECT":"Live redirect","NO_LINK_EMBEDDED":"Embedded","NO_LINK_OTHER":"Other YouTube","NOTIFICATION":"Notifications","PLAYLIST":"Playlists","PROMOTED":"Promoted","RELATED_VIDEO":"Suggested","SHORTS":"Shorts","SOUND_PAGE":"Sound page","SUBSCRIBER":"Subscriptions","YT_CHANNEL":"Channel pages","YT_OTHER_PAGE":"Other YouTube pages","YT_SEARCH":"Search"};

function insightItems(connection) {
  if (!connection) {
    return [
      { title: "Connect YouTube", body: "Link your channel from My Channel so ViewCast can generate recommendations.", label: "Setup" },
      { title: "No channel data yet", body: "AI Insights stays blank until verified YouTube data is available.", label: "Waiting" },
      { title: "Avoid fake metrics", body: "Recommendations are generated only from real YouTube channel data.", label: "Data" }
    ];
  }
  const analyticsSummary = connection.analyticsSummary || {};
  const views = numberValue(analyticsSummary.views);
  const watchMinutes = numberValue(analyticsSummary.estimatedMinutesWatched);
  const avgDuration = numberValue(analyticsSummary.averageViewDuration);
  const subscribersGained = numberValue(analyticsSummary.subscribersGained);
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
      body: avgDuration >= 180 ? "Average view duration is " + durationFromSeconds(avgDuration) + ", which can support deeper series." : "Average view duration is " + durationFromSeconds(avgDuration) + ". Use pattern breaks to keep viewers moving.",
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
  return items.slice(0, 3);
}

export function renderInsights(connection) {
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

export function setElementText(selector, value) {
  document.querySelectorAll(selector).forEach((element) => { element.textContent = value || emptyValue; });
}

export function setTrend(name, value, className = "good") {
  document.querySelectorAll(`[data-overview-trend="${name}"]`).forEach((element) => {
    element.textContent = value || emptyValue;
    element.className = ["trend", className].join(" ");
  });
}

function setHealthMetric(name, label) {
  document.querySelectorAll(`[data-overview-health="${name}"]`).forEach((item) => {
    const valueEl = item.querySelector("strong");
    if (valueEl) valueEl.textContent = label || emptyValue;
  });
}

export function summarizeDaily(dailyRows = []) {
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

export function renderSubscribersTrend(connection, overviewData) {
  if (!document.getElementById("subsChart") || typeof window.drawLineChart !== "function") return;
  const rows = overviewData?.daily || [];
  const buckets = recentMonthBuckets(6);
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  if (!rows.length) {
    window.drawLineChart("subsChart", [], [], [], {ySuffix: ""});
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

export function renderUploadFrequency(overviewData) {
  const container = document.querySelector("[data-channel-upload-frequency]");
  if (!container) return;
  const videos = overviewData?.videos || [];
  if (!videos.length) {
    container.innerHTML = '<p class="signal-empty">No upload history is available for this channel.</p>';
    return;
  }
  const buckets = recentWeekBuckets(4);
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  videos.forEach((video) => {
    const published = new Date(video.snippet?.publishedAt || "");
    if (Number.isNaN(published.getTime())) return;
    const bucket = bucketMap.get(weekKey(published));
    if (bucket) bucket.count += 1;
  });

  const rows = buckets;
  const max = Math.max(1, ...rows.map((row) => row.count));

  container.innerHTML = rows.map((row) => {
    const value = Math.round((row.count / max) * 100);
    const label = row.count === 1 ? "1 upload" : `${row.count} uploads`;
    return `<div class="region-row"><span>${escapeHtml(row.label)}</span><div class="bar"><i data-value="${value}"></i></div><b>${escapeHtml(label)}</b></div>`;
  }).join("");
}

export function renderViewsTrend(overviewData) {
  const rows = sampledSeries(overviewData?.daily || []);
  if (!document.getElementById("viewsChart") || typeof window.drawLineChart !== "function") return;
  if (!rows.length) { window.drawLineChart("viewsChart", [], [], []); return; }
  const actual = rows.map((row) => numberValue(row[1]) || 0);
  const labels = rows.map((row) => formatDateLabel(row[0]));
  const rowDates = rows.map((row) => new Date(`${row[0]}T12:00:00Z`).getTime());
  const minDate = rowDates[0];
  const maxDate = rowDates[rowDates.length - 1];
  const uploadsByIndex = new Map();
  (overviewData?.videos || []).forEach((video) => {
    const publishedAt = new Date(video.snippet?.publishedAt || "").getTime();
    if (!Number.isFinite(publishedAt) || publishedAt < minDate || publishedAt > maxDate + 86400000) return;
    let closestIndex = 0;
    rowDates.forEach((date, index) => {
      if (Math.abs(date - publishedAt) < Math.abs(rowDates[closestIndex] - publishedAt)) closestIndex = index;
    });
    const uploads = uploadsByIndex.get(closestIndex) || [];
    uploads.push({
      title: video.snippet?.title || "Untitled upload",
      thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || ""
    });
    uploadsByIndex.set(closestIndex, uploads);
  });
  const markers = [...uploadsByIndex].map(([index, uploads]) => ({index, uploads}));
  window.drawLineChart("viewsChart", actual, [], labels, {ySuffix: "", markers});
}

export function renderTrafficSources(overviewData) {
  const container = document.querySelector("[data-overview-traffic]");
  if (!container) return;
  const rows = overviewData?.traffic || [];
  const total = rows.reduce((sum, row) => sum + (numberValue(row[1]) || 0), 0);
  if (!rows.length || !total) {
    const failed = overviewData?.reportFailures?.traffic;
    container.innerHTML = `<p class="signal-empty">${escapeHtml(failed
      ? "Traffic sources could not be loaded. Reconnect YouTube if this continues."
      : "YouTube returned no reportable traffic-source data for this period.")}</p>`;
    return;
  }
  container.innerHTML = rows.map((row) => {
    const label = trafficSourceLabels[row[0]] || String(row[0] || "Other").replace(/_/g, " ");
    const shareValue = Math.max(0, Math.min(100, Math.round((numberValue(row[1]) || 0) / total * 100)));
    const share = `${shareValue}%`;
    return `<div class="region-row"><span>${escapeHtml(label)}</span><div class="bar"><i data-value="${shareValue}"></i></div><b>${share}</b></div>`;
  }).join("");
}

export function renderHealth(connection, overviewData) {
  if (!connection) { setHealthMetric("watch-hours", "Not connected"); setHealthMetric("avg-duration", "Not connected"); setHealthMetric("subscribers", "Not connected"); return; }
  const analyticsSummary = connection?.analyticsSummary || {};
  const dailySummary = summarizeDaily(overviewData?.daily || []);
  const watchMinutes = dailySummary.watchMinutes || numberValue(analyticsSummary.estimatedMinutesWatched) || 0;
  const avgDuration = dailySummary.durationCount ? dailySummary.durationTotal / dailySummary.durationCount : numberValue(analyticsSummary.averageViewDuration) || 0;
  const subscribers = dailySummary.subscribers || numberValue(analyticsSummary.subscribersGained) || 0;
  setHealthMetric("watch-hours", `${watchHours(watchMinutes)} hrs`);
  setHealthMetric("avg-duration", durationFromSeconds(avgDuration));
  setHealthMetric("subscribers", wholeNumber(subscribers));
}
