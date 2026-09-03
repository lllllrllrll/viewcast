const REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("YouTube Studio did not respond in time.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function apiDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return apiDate(date);
}

export async function fetchStudioReport(accessToken, options = {}) {
  if (!accessToken) throw new Error("YouTube Studio access is required.");
  const url = new URL(REPORTS_URL);
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", options.startDate || daysAgo(options.days || 28));
  url.searchParams.set("endDate", options.endDate || apiDate(new Date()));
  url.searchParams.set("metrics", options.metrics);
  ["dimensions", "filters", "sort", "maxResults", "startIndex"].forEach((key) => {
    if (options[key] !== undefined && options[key] !== "") {
      url.searchParams.set(key, String(options[key]));
    }
  });
  const response = await fetchWithTimeout(url, {headers: {Authorization: `Bearer ${accessToken}`}});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `YouTube Studio request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.error?.status || "YOUTUBE_STUDIO_ERROR";
    throw error;
  }
  return payload;
}

export async function fetchOwnedVideoMetrics(accessToken, {days = 90, maxResults = 200} = {}) {
  const reportOptions = {
    days,
    dimensions: "video",
    sort: "-views",
    maxResults
  };
  const performancePayload = await fetchStudioReport(accessToken, {
    ...reportOptions,
    metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage"
  });
  const engagementPayload = await fetchStudioReport(accessToken, {
    ...reportOptions,
    metrics: "views,subscribersGained,subscribersLost,likes,comments,shares"
  }).catch((error) => {
    console.warn("Optional YouTube Studio engagement metrics were unavailable.", error);
    return {rows: []};
  });
  const engagement = new Map((engagementPayload.rows || []).map((row) => [String(row[0]), {
    subscribersGained: Number(row[2]) || 0,
    subscribersLost: Number(row[3]) || 0,
    likes: Number(row[4]) || 0,
    comments: Number(row[5]) || 0,
    shares: Number(row[6]) || 0
  }]));
  return new Map((performancePayload.rows || []).map((row) => [String(row[0]), {
    periodDays: days,
    periodLabel: `${days}D`,
    source: "youtube-studio",
    views: Number(row[1]) || 0,
    estimatedMinutesWatched: Number(row[2]) || 0,
    averageViewDuration: Number(row[3]) || 0,
    averageViewPercentage: Number(row[4]) || 0,
    subscribersGained: engagement.get(String(row[0]))?.subscribersGained || 0,
    subscribersLost: engagement.get(String(row[0]))?.subscribersLost || 0,
    likes: engagement.get(String(row[0]))?.likes || 0,
    comments: engagement.get(String(row[0]))?.comments || 0,
    shares: engagement.get(String(row[0]))?.shares || 0
  }]));
}

export async function enrichOwnedVideosWithStudio(videos, accessToken, options = {}) {
  const metrics = await fetchOwnedVideoMetrics(accessToken, options);
  return videos.map((video) => ({
    ...video,
    ownerAnalytics: metrics.get(String(video.id)) || {
      periodDays: options.days || 90,
      periodLabel: `${options.days || 90}D`,
      source: "youtube-studio",
      views: 0,
      estimatedMinutesWatched: 0,
      averageViewDuration: 0,
      averageViewPercentage: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0
    },
    analyticsSource: "youtube-studio"
  }));
}

async function firstAvailableRange(accessToken, loader) {
  const ranges = [
    {startDate: daysAgo(28), endDate: apiDate(new Date()), periodLabel: "28D"},
    {startDate: "2005-02-14", endDate: apiDate(new Date()), periodLabel: "Lifetime"}
  ];
  for (const range of ranges) {
    const value = await loader(range);
    if (Array.isArray(value) ? value.length : value) return value;
  }
  return null;
}

export async function fetchOwnedVideoAnalysis(videoId, accessToken) {
  const analytics = await firstAvailableRange(accessToken, async (range) => {
    const payload = await fetchStudioReport(accessToken, {
      ...range,
      metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost",
      filters: `video==${videoId}`
    });
    const row = payload.rows?.[0];
    return row ? {
      periodLabel: range.periodLabel,
      source: "youtube-studio",
      views: Number(row[0]) || 0,
      estimatedMinutesWatched: Number(row[1]) || 0,
      averageViewDuration: Number(row[2]) || 0,
      averageViewPercentage: Number(row[3]) || 0,
      likes: Number(row[4]) || 0,
      comments: Number(row[5]) || 0,
      shares: Number(row[6]) || 0,
      subscribersGained: Number(row[7]) || 0,
      subscribersLost: Number(row[8]) || 0
    } : null;
  });
  const retentionPoints = await firstAvailableRange(accessToken, async (range) => {
    const payload = await fetchStudioReport(accessToken, {
      ...range,
      metrics: "audienceWatchRatio",
      dimensions: "elapsedVideoTimeRatio",
      filters: `video==${videoId}`
    });
    return (payload.rows || []).map(([position, ratio]) => ({
      position: Number(position), ratio: Number(ratio)
    })).filter((point) => Number.isFinite(point.position) && Number.isFinite(point.ratio));
  }) || [];
  const searchTerms = await firstAvailableRange(accessToken, async (range) => {
    const payload = await fetchStudioReport(accessToken, {
      ...range,
      metrics: "views",
      dimensions: "insightTrafficSourceDetail",
      filters: `video==${videoId};insightTrafficSourceType==YT_SEARCH`,
      sort: "-views",
      maxResults: 5
    });
    return (payload.rows || []).map(([term, views]) => ({
      term: term || "Unknown search term", views: Number(views) || 0,
      periodLabel: range.periodLabel
    }));
  }) || [];
  return {analytics, retentionPoints, searchTerms};
}
