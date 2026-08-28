import {average, compactNumber, numberValue, shortText, youtubeCategoryName} from "../js/insights-format.js?v=1";
import {
  buildCrossoverTrendSuggestions, creatorContextLabel, importantWords,
  isEnglishTrendVideo, isShortTrendVideo, readableTrendQuery, trendAgeDays,
  trendMomentumScore
} from "../js/insights-model.js?v=8";

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

const platformTrendNoiseWords = new Set([
  "episode", "season", "today", "watch", "every", "thing", "really",
  "could", "would", "should", "people", "world", "time", "years",
  "million", "hours", "minutes", "day", "week"
]);

function platformTrendTerms(video) {
  return [...new Set(importantWords(video.snippet?.title || "")
    .filter((word) => !platformTrendNoiseWords.has(word) && !/^\d+$/.test(word)))];
}

function titleCaseTrend(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function platformTrendLabel(terms, videos) {
  const categoryCounts = new Map();
  videos.forEach((video) => {
    const category = youtubeCategoryName(video.snippet?.categoryId);
    if (category) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  });
  const category = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const topic = titleCaseTrend(terms.join(" "));
  const categoryAddsContext = category &&
    !terms.some((term) => category.toLowerCase().includes(term));
  return categoryAddsContext && terms.length === 1
    ? `${topic} ${category} Shorts`
    : `${topic} Shorts`;
}

function buildPlatformTrendGroups(videos = []) {
  const recent = videos
    .filter((video, index, values) => (
      video?.id &&
      isShortTrendVideo(video) &&
      isEnglishTrendVideo(video) &&
      trendAgeDays(video) <= 30 &&
      values.findIndex((candidate) => candidate.id === video.id) === index
    ))
    .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  const candidates = new Map();

  recent.forEach((video) => {
    const terms = platformTrendTerms(video);
    const keys = [];
    for (let first = 0; first < terms.length; first += 1) {
      keys.push(terms[first]);
      for (let second = first + 1; second < terms.length; second += 1) {
        keys.push([terms[first], terms[second]].sort().join(" "));
      }
    }
    [...new Set(keys)].forEach((key) => {
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(video);
    });
  });

  const groups = [...candidates.entries()]
    .map(([key, matches]) => {
      const channelCount = new Set(matches.map((video) =>
        video.snippet?.channelId || video.snippet?.channelTitle
      ).filter(Boolean)).size;
      if (matches.length < 3 || channelCount < 3) return null;
      const groupVideos = [...matches]
        .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a))
        .slice(0, 5);
      const averageViewsPerDay = Math.round(average(groupVideos.map((video) =>
        (numberValue(video.statistics?.viewCount) || 0) /
        Math.max(1, trendAgeDays(video))
      )) || 0);
      const engagementRate = average(groupVideos.map(videoEngagementRate)) || 0;
      const terms = key.split(" ");
      return {
        key,
        title: platformTrendLabel(terms, groupVideos),
        videos: groupVideos,
        videoCount: matches.length,
        channelCount,
        averageViewsPerDay,
        engagementRate,
        searchMomentum: matches.length >= 4
          ? "Widespread creator adoption"
          : "Growing creator adoption",
        score: averageViewsPerDay * (1 + engagementRate / 10) *
          (1 + Math.min(matches.length, 8) * 0.18) *
          (terms.length === 2 ? 1.3 : 1)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  groups.forEach((group) => {
    if (selected.length >= 3) return;
    const groupIds = new Set(group.videos.map((video) => video.id));
    const overlaps = selected.some((existing) => {
      const sharedVideos = existing.videos.filter((video) => groupIds.has(video.id)).length;
      return sharedVideos / Math.min(existing.videos.length, group.videos.length) >= 0.6;
    });
    if (!overlaps) selected.push(group);
  });
  return selected;
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

function trendSectionFallbackItems(type, summary) {
  const contextLabel = creatorContextLabel(summary);
  if (type === "platform") {
    return [
      {
        title: "Fast-payoff challenge Shorts",
        body: "Look for repeatable challenges that reveal the result in the opening two seconds, establish one rule, and reach a visible payoff within 60 seconds.",
        label: "Shorts signal",
        tone: "warn"
      },
      {
        title: "Transformation and before-after Shorts",
        body: "Track fast visual transformations, progress reveals, and process edits repeated across multiple Shorts creators with strong completion and engagement signals.",
        label: "Shorts signal",
        tone: "warn"
      },
      {
        title: "Comment-driven reaction Shorts",
        body: "Watch concise reactions, rankings, and viewer-response formats that create a clear opinion and invite a specific comment or follow-up request.",
        label: "Shorts signal",
        tone: "warn"
      }
    ];
  }
  if (type === "niche") {
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
  return [
    {
      title: `Bring challenge storytelling into ${contextLabel}`,
      body: `Suggested Short: “I Tried My Hardest ${contextLabel} Goal With One Major Constraint.” Show the result in the first two seconds, state the rule immediately, and reach a measurable payoff in 20–45 seconds.`,
      label: "Shorts crossover",
      tone: "warn"
    },
    {
      title: `Use documentary-style transformation in ${contextLabel}`,
      body: `Suggested Short: “I Changed My ${contextLabel} Process—Here’s the Before and After.” Start with a split-screen comparison, show one setback, and finish on the same framing so the Short loops cleanly.`,
      label: "Shorts crossover",
      tone: "warn"
    },
    {
      title: `Add audience participation to ${contextLabel}`,
      body: `Suggested Short: “You Control My Next ${contextLabel} Project.” Put two choices on screen, ask for a one-word comment, and make the winning option the hook for the next Short.`,
      label: "Shorts crossover",
      tone: "warn"
    }
  ];
}

export function renderTrendSections(summary, geminiInsights = null, renderActivityItems) {
  const nicheGroups = buildTrendGroups(summary.trendVideos || []);
  const nicheItems = nicheGroups.length
    ? trendGroupItems(nicheGroups, "Same-topic videos")
    : trendSectionFallbackItems("niche", summary);
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
