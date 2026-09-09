import {shortText} from "../insights-format.js?v=1";
import {importantWords} from "./insights-topic-language.js?v=1";
import {trendAgeDays, trendMomentumScore} from "./insights-performance.js?v=1";
import {getCreatorContext} from "../services/insights-creator-context.js?v=1";

export function meaningfulCreatorContextWords() {
  const genericContextWords = new Set([
    "channel", "creator", "content", "youtube", "uploads", "audience",
    "topic", "niche", "page", "account"
  ]);
  return importantWords(
    `${getCreatorContext().channelTopic} ${getCreatorContext().channelContext}`
  ).filter((word) => !genericContextWords.has(word));
}

export function trendMatchesCreatorContext(video) {
  const contextWords = meaningfulCreatorContextWords();
  if (!contextWords.length) return true;

  const snippet = video.snippet || {};
  const candidateWords = new Set(importantWords([
    snippet.title || "",
    shortText(snippet.description || "", 240),
    ...(snippet.tags || []).slice(0, 8)
  ].join(" ")));
  const matches = contextWords.filter((word) => candidateWords.has(word)).length;
  const requiredMatches = contextWords.length >= 4 ? 2 : 1;
  return matches >= requiredMatches;
}

export function trendMatchesNichePlan(video, trendPlan) {
  if (!trendPlan) return true;
  const snippet = video.snippet || {};
  const candidateWords = new Set(importantWords([
    snippet.title || "",
    shortText(snippet.description || "", 320),
    ...(snippet.tags || []).slice(0, 12)
  ].join(" ")));
  const nicheWords = importantWords([
    ...(trendPlan.nicheTerms || []),
    trendPlan.lane?.specificCategory || "",
    ...(trendPlan.contentInterpretations || []).flatMap(
      (item) => item.mediaReferences || []
    )
  ].join(" ")).filter((word) => ![
    "general", "gaming", "games", "videos", "shorts", "content"
  ].includes(word));
  if (!nicheWords.length) return true;
  const uniqueNicheWords = [...new Set(nicheWords)];
  const matches = uniqueNicheWords.filter((word) => candidateWords.has(word));
  return matches.length >= (uniqueNicheWords.length >= 6 ? 2 : 1);
}

export function outsideContextBridgeMultiplier(video) {
  const context = meaningfulCreatorContextWords();
  if (!context.length) return 1;
  const categoryId = String(video.snippet?.categoryId || "");
  const affinities = {
    "1": ["story", "animation", "film", "character", "visual"],
    "10": ["meme", "edit", "reaction", "culture", "artist", "audio"],
    "17": ["reaction", "competition", "challenge", "commentary", "debate"],
    "20": ["meme", "challenge", "reaction", "character", "story", "community"],
    "23": ["meme", "funny", "reaction", "commentary", "entertainment"],
    "24": ["meme", "reaction", "story", "culture", "character", "commentary"],
    "27": ["analysis", "guide", "history", "explain", "education", "tutorial"],
    "28": ["analysis", "tool", "review", "experiment", "technology", "tutorial"]
  };
  const bridgeWords = affinities[categoryId] || [];
  const matches = context.filter((word) => bridgeWords.includes(word)).length;
  return 1 + Math.min(0.6, matches * 0.2);
}

export function outsideTrendRank(video) {
  return trendMomentumScore(video) * outsideContextBridgeMultiplier(video);
}

export function trendTitlesOverlap(first, second) {
  const firstWords = new Set(importantWords(first?.snippet?.title || ""));
  const secondWords = new Set(importantWords(second?.snippet?.title || ""));
  if (!firstWords.size || !secondWords.size) return false;
  const shared = [...firstWords].filter((word) => secondWords.has(word)).length;
  return shared / Math.min(firstWords.size, secondWords.size) >= 0.6;
}

export function diversifyTrendVideos(videos, queries = []) {
  const selected = [];
  const selectedIds = new Set();
  const addIfDistinct = (video) => {
    if (!video || selectedIds.has(video.id) || selected.some((item) => trendTitlesOverlap(item, video))) return false;
    selected.push(video);
    selectedIds.add(video.id);
    return true;
  };

  queries.forEach((query) => {
    const candidates = videos
      .filter((video) => video.trendQuery === query)
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
    candidates.some(addIfDistinct);
  });

  videos.forEach(addIfDistinct);

  // Variety should not reduce the useful evidence below three examples.
  videos.forEach((video) => {
    if (selected.length >= 3 || selectedIds.has(video.id)) return;
    selected.push(video);
    selectedIds.add(video.id);
  });
  return selected.slice(0, 3);
}

export function selectOutsideTopicTrends(
  videos,
  ownVideoIds = new Set(),
  ownCategoryIds = new Set(),
  preferredCategoryIds = []
) {
  const selected = [];
  const selectedCategories = new Set();
  const hasCreatorContext = meaningfulCreatorContextWords().length > 0;
  const contextualRank = (video) => {
    const categoryId = String(video.snippet?.categoryId || "");
    const preferredIndex = preferredCategoryIds.indexOf(categoryId);
    const preferenceBoost = preferredIndex < 0
      ? 1
      : 1.5 - Math.min(0.4, preferredIndex * 0.1);
    return outsideTrendRank(video) * preferenceBoost;
  };

  const candidates = videos
    .filter((video) => video?.id && !ownVideoIds.has(video.id))
    .filter((video) => !hasCreatorContext || !trendMatchesCreatorContext(video))
    .sort((a, b) => contextualRank(b) - contextualRank(a));

  candidates.forEach((video) => {
    if (selected.length >= 3) return;
    const categoryId = String(video.snippet?.categoryId || "");
    if (selectedCategories.has(categoryId)) return;
    if (selected.some((item) => trendTitlesOverlap(item, video))) return;
    selected.push(video);
    if (categoryId) selectedCategories.add(categoryId);
  });

  candidates.forEach((video) => {
    if (selected.length >= 3 || selected.some((item) => item.id === video.id || trendTitlesOverlap(item, video))) return;
    selected.push(video);
  });

  videos
    .filter((video) => {
      const categoryId = String(video?.snippet?.categoryId || "");
      return video?.id &&
        !ownVideoIds.has(video.id) &&
        categoryId &&
        !ownCategoryIds.has(categoryId);
    })
    .sort((a, b) => contextualRank(b) - contextualRank(a))
    .forEach((video) => {
      if (selected.length >= 3 ||
          selected.some((item) => item.id === video.id ||
            trendTitlesOverlap(item, video))) return;
      selected.push(video);
    });

  videos
    .filter((video) => video?.id && !ownVideoIds.has(video.id))
    .sort((a, b) => contextualRank(b) - contextualRank(a))
    .forEach((video) => {
      if (selected.length >= 3 ||
          selected.some((item) => item.id === video.id ||
            trendTitlesOverlap(item, video))) return;
      selected.push(video);
    });

  return selected;
}

export function selectGlobalPopularTrends(videos = []) {
  const candidates = videos
    .filter((video, index, values) => (
      video?.id &&
      trendAgeDays(video) <= 30 &&
      values.findIndex((candidate) => candidate.id === video.id) === index
    ))
    .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  // Keep a broad sample so platform trends can be proven by repeated uploads
  // instead of mistaking the first high-performing video for a trend.
  return candidates.slice(0, 80);
}
