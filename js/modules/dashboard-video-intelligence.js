import {compactNumber, escapeHtml, median, numberValue, secondsFromIso, wholeNumber} from "../insights-format.js?v=1";
import {currency, percent, timeAgo} from "../services/dashboard-cache.js?v=1";

function videoFormat(video) {
  const seconds = secondsFromIso(video.contentDetails?.duration || "");
  if (seconds && seconds <= 60) return "Short";
  if (seconds && seconds >= 1200) return "Long-form";
  return "Video";
}

function dashboardFormatFilter() {
  return String(window.viewcastDashboardFormat || "all");
}

export function visibleDashboardVideos(overviewData) {
  const filter = dashboardFormatFilter();
  const videos = overviewData?.videos || [];
  return filter === "all" ? videos : videos.filter((video) => videoFormat(video) === filter);
}

export function decimal(value, digits = 1) {
  const number = numberValue(value);
  if (number === null) return "—";
  return new Intl.NumberFormat("en", {maximumFractionDigits: digits, minimumFractionDigits: digits}).format(number);
}

export function analyticsByVideo(overviewData) {
  const revenue = new Map((overviewData?.videoRevenue || []).map((row) => [String(row[0]), numberValue(row[1])]));
  return new Map((overviewData?.videoAnalytics || []).map((row) => [String(row[0]), {
    views: numberValue(row[1]) || 0,
    watchMinutes: numberValue(row[2]) || 0,
    averageViewDuration: numberValue(row[3]),
    averageViewPercentage: numberValue(row[4]),
    subscribersGained: numberValue(row[5]),
    likes: numberValue(row[6]),
    comments: numberValue(row[7]),
    shares: numberValue(row[8]),
    revenue: revenue.get(String(row[0])) ?? null
  }]));
}

export function renderVideoTable(overviewData) {
  const tbody = document.querySelector("[data-overview-videos]");
  if (!tbody) return;
  const metrics = analyticsByVideo(overviewData);
  const videos = [...visibleDashboardVideos(overviewData)]
    .filter((video) => metrics.has(String(video.id)))
    .sort((a, b) => metrics.get(String(b.id)).views - metrics.get(String(a.id)).views)
    .slice(0, 4);
  if (!videos.length) {
    const message = overviewData?.reportFailures?.videoAnalytics
      ? "Video analytics could not be loaded. Reconnect YouTube and try again."
      : overviewData
      ? "No videos with reportable activity were returned for this period."
      : "Waiting for private YouTube Studio analytics to sync.";
    tbody.innerHTML = `<tr><td class="table-empty-state" colspan="7">${message}</td></tr>`;
    return;
  }
  tbody.innerHTML = videos.map((video) => {
    const item = metrics.get(String(video.id));
    const hasEngagement = [item.likes, item.comments, item.shares].some((value) => value !== null);
    const engagement = (item.likes || 0) + (item.comments || 0) + (item.shares || 0);
    const perThousand = item.views ? 1000 / item.views : 0;
    const rpm = item.revenue !== null && item.views ? item.revenue * perThousand : null;
    return `<tr><td><a class="dashboard-video-link" href="pages/analyzer.html?video=${encodeURIComponent(video.id)}">${escapeHtml(video.snippet?.title || "Untitled")}</a><small class="table-secondary">${videoFormat(video)}</small></td><td>${wholeNumber(item.views)}</td><td>${item.averageViewPercentage !== null ? `${decimal(item.averageViewPercentage)}%` : "—"}</td><td>${decimal(item.watchMinutes / 60)}</td><td>${item.subscribersGained !== null ? decimal(item.subscribersGained * perThousand, 2) : "—"}</td><td>${hasEngagement ? decimal(engagement * perThousand) : "—"}</td><td>${rpm !== null ? currency(rpm) : "—"}</td></tr>`;
  }).join("");
}

