import {average, compactNumber, numberValue, shortText} from "../js/insights-format.js?v=1";
import {
  buildCrossoverTrendSuggestions, creatorContextLabel, importantWords,
  isEnglishTrendVideo, readableTrendQuery, trendAgeDays,
  trendMomentumScore
} from "../js/insights-model.js?v=9";

function videoEngagementRate(video) {
  const views = numberValue(video.statistics?.viewCount) || 0;
  if (!views) return 0;
  const likes = numberValue(video.statistics?.likeCount) || 0;
  const comments = numberValue(video.statistics?.commentCount) || 0;
  return ((likes + comments) / views) * 100;
}

function videosShareTrend(first, second) {
  if (first.trendQuery && first.trendQuery === second.trendQuery) return true;
  const firstWords = new Set(importantWords(first.snippet?.title || ""));
  const secondWords = new Set(importantWords(second.snippet?.title || ""));
  const shared = [...firstWords].filter((word) => secondWords.has(word)).length;
  return shared >= 2;
}

function buildTrendGroups(videos = []) {
  const recent = videos
    .filter((video) => (
      video?.id &&
      isEnglishTrendVideo(video) &&
      trendAgeDays(video) <= 180
    ))
    .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  const usedIds = new Set();
  const groups = [];

  recent.forEach((seed) => {
    if (groups.length >= 3 || usedIds.has(seed.id)) return;
    const matches = recent
      .filter((video) => !usedIds.has(video.id) && videosShareTrend(seed, video))
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a))
      .slice(0, 3);
    const groupVideos = matches.length ? matches : [seed];
    groupVideos.forEach((video) => usedIds.add(video.id));
    const averageViewsPerDay = Math.round(average(
      groupVideos.map((video) => (
        (numberValue(video.statistics?.viewCount) || 0) /
        Math.max(1, trendAgeDays(video))
      ))
    ) || 0);
    const engagementRate = average(
      groupVideos.map(videoEngagementRate)
    ) || 0;
    const searchMomentum = groupVideos.length >= 3
      ? "High search momentum"
      : groupVideos.length === 2
        ? "Rising search momentum"
        : "Early search signal";
    const queryTitle = readableTrendQuery(seed.trendQuery || "");
    groups.push({
      title: queryTitle || shortText(seed.snippet?.title || "YouTube trend", 80),
      videos: groupVideos,
      averageViewsPerDay,
      engagementRate,
      searchMomentum,
      score: averageViewsPerDay * (1 + engagementRate / 10) *
        (1 + (groupVideos.length - 1) * 0.2)
    });
  });

  return groups.sort((a, b) => b.score - a.score).slice(0, 3);
}

function trendGroupItems(groups, label) {
  return groups.map((group) => ({
    title: group.title,
    body: `${group.videoCount ? `${group.videoCount} recent videos across ${group.channelCount} channels · ` : ""}${compactNumber(group.averageViewsPerDay)} average views per day · ${group.engagementRate.toFixed(1)}% engagement · ${group.searchMomentum}. Metrics use videos published during the past 180 days.`,
    label,
    tone: "good"
  }));
}

function nicheFallbackItems(summary) {
  const contextLabel = creatorContextLabel(summary);
  return [
    {
      title: `${contextLabel}: instant update Shorts`,
      body: `Monitor 15–45 second Shorts that turn a fresh ${contextLabel} release, update, or announcement into one immediate takeaway.`,
      label: "Niche Shorts",
      tone: "warn"
    },
    {
      title: `${contextLabel}: rapid comparisons`,
      body: `Look for repeated A-versus-B, ranking, and “best option” Shorts that make the choice understandable without long-form setup.`,
      label: "Niche Shorts",
      tone: "warn"
    },
    {
      title: `${contextLabel}: loopable challenges and reactions`,
      body: `Track challenge, reaction, and transformation Shorts with an opening that naturally connects back to the ending and encourages a rewatch.`,
      label: "Niche Shorts",
      tone: "warn"
    }
  ];
}

export function renderTrendSections(summary, geminiInsights = null, renderActivityItems) {
  const nicheGroups = buildTrendGroups(summary.trendVideos || []);
  const nicheItems = nicheGroups.length
    ? trendGroupItems(nicheGroups, "Same-topic videos")
    : nicheFallbackItems(summary);
  const opportunities = geminiInsights?.crossoverTrends?.length
    ? geminiInsights.crossoverTrends
    : buildCrossoverTrendSuggestions(summary);
  const opportunityVideos = orderExpansionVideosByCrossover(
    summary.trendVideos || [],
    opportunities
  ).map((video) => [video]);
  const nicheTitle = document.getElementById("nicheTrendsTitle");
  if (nicheTitle) nicheTitle.textContent = `Trends for ${creatorContextLabel(summary)}`;
  renderActivityItems(
    "#nicheTrends .activity-item",
    nicheItems,
    nicheGroups.map((group) => group.videos)
  );
  renderActivityItems(
    "#trendOpportunities .activity-item",
    opportunities,
    opportunityVideos
  );
}

function orderExpansionVideosByCrossover(videos = [], items = []) {
  const ordered = [];
  items.forEach((item) => {
    const text = `${item?.title || ""} ${item?.body || ""}`.toLowerCase();
    const match = videos.find((video) => {
      const title = String(video.snippet?.title || "").trim().toLowerCase();
      return title && text.includes(title);
    });
    if (match && !ordered.some((video) => video.id === match.id)) {
      ordered.push(match);
    }
  });
  videos.forEach((video) => {
    if (!ordered.some((candidate) => candidate.id === video.id)) {
      ordered.push(video);
    }
  });
  return ordered.slice(0, 3);
}
