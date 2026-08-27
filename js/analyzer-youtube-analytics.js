function apiDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return apiDate(date);
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`}
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `YouTube request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function firstAvailableRange(ranges, loader) {
  try {
    for (const range of ranges) {
      const result = await loader(range);
      if (Array.isArray(result) ? result.length : result) return result;
    }
    return null;
  } catch (error) {
    throw error;
  }
}

function analyticsRanges() {
  const endDate = apiDate(new Date());
  return [
    {startDate: daysAgo(28), endDate, label: "28D"},
    {startDate: "2005-02-14", endDate, label: "Lifetime"}
  ];
}

export async function fetchVideoAnalytics(videoId, accessToken) {
  return firstAvailableRange(analyticsRanges(), async ({startDate, endDate, label}) => {
    const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("endDate", endDate);
    url.searchParams.set("metrics", "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage");
    url.searchParams.set("filters", `video==${videoId}`);
    const row = (await fetchJson(url, accessToken)).rows?.[0];
    return row ? {
      periodLabel: label,
      views: row[0],
      estimatedMinutesWatched: row[1],
      averageViewDuration: row[2],
      averageViewPercentage: row[3]
    } : null;
  });
}

export async function fetchRetentionCurve(videoId, accessToken) {
  const result = await firstAvailableRange(analyticsRanges(), async ({startDate, endDate}) => {
    const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("endDate", endDate);
    url.searchParams.set("metrics", "audienceWatchRatio");
    url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
    url.searchParams.set("filters", `video==${videoId}`);
    return ((await fetchJson(url, accessToken)).rows || []).map(([position, ratio]) => ({
      position: Number(position), ratio: Number(ratio)
    })).filter((point) => Number.isFinite(point.position) && Number.isFinite(point.ratio));
  });
  return result || [];
}

export async function fetchSearchTerms(videoId, accessToken) {
  const result = await firstAvailableRange(analyticsRanges(), async ({startDate, endDate, label}) => {
    const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("endDate", endDate);
    url.searchParams.set("metrics", "views");
    url.searchParams.set("dimensions", "insightTrafficSourceDetail");
    url.searchParams.set("filters", `video==${videoId};insightTrafficSourceType==YT_SEARCH`);
    url.searchParams.set("sort", "-views");
    url.searchParams.set("maxResults", "3");
    return ((await fetchJson(url, accessToken)).rows || []).map(([term, views]) => ({
      term: term || "Unknown search term", views: Number(views) || 0, periodLabel: label
    }));
  });
  return result || [];
}