export function setIntelligence(key, value) {
  document.querySelectorAll(`[data-intelligence="${key}"]`).forEach((element) => { element.textContent = value || "—"; });
}

function renderSignalList(key, rows, labeler = (value) => value, failure = null) {
  const container = document.querySelector(`[data-discovery="${key}"]`);
  if (!container) return;
  const limit = key === "search" ? 10 : 5;
  const cleanRows = (rows || []).filter((row) => row?.length >= 2 && numberValue(row[1]) !== null).slice(0, limit);
  const total = cleanRows.reduce((sum, row) => sum + (numberValue(row[1]) || 0), 0);
  if (!cleanRows.length) {
    container.innerHTML = `<p class="signal-empty">${escapeHtml(failure
      ? "This YouTube report could not be loaded. Reconnect the channel if this continues."
      : "YouTube returned no reportable data for this channel or period.")}</p>`;
    return;
  }
  container.innerHTML = cleanRows.map((row) => `<div><span>${escapeHtml(labeler(row[0]))}</span><b>${wholeNumber(row[1])}${total ? ` <small>${percent(row[1], total)}</small>` : ""}</b></div>`).join("");
}

export function renderFormatBenchmarks(overviewData) {
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

export function renderGrowthIntelligence(connection, overviewData) {
  const metrics = [...analyticsByVideo(overviewData).values()];
  const totals = metrics.reduce((sum, item) => ({
    views: sum.views + item.views,
    watchMinutes: sum.watchMinutes + item.watchMinutes,
    subscribers: sum.subscribers + (item.subscribersGained || 0),
    engagements: sum.engagements + (item.likes || 0) + (item.comments || 0) + (item.shares || 0),
    hasSubscriberData: sum.hasSubscriberData || item.subscribersGained !== null,
    hasEngagementData: sum.hasEngagementData || [item.likes, item.comments, item.shares].some((value) => value !== null),
    weightedRetention: sum.weightedRetention + ((item.averageViewPercentage || 0) * item.views),
    revenue: sum.revenue + (item.revenue || 0),
    hasRevenue: sum.hasRevenue || item.revenue !== null
  }), {views: 0, watchMinutes: 0, subscribers: 0, engagements: 0, hasSubscriberData: false, hasEngagementData: false, weightedRetention: 0, revenue: 0, hasRevenue: false});

  const perThousand = totals.views ? 1000 / totals.views : 0;
  setIntelligence("typical-video", metrics.length ? `${wholeNumber(median(metrics.map((item) => item.views)))} views` : "—");
  setIntelligence("retention", totals.views ? `${decimal(totals.weightedRetention / totals.views)}%` : "—");
  setIntelligence("subscriber-conversion", totals.views && totals.hasSubscriberData ? decimal(totals.subscribers * perThousand, 2) : "—");
  setIntelligence("engagement-rate", totals.views && totals.hasEngagementData ? decimal(totals.engagements * perThousand) : "—");
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

  const lifetimeViews = numberValue(overviewData?.lifetimeViews) ?? numberValue(connection?.channel?.viewCount);
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
  const failures = overviewData?.reportFailures || {};
  renderSignalList("countries", overviewData?.countries, (code) => countryNames?.of(String(code)) || String(code), failures.countries);
  renderSignalList("devices", overviewData?.devices, (value) => String(value).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()), failures.devices);
  renderSignalList("subscriptions", overviewData?.subscriptionStatus, (value) => value === "SUBSCRIBED" ? "Subscribed viewers" : "Not subscribed", failures.subscriptionStatus);
  renderSignalList("search", overviewData?.searchTerms, (value) => value, failures.searchTerms);
  const titleById = new Map((overviewData?.videos || []).map((video) => [String(video.id), video.snippet?.title || video.id]));
  renderSignalList("suggested", overviewData?.suggestedVideos, (id) => titleById.get(String(id)) || `Video ${id}`, failures.suggestedVideos);
  renderFormatBenchmarks(overviewData);
}
