import {durationFromIso, numberValue, shortText, youtubeCategoryName} from "../insights-format.js?v=1";
import {importantWords, isShort} from "../insights-model.js?v=8";

let savedChannelContext = {channelTopic: "", channelContext: ""};

export function setGeminiCreatorContext(value = {}) {
  savedChannelContext = {
    channelTopic: String(value.channelTopic || ""),
    channelContext: String(value.channelContext || "")
  };
}

export function geminiCreatorContext() {
  return savedChannelContext;
}

export function compactAdviceSummary(summary) {
  const trendTitle = summary.trendVideos[0]?.snippet?.title || "Similar trend signals unavailable";
  return `I classified this as ${summary.channelLane?.label || "a general creator channel"}. Start with ${summary.topicIdeas[0]?.title || "a direct follow-up"}, post long-form near ${summary.videoUploadTime}, test Shorts near ${summary.shortUploadTime}, aim for ${summary.nextVideoLength} on the next video and ${summary.nextShortLength} on the next Short. Trend reference: ${trendTitle}.`;
}

function channelVideoContext(videos) {
  return videos.slice(0, 40).map((video) => ({
    title: video.snippet?.title || "Untitled video",
    description: shortText(video.snippet?.description || "", 260),
    tags: (video.snippet?.tags || []).slice(0, 12),
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.ownerAnalytics?.views) || 0,
    likes: numberValue(video.ownerAnalytics?.likes) || 0,
    comments: numberValue(video.ownerAnalytics?.comments) || 0,
    shares: numberValue(video.ownerAnalytics?.shares) || 0,
    watchMinutes: numberValue(video.ownerAnalytics?.estimatedMinutesWatched) || 0,
    averageViewPercentage: numberValue(video.ownerAnalytics?.averageViewPercentage) || 0,
    subscribersGained: numberValue(video.ownerAnalytics?.subscribersGained) || 0,
    subscribersLost: numberValue(video.ownerAnalytics?.subscribersLost) || 0,
    analyticsSource: "youtube-studio",
    analyticsPeriod: video.ownerAnalytics?.periodLabel || "90D",
    duration: durationFromIso(video.contentDetails?.duration),
    format: isShort(video) ? "Short" : "Video",
    youtubeCategoryId: video.snippet?.categoryId || "",
    youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId)
  }));
}

export function channelScanContext(videos, profile = {}, {includeCatalog = true} = {}) {
  const uploads = Array.isArray(videos) ? videos : [];
  const sortedByViews = [...uploads].sort(
    (a, b) => numberValue(b.ownerAnalytics?.views) - numberValue(a.ownerAnalytics?.views)
  );
  const tagCounts = new Map();
  const categoryCounts = new Map();
  let shorts = 0;

  uploads.forEach((video) => {
    if (isShort(video)) shorts += 1;
    const category = youtubeCategoryName(video.snippet?.categoryId) || "Uncategorized";
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    (video.snippet?.tags || []).forEach((tag) => {
      const normalized = String(tag || "").trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      const existing = tagCounts.get(key) || {label: normalized, count: 0};
      existing.count += 1;
      tagCounts.set(key, existing);
    });
  });

  const compactUpload = (video) => ({
    title: video.snippet?.title || "Untitled video",
    description: shortText(video.snippet?.description || "", 220),
    tags: (video.snippet?.tags || []).slice(0, 10),
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.ownerAnalytics?.views) || 0,
    likes: numberValue(video.ownerAnalytics?.likes) || 0,
    comments: numberValue(video.ownerAnalytics?.comments) || 0,
    averageViewPercentage: numberValue(video.ownerAnalytics?.averageViewPercentage) || 0,
    analyticsPeriod: video.ownerAnalytics?.periodLabel || "90D",
    duration: durationFromIso(video.contentDetails?.duration),
    format: isShort(video) ? "Short" : "Video"
  });

  return {
    scanAvailable: uploads.length > 0,
    channel: compactChannelProfile(profile),
    uploadsScanned: uploads.length,
    totalChannelVideos: numberValue(profile.videoCount) || uploads.length,
    scanCoveragePercent: profile.videoCount
      ? Math.min(100, Math.round((uploads.length / numberValue(profile.videoCount)) * 100))
      : 100,
    formatMix: {shorts, longForm: Math.max(0, uploads.length - shorts)},
    categories: [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({name, count})),
    recurringTags: [...tagCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    inferredNicheTerms: inferChannelNicheTerms(uploads, profile),
    uploadCatalog: includeCatalog ? uploads.slice(0, 200).map((video) => ({
      title: video.snippet?.title || "Untitled video",
      tags: (video.snippet?.tags || []).slice(0, 4),
      category: youtubeCategoryName(video.snippet?.categoryId),
      format: isShort(video) ? "Short" : "Video",
      publishedAt: video.snippet?.publishedAt || "",
      views: numberValue(video.ownerAnalytics?.views) || 0,
      analyticsPeriod: video.ownerAnalytics?.periodLabel || "90D"
    })) : [],
    recentUploads: uploads.slice(0, 24).map(compactUpload),
    topPerformers: sortedByViews.slice(0, 10).map(compactUpload)
  };
}

export function compactChannelProfile(profile = {}) {
  return {
    title: profile.title || profile.snippet?.title || "",
    description: shortText(profile.description || profile.snippet?.description || "", 180),
    subscriberCount: profile.subscriberCount || profile.statistics?.subscriberCount || "",
    videoCount: profile.videoCount || profile.statistics?.videoCount || ""
  };
}

export function inferChannelNicheTerms(videos, profile = {}) {
  const scores = new Map();
  const generic = new Set([
    "gaming", "games", "gameplay", "video", "videos", "short", "shorts",
    "youtube", "viral", "trending", "funny", "official", "channel"
  ]);
  const add = (value, weight) => importantWords(value).forEach((word) => {
    if (!generic.has(word)) scores.set(word, (scores.get(word) || 0) + weight);
  });
  add(profile.keywords || "", 5);
  add(profile.description || "", 3);
  videos.slice(0, 30).forEach((video, index) => {
    const performanceWeight = index < 8 ? 3 : 1;
    add(video.snippet?.title || "", performanceWeight);
    (video.snippet?.tags || []).slice(0, 12).forEach(
      (tag) => add(tag, performanceWeight + 2)
    );
  });
  return [...scores.entries()]
    .filter(([, score]) => score >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 10);
}

