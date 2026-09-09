import {average, dateLabel, durationFromIso, durationFromSeconds, median, numberValue, secondsFromIso, youtubeCategoryName} from "../insights-format.js?v=1";

export function videoScore(video) {
  const isOwnedUpload = video.analyticsSource === "youtube-studio";
  const isExternalReference = Boolean(video.trendSource);
  if (!isOwnedUpload && !isExternalReference) return 0;
  const stats = isOwnedUpload ? video.ownerAnalytics : video.statistics;
  const views = numberValue(isOwnedUpload ? stats?.views : stats?.viewCount) || 0;
  const likes = numberValue(isOwnedUpload ? stats?.likes : stats?.likeCount) || 0;
  const comments = numberValue(isOwnedUpload ? stats?.comments : stats?.commentCount) || 0;
  return views + likes * 20 + comments * 40;
}

export function trendAgeDays(video) {
  const publishedAt = new Date(video.snippet?.publishedAt || "").getTime();
  if (!Number.isFinite(publishedAt)) return 999;
  return Math.max(1, (Date.now() - publishedAt) / (24 * 60 * 60 * 1000));
}

export function trendMomentumScore(video) {
  const views = numberValue(video.statistics?.viewCount) || 0;
  const likes = numberValue(video.statistics?.likeCount) || 0;
  const comments = numberValue(video.statistics?.commentCount) || 0;
  const ageDays = trendAgeDays(video);
  const dailyViews = views / ageDays;
  const engagementRate = views ? (likes + comments * 2) / views : 0;
  const nicheBoost = /niche YouTube trend search$/.test(video.trendSource || "") ? 1.35 : 1;
  return dailyViews * (1 + Math.min(engagementRate * 20, 1.5)) * nicheBoost;
}

export function trendEvidence(video) {
  if (!video) return null;
  const views = numberValue(video.statistics?.viewCount) || 0;
  const ageDays = Math.ceil(trendAgeDays(video));
  const publishedAt = video.snippet?.publishedAt || "";
  return {
    title: video.snippet?.title || "",
    publishedAt,
    publishedLabel: publishedAt ? dateLabel(publishedAt) : "",
    ageDays,
    views,
    viewsPerDay: Math.round(views / Math.max(1, ageDays)),
    query: video.trendQuery || "",
    source: video.trendSource || "External YouTube trend"
  };
}

export function isShort(video) {
  const seconds = secondsFromIso(video.contentDetails?.duration);
  return seconds !== null && seconds <= 75;
}

export function uploadPerformanceContext(videos) {
  const mapped = videos.map((video) => ({
    title: video.snippet?.title || "Untitled video",
    publishedAt: video.snippet?.publishedAt || "",
    format: isShort(video) ? "Short" : "Video",
    duration: durationFromIso(video.contentDetails?.duration),
    views: numberValue(video.ownerAnalytics?.views) || 0,
    likes: numberValue(video.ownerAnalytics?.likes) || 0,
    comments: numberValue(video.ownerAnalytics?.comments) || 0,
    shares: numberValue(video.ownerAnalytics?.shares) || 0,
    watchMinutes: numberValue(video.ownerAnalytics?.estimatedMinutesWatched) || 0,
    averageViewPercentage: numberValue(video.ownerAnalytics?.averageViewPercentage) || 0,
    subscribersGained: numberValue(video.ownerAnalytics?.subscribersGained) || 0,
    subscribersLost: numberValue(video.ownerAnalytics?.subscribersLost) || 0,
    analyticsPeriod: video.ownerAnalytics?.periodLabel || "90D",
    youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId)
  }));
  const views = mapped.map((video) => video.views).filter(Number.isFinite);
  const shorts = mapped.filter((video) => video.format === "Short");
  const longVideos = mapped.filter((video) => video.format !== "Short");
  const averageViewsFor = (items) => Math.round(average(items.map((video) => video.views)) || 0);
  return {
    uploadCount: mapped.length,
    averageViews: Math.round(average(views) || 0),
    medianViews: Math.round(median(views) || 0),
    shortAverageViews: averageViewsFor(shorts),
    videoAverageViews: averageViewsFor(longVideos),
    topPerformers: [...mapped].sort((a, b) => b.views - a.views).slice(0, 3),
    underPerformers: [...mapped].sort((a, b) => a.views - b.views).slice(0, 2),
    recentUploads: mapped.slice(0, 4)
  };
}

export function isShortTrendVideo(video) {
  const seconds = secondsFromIso(video.contentDetails?.duration);
  return seconds !== null && seconds <= 180;
}

export function isEnglishTrendVideo(video) {
  const declaredLanguage = String(
    video.snippet?.defaultAudioLanguage ||
    video.snippet?.defaultLanguage ||
    ""
  ).trim().toLowerCase();
  if (declaredLanguage && !declaredLanguage.startsWith("en")) return false;

  const text = `${video.snippet?.title || ""} ${video.snippet?.description || ""}`
    .replace(/https?:\/\/\S+/gi, " ")
    .slice(0, 600);
  const letters = text.match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const latinLetters = text.match(/\p{Script=Latin}/gu) || [];
  return latinLetters.length / letters.length >= 0.9;
}

export function topVideos(videos, count = 8) {
  return [...videos].sort((a, b) => videoScore(b) - videoScore(a)).slice(0, count);
}

export function formatStandardTime(hour) {
  const normalizedHour = ((hour % 24) + 24) % 24;
  const suffix = normalizedHour >= 12 ? "PM" : "AM";
  const displayHour = normalizedHour % 12 || 12;
  return `${displayHour} ${suffix}`;
}

export function bestUploadSlot(videos, format = "all") {
  const pool = topVideos(videos.filter((video) => {
    if (format === "short") return isShort(video);
    if (format === "video") return !isShort(video);
    return true;
  }), 10);
  const fallbackPool = pool.length ? pool : topVideos(videos, 10);
  const buckets = new Map();
  fallbackPool.forEach((video) => {
    const date = new Date(video.snippet?.publishedAt || "");
    if (Number.isNaN(date.getTime())) return;
    const day = new Intl.DateTimeFormat("en", {weekday: "short"}).format(date);
    const hour = date.getHours();
    const slotHour = Math.round(hour / 3) * 3;
    const key = `${day} ${formatStandardTime(slotHour)}`;
    buckets.set(key, (buckets.get(key) || 0) + videoScore(video));
  });

  const best = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best || "After your next upload";
}

export function recommendedLength(videos, format) {
  const pool = topVideos(videos.filter((video) => format === "short" ? isShort(video) : !isShort(video)), 8);
  const seconds = median(pool.map((video) => secondsFromIso(video.contentDetails?.duration)).filter((value) => value !== null));
  if (!seconds && format === "short") return "30-45 sec";
  if (!seconds) return "6-9 min";
  if (format === "short") {
    const low = Math.max(15, Math.round((seconds - 8) / 5) * 5);
    const high = Math.min(75, Math.round((seconds + 8) / 5) * 5);
    return `${low}-${high} sec`;
  }
  const low = Math.max(60, Math.round((seconds * 0.85) / 30) * 30);
  const high = Math.round((seconds * 1.15) / 30) * 30;
  return `${durationFromSeconds(low)}-${durationFromSeconds(high)}`;
}
