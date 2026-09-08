import {compactAdviceSummary} from "../insights-gemini.js?v=5";
import {
  buildCrossoverTrendSuggestions,
  isGroundedTrendLabel,
  normalizedTitleWords
} from "../insights-model.js?v=9";

function normalizeRecommendation(item = {}, fallback = {}) {
  return {
    title: String(item.title || fallback.title || "Make a direct follow-up").slice(0, 160),
    body: String(item.body || fallback.body || "Use your strongest topic and connect it to a timely viewer problem.").slice(0, 900),
    label: String(item.label || fallback.label || "Gemini").slice(0, 36),
    tone: ["good", "warn", "bad"].includes(item.tone) ? item.tone : (fallback.tone || "good")
  };
}

function isGenericSuggestionTitle(value = "") {
  return /\b(follow[\s-]?up|part\s*2|extend|post more|make another|do another|continue)\b/i.test(String(value || ""));
}

function normalizeConceptSuggestion(item = {}, fallback = {}) {
  const normalized = normalizeRecommendation(item, fallback);
  if (isGenericSuggestionTitle(normalized.title)) {
    return normalizeRecommendation(fallback, {
      title: "Turn a current trend into a new concept",
      body: normalized.body,
      label: normalized.label,
      tone: normalized.tone
    });
  }
  return normalized;
}

function filledInsightItems(items, fallbacks, normalizer) {
  const normalizedItems = Array.isArray(items)
    ? items.slice(0, 3).map((item, index) => normalizer(item, fallbacks[index]))
    : [];
  const seen = new Set(normalizedItems.map((item) => item.title.toLowerCase()));

  fallbacks.slice(0, 3).forEach((fallback) => {
    if (normalizedItems.length >= 3) return;
    const normalizedFallback = normalizer(fallback, fallback);
    const key = normalizedFallback.title.toLowerCase();
    if (seen.has(key)) return;
    normalizedItems.push(normalizedFallback);
    seen.add(key);
  });

  while (normalizedItems.length < 3) {
    normalizedItems.push(normalizer({}, {
      title: "Turn the strongest pattern into a clearer next step",
      body: "Use your highest-performing recent upload as the packaging reference, then make the next idea more specific, timely, and easy to understand in the first few seconds.",
      label: "Action",
      tone: "good"
    }));
  }

  return normalizedItems.slice(0, 3);
}

function normalizeCrossoverTrends(items, summary) {
  const trendTitles = (summary.trendVideos || [])
    .map((video) => String(video.snippet?.title || "").trim())
    .filter(Boolean);
  const fallbacks = buildCrossoverTrendSuggestions(summary);
  const normalized = (Array.isArray(items) ? items : [])
    .filter((item) => {
      const text = `${item?.title || ""} ${item?.body || ""}`.toLowerCase();
      return trendTitles.some((title) => text.includes(title.toLowerCase()));
    })
    .map((item, index) => normalizeConceptSuggestion(item, fallbacks[index]))
    .slice(0, 3);
  const seen = new Set(normalized.map((item) => item.title.toLowerCase()));

  fallbacks.forEach((fallback) => {
    if (normalized.length >= 3 || seen.has(fallback.title.toLowerCase())) return;
    normalized.push(fallback);
    seen.add(fallback.title.toLowerCase());
  });

  return normalized;
}

export function normalizeGeminiInsights(value, summary) {
  if (!value || typeof value !== "object") return null;
  const cards = value.cards || {};
  const fallbackIdeas = summary.topicIdeas || [];
  const fallbackSuggestions = summary.nextVideoSuggestions || fallbackIdeas;
  // Accept Gemini's readable label only when its words occur in the actual
  // niche search queries/results. Otherwise show the clean niche query.
  const generatedTrendValue = String(cards.topTopicSignal?.value || "").trim();
  const trendValue = isGroundedTrendLabel(generatedTrendValue, summary.trendVideos)
    ? generatedTrendValue
    : summary.currentTrend;
  const recommendations = filledInsightItems(value.recommendations, fallbackIdeas, normalizeRecommendation);
  const nextVideoSuggestions = filledInsightItems(value.nextVideoSuggestions, fallbackSuggestions, normalizeConceptSuggestion);
  const crossoverTrends = normalizeCrossoverTrends(value.crossoverTrends, summary);
  const allowedTrendTitles = new Map(summary.trendVideos.map((video) => [
    normalizedTitleWords(video.snippet?.title || "").join(" "),
    String(video.snippet?.title || "").trim()
  ]));
  const validatedTrends = (Array.isArray(value.validatedTrends) ? value.validatedTrends : [])
    .map((title) => {
      const normalized = normalizedTitleWords(title).join(" ");
      if (allowedTrendTitles.has(normalized)) return allowedTrendTitles.get(normalized);

      const titleWords = new Set(normalizedTitleWords(title));
      if (!titleWords.size) return "";
      const closest = [...allowedTrendTitles.entries()].find(([candidate]) => {
        const candidateWords = new Set(candidate.split(" ").filter(Boolean));
        const shared = [...titleWords].filter((word) => candidateWords.has(word)).length;
        return shared / Math.max(titleWords.size, candidateWords.size) >= 0.8;
      });
      return closest?.[1] || "";
    })
    .filter(Boolean)
    .filter((title, index, values) => values.indexOf(title) === index)
    .slice(0, 3);
  const creditedVideo = summary.trendVideos.find((video) => (
    validatedTrends.includes(String(video.snippet?.title || "").trim())
  )) || summary.trendVideos[0];
  const creditedTitle = String(creditedVideo?.snippet?.title || "").trim();
  const creditedCreator = String(creditedVideo?.snippet?.channelTitle || "").trim();
  const trendDetail = creditedTitle
    ? `Based on “${creditedTitle}”${creditedCreator ? ` by ${creditedCreator}` : ""}`
    : "Based on current same-topic videos";

  return {
    cards: {
      bestUploadTime: {
        value: String(cards.bestUploadTime?.value || summary.bestUploadTime || "").slice(0, 24),
        detail: String(cards.bestUploadTime?.detail || "Gemini").slice(0, 32),
        tone: cards.bestUploadTime?.tone || "good"
      },
      nextVideoLength: {
        value: String(cards.nextVideoLength?.value || summary.nextVideoLength || "").slice(0, 24),
        detail: String(cards.nextVideoLength?.detail || summary.videoUploadTime || "Gemini").slice(0, 32),
        tone: cards.nextVideoLength?.tone || "good"
      },
      nextShortLength: {
        value: String(cards.nextShortLength?.value || summary.nextShortLength || "").slice(0, 24),
        detail: String(cards.nextShortLength?.detail || summary.shortUploadTime || "Gemini").slice(0, 32),
        tone: cards.nextShortLength?.tone || "warn"
      },
      topTopicSignal: {
        value: String(trendValue || summary.currentTrend || summary.topSignal || "").slice(0, 40),
        detail: String(trendDetail || "Current YouTube trend").slice(0, 160),
        tone: cards.topTopicSignal?.tone || "good"
      }
    },
    validatedTrends,
    crossoverTrends,
    nextVideoSuggestions,
    recommendations,
    chatIntro: String(value.chatIntro || compactAdviceSummary(summary)).slice(0, 360)
  };
}
