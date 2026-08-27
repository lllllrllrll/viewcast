import {isGeminiAvailable, requestGeminiContent, requestGeminiText} from "./gemini-client.js?v=8";
import {numberValue, shortText, youtubeCategoryName} from "./insights-format.js?v=1";
import {
  buildCrossoverTrendSuggestions, isGroundedTrendLabel, isShort,
  normalizedTitleWords, trendEvidence, uploadPerformanceContext
} from "./insights-model.js?v=5";
import {
  channelScanContext, compactAdviceSummary, compactChannelProfile,
  geminiCreatorContext
} from "./insights-gemini.js?v=2";

function geminiContext(summary) {
  const trendReferences = summary.trendVideos
    .slice(0, 5)
    .map((video) => ({
      ...trendEvidence(video),
      likes: numberValue(video.statistics?.likeCount) || 0,
      comments: numberValue(video.statistics?.commentCount) || 0,
      format: isShort(video) ? "Short" : "Video",
      category: youtubeCategoryName(video.snippet?.categoryId),
    }))
    .filter((video) => video.title);
  const visibleIdeas = summary.geminiInsights?.recommendations || summary.topicIdeas;
  const ideas = visibleIdeas.slice(0, 3).map((idea) => `${idea.title}: ${shortText(idea.body, 120)}`);
  return {
    creatorProvidedContext: summary.creatorProvidedContext || geminiCreatorContext(),
    channelProfile: compactChannelProfile(summary.channelProfile || {}),
    channelCategory: summary.channelLane?.label || "General creator channel",
    primaryCategory: summary.channelLane?.primaryCategory || summary.channelLane?.label || "General",
    specificCategory: summary.channelLane?.specificCategory || summary.channelLane?.seed || "",
    categoryConfidence: summary.channelLane?.confidence || "medium",
    currentYouTubeTrend: summary.geminiInsights?.cards?.topTopicSignal?.value || summary.currentTrend || summary.topSignal,
    bestUploadTime: summary.geminiInsights?.cards?.bestUploadTime?.value || summary.bestUploadTime,
    videoUploadTime: summary.videoUploadTime,
    shortUploadTime: summary.shortUploadTime,
    nextVideoLength: summary.geminiInsights?.cards?.nextVideoLength?.value || summary.nextVideoLength,
    nextShortLength: summary.geminiInsights?.cards?.nextShortLength?.value || summary.nextShortLength,
    suggestedIdeas: ideas,
    trendReferences,
    trendQueries: summary.trendVideos.trendQueries || [],
    contentInterpretations: (summary.contentInterpretations || []).slice(0, 5)
  };
}

function geminiPageContext(summary, videos) {
  return {
    ...geminiContext(summary),
    averageViews: Math.round(summary.avgViews || 0),
    bestUploadViews: summary.bestViews || 0,
    uploadPerformance: uploadPerformanceContext(videos),
    channelWideScan: channelScanContext(
      videos,
      summary.channelProfile || {},
      {includeCatalog: false}
    )
  };
}

function safeJsonParse(value) {
  const cleaned = String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  // Try standard parse first
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // If that fails, try to extract just the first object found
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        // Remove trailing commas which are common in LLM output but invalid in JSON
        const fixTrailingCommas = match[0].replace(/,[ \t\r\n]*([\]\}])/g, "$1");
        return JSON.parse(fixTrailingCommas);
      } catch (innerError) {
        console.warn("JSON repair failed:", innerError);
      }
    }
    return null;
  }
}

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

export async function buildGeminiPageInsights(summary, videos) {
  if (!isGeminiAvailable()) return null;

  const prompt = [
    "You are ViewCast's YouTube strategist. Return compact JSON only. No trailing commas.",
    "Use only supplied channel stats, trend references, and upload patterns. Do not invent analytics.",
    "Before writing any card or recommendation, scan channelWideScan across the available uploadCatalog, recurringTags, categories, formatMix, recentUploads, and topPerformers. Base advice on repeated channel-wide evidence rather than one upload.",
    "Use uploadsScanned and scanCoveragePercent as confidence signals. If the scan is partial or metadata is missing, make narrower claims and never imply Gemini watched video or accessed data that is not supplied.",
    "Treat creatorProvidedContext as the primary source for the channel niche, audience, goals, and requested content direction.",
    "Classify the channel niche from repeated upload patterns, then make every card and suggestion match that niche.",
    "Use contentInterpretations to understand what the creator's titles mean and which media they reference. Treat the raw title only as a lookup key and performance label, never as a ready-made topic.",
    "Base concepts on the resolved mediaReferences, premise, audienceAppeal, and external trend evidence. Do not paste a creator title into a suggestion, tell the creator to expand it, or merely propose a follow-up/part 2.",
    "When an interpretation has low confidence or no resolved media reference, do not build a recommendation around that interpretation.",
    "Use 12-hour time like 'Tue 6 PM'. Avoid generic advice such as make a follow-up, post more, extend the video, or improve the hook.",
    "Return exactly 3 nextVideoSuggestions and exactly 3 recommendations. Every item needs a non-empty title, body, label, and tone.",
    "Exactly 2 of the 3 nextVideoSuggestions must be specific new concepts grounded in two different external trendReferences. The third must be grounded in the creator's own channel performance.",
    "For each trend-grounded suggestion, name the external reference, state its published date and viewsPerDay, explain why it fits this channel, and use the label 'Current trend'. Never present a search query itself as proof of a trend.",
    "For the channel-grounded suggestion, cite a supplied performance number and use the label 'Channel data'.",
    "A trend reference is supporting evidence, not a concept to copy. Transform its viewer demand into an original angle for this channel.",
    "recommendations must be 3 important strategic tips the creator can act on now, such as packaging, upload timing, format length, niche/trend fit, Shorts strategy, or weak-angle avoidance.",
    "topTopicSignal.value must be a short, recognizable trend name (2-6 words), not a sentence or a fragment copied from a video title.",
    "topTopicSignal.value must describe the central idea or viewer interest shared by the evidence. It must not equal, abbreviate, or lightly rewrite a source video's title.",
    "topTopicSignal.detail must credit the strongest supporting trendReference by its exact video title and channel name.",
    "Every word in topTopicSignal.value must be supported by the supplied external YouTube trend references or trend queries. Do not invent a trend.",
    "Review every trendReference for semantic relevance to creatorProvidedContext and present-day usefulness. Reject videos that only share a broad category word, discuss an old event/topic despite being newly uploaded, are archival/reuploads, or do not help this specific creator.",
    "Return validatedTrends as up to 3 exact, character-for-character title strings copied from distinct accepted trendReferences. Use fewer than 3 when fewer are genuinely current and relevant; never fill space with a weak match.",
    "Use only references included in validatedTrends for trend-grounded nextVideoSuggestions. If fewer than 2 references pass, replace the unsupported trend suggestion with channel-data advice instead of using a rejected reference.",
    "Return exactly 3 crossoverTrends as relevant Shorts opportunities for this channel, using three distinct accepted trendReferences when available.",
    "Every crossover trend must name its exact same-topic reference, explain why its proven viewer demand fits this channel, and transform that demand into a specific original Short with a hook, format, and payoff. Use the label 'Relevant opportunity'. Never use outsideTrendReferences or unrelated platform-wide subjects for this section, and never copy the reference's concept.",
    "JSON shape:",
    `{"cards":{"bestUploadTime":{"value":"","detail":"","tone":"good"},"nextVideoLength":{"value":"","detail":"","tone":"good"},"nextShortLength":{"value":"","detail":"","tone":"warn"},"topTopicSignal":{"value":"","detail":"","tone":"good"}},"validatedTrends":["","",""],"nextVideoSuggestions":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"crossoverTrends":[{"title":"","body":"","label":"Relevant opportunity","tone":"good"},{"title":"","body":"","label":"Relevant opportunity","tone":"good"},{"title":"","body":"","label":"Relevant opportunity","tone":"good"}],"recommendations":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"chatIntro":""}`,
    "",
    "Channel data:",
    JSON.stringify(geminiPageContext(summary, videos))
  ].join("\n");

  try {
    const payload = await requestGeminiContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 850
      }
    });

    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    const parsedInsights = safeJsonParse(text);
    if (!parsedInsights) {
      // Gemini can occasionally hit its output limit mid-object. The page still
      // has complete deterministic channel analysis, so render that instead of
      // discarding the entire result or spending credits on an automatic retry.
      console.warn("Gemini returned incomplete JSON; using channel-data insights.");
      return normalizeGeminiInsights({}, summary);
    }
    return normalizeGeminiInsights(parsedInsights, summary);
  } catch (error) {
    console.warn("Gemini page insights failed.", error);
    const fallback = normalizeGeminiInsights({}, summary);
    fallback.aiUnavailable = true;
    fallback.aiErrorCode = String(error.code || error.message || "unavailable");
    return fallback;
  }
}

export async function buildGeminiChatReply(question, summary, chatHistory = []) {
  if (!isGeminiAvailable()) return "An error has occurred. The AI assistant is unavailable right now.";

  const fullContext = summary ? geminiContext(summary) : null;
  const chatContext = fullContext ? {
    creatorProvidedContext: fullContext.creatorProvidedContext,
    channelCategory: fullContext.channelCategory,
    currentYouTubeTrend: fullContext.currentYouTubeTrend,
    bestUploadTime: fullContext.bestUploadTime,
    nextVideoLength: fullContext.nextVideoLength,
    nextShortLength: fullContext.nextShortLength,
    suggestedIdeas: fullContext.suggestedIdeas,
    trendReferences: fullContext.trendReferences.slice(0, 3)
  } : null;
  const systemInstruction = [
    "Give concise, practical YouTube advice using only the supplied channel context.",
    "Do not invent analytics. Answer in 2-3 short sentences.",
    "",
    "Channel context:",
    chatContext ? JSON.stringify(chatContext) : "No channel data yet. Ask one focused question."
  ].join("\n");

  try {
    const text = await requestGeminiText({
      contents: chatHistory.slice(-4),
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 120
      }
    });

    return text || "I couldn't generate a response. Please try again.";
  } catch (error) {
    console.error("Gemini advice failed.", error);
    return "AI chat is temporarily unavailable, but the recommendations above still use your channel uploads and YouTube performance data.";
  }
}
