import {isGeminiAvailable, requestGeminiContent, requestGeminiText} from "./gemini-client.js?v=8";
import {durationFromIso, numberValue, shortText, youtubeCategoryName} from "./insights-format.js?v=1";
import {parseJsonObject} from "./services/json.js?v=1";
import {
  buildCrossoverTrendSuggestions, detectChannelLane, importantWords, isGroundedTrendLabel,
  isShort, normalizedTitleWords, trendEvidence, trendQueriesForLane, uploadPerformanceContext
} from "./insights-model.js?v=8";

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

function inferChannelNicheTerms(videos, profile = {}) {
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

function nicheQueriesFromTerms(terms, fallbackLane) {
  if (!terms.length) return trendQueriesForLane(fallbackLane);
  const pairs = [
    terms.slice(0, 2),
    [terms[0], terms[2]].filter(Boolean),
    [terms[1] || terms[0], terms[3]].filter(Boolean),
    [terms[0], terms[4]].filter(Boolean)
  ];
  return pairs.map((parts, index) => `${parts.join(" ")} ${[
    "updates", "challenge", "explained", "community"
  ][index]}`.trim());
}

function normalizeGeminiTrendPlan(value, fallbackLane) {
  if (!value || typeof value !== "object") return null;
  const creatorContextText = `${savedChannelContext.channelTopic} ${savedChannelContext.channelContext}`.trim();
  const creatorContextWords = new Set(importantWords(creatorContextText));
  const rawQueries = Array.isArray(value.queries) ? value.queries : [];
  let queries = rawQueries
    .map((query) => String(query || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (creatorContextWords.size) {
    queries = queries.filter((query) => importantWords(query).some((word) => creatorContextWords.has(word)));
    if (!queries.length) {
      const contextSeed = savedChannelContext.channelTopic
        || importantWords(savedChannelContext.channelContext).slice(0, 6).join(" ");
      queries = [
        `${contextSeed} news`,
        `${contextSeed} new releases`,
        `${contextSeed} reviews`,
        `${contextSeed} challenges`
      ];
    }
  }
  if (!queries.length) return null;

  const primaryCategory = String(value.primaryCategory || value.categoryLabel || fallbackLane.label || "General").slice(0, 60);
  const specificCategory = String(value.specificCategory || value.categorySeed || fallbackLane.seed || primaryCategory).slice(0, 80);
  const categoryLabel = specificCategory && specificCategory.toLowerCase() !== primaryCategory.toLowerCase()
    ? `${primaryCategory} - ${specificCategory}`
    : primaryCategory;
  const contentInterpretations = (Array.isArray(value.contentInterpretations) ? value.contentInterpretations : [])
    .slice(0, 12)
    .map((item) => ({
      title: String(item?.title || "").slice(0, 160),
      mediaReferences: (Array.isArray(item?.mediaReferences) ? item.mediaReferences : [])
        .map((reference) => String(reference || "").trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 4),
      premise: String(item?.premise || "").trim().slice(0, 240),
      audienceAppeal: String(item?.audienceAppeal || "").trim().slice(0, 180),
      confidence: ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "low"
    }))
    .filter((item) => item.title && item.premise);
  const allowedExpansionCategoryIds = new Set([
    "1", "10", "17", "20", "23", "24", "27", "28"
  ]);
  const expansionCategoryIds = (Array.isArray(value.expansionCategoryIds)
    ? value.expansionCategoryIds
    : [])
    .map((categoryId) => String(categoryId || ""))
    .filter((categoryId, index, values) => (
      allowedExpansionCategoryIds.has(categoryId) &&
      values.indexOf(categoryId) === index
    ))
    .slice(0, 5);
  const nicheTerms = (Array.isArray(value.nicheTerms) ? value.nicheTerms : [])
    .map((term) => String(term || "").trim().slice(0, 60))
    .filter((term, index, values) => term && values.indexOf(term) === index)
    .slice(0, 10);

  return {
    lane: {
      key: String(value.categoryKey || primaryCategory.toLowerCase().replace(/\s+/g, "-") || fallbackLane.key || "general").slice(0, 40),
      label: categoryLabel.slice(0, 80),
      seed: specificCategory || queries[0],
      primaryCategory,
      specificCategory,
      confidence: String(value.categoryConfidence || "medium").slice(0, 20)
    },
    queries,
    nicheTerms,
    contentInterpretations,
    expansionCategoryIds
  };
}

export async function buildGeminiTrendPlan(videos, channelProfile = null) {
  const fallbackLane = detectChannelLane(videos);
  const inferredNicheTerms = inferChannelNicheTerms(videos, channelProfile || {});
  const fallbackQueries = nicheQueriesFromTerms(inferredNicheTerms, fallbackLane);
  if (!isGeminiAvailable()) {
    return {
      lane: fallbackLane,
      queries: fallbackQueries,
      nicheTerms: inferredNicheTerms,
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  }

  const prompt = [
    "You are classifying a YouTube channel for ViewCast.",
    "Scan the complete channel evidence supplied below before choosing trends. Use the creator-provided topic and context first, then repeated patterns across the channel profile, recent uploads, top performers, descriptions, tags, YouTube categories, formats, dates, and performance.",
    "Treat uploadsScanned and scanCoveragePercent as confidence signals. When only part of the channel is available, say so internally and rely only on repeated evidence; never invent unavailable channel details.",
    "TREND SOURCE RULE: when creator-provided context is non-empty, it is the exclusive source for queries and trend discovery. Do not use, quote, paraphrase, or derive any trend query from upload titles. Uploads may still be interpreted for later performance analysis, but they must not steer what counts as a current trend.",
    "Decide the channel's broad category and, when possible, a specific subcategory. Do not classify from one ambiguous word or one outlier upload.",
    "Use clean creator categories. Examples: Music, Gaming, Roblox, Minecraft, Fortnite, Anime, Memes, Sports, Beauty, Education, Tech, Vlogs, Cooking.",
    "If the channel is broad gaming, primaryCategory should be Gaming and specificCategory should be General gaming. If it is mostly Roblox, primaryCategory should be Gaming and specificCategory should be Roblox.",
    "If a channel has music videos, songs, covers, albums, beats, or artist content, classify it as Music. Use a specific subcategory like Rap, Covers, Beats, or Artist edits only when clear.",
    "If the channel mixes memes with another fandom, game, anime, or music niche, classify the primary content type and put the fandom/game/style in specificCategory.",
    "Semantically interpret every upload title using its description, tags, category, and the repeated context across the channel. Identify what the title actually means, the media or real-world entity it references (game, show, film, song, artist, character, person, event, product, or meme), the video's underlying premise, and why that premise appeals to viewers.",
    "Do not treat title wording as the topic by itself. Resolve slang, abbreviations, character names, quotes, episode references, memes, and fandom-specific language when the surrounding metadata supports it.",
    "Never invent a media reference. If a reference is ambiguous, use an empty mediaReferences list, explain the likely premise conservatively, and set confidence to low.",
    "Then choose exactly 4 trend-search queries from the resolved media references and premises, not by copying full upload titles. The queries must cover 4 meaningfully different subtopics within the same category—not synonyms, rephrasings, or the same event/person/title. For example, a gaming category could cover a new release, a competitive meta, a creator challenge format, and an industry event.",
    "Every query must contain a specific named game, franchise, fandom, genre, product, skill, audience problem, or recurring subject proven by the channel evidence. Never return broad queries such as gaming trends, viral gaming, popular games, YouTube trends, or general entertainment.",
    "Return 4-10 nicheTerms that uniquely identify this creator's actual lane. Prefer repeated named entities, subgenres, recurring audience problems, and signature formats. Exclude generic category words such as gaming, videos, Shorts, trends, funny, and viral.",
    "When creator-provided context exists, ignore resolved upload media references while choosing queries and use only that creator context. Each query must contain at least one meaningful term written in the creator context.",
    "Also choose exactly 5 expansionCategoryIds for popular trends outside the current topic. Choose from Film & Animation=1, Music=10, Sports=17, Gaming=20, Comedy=23, Entertainment=24, Education=27, and Science & Technology=28.",
    "The expansion categories must remain outside the creator's current topic, but they must offer a credible bridge to the audience interests, tone, skills, goals, or presentation style explicitly described in creator-provided context. Rank the strongest bridge first.",
    "Return JSON only with this shape. No trailing commas. Also include nicheTerms as a top-level array of 4-10 strings:",
    `{"categoryKey":"","primaryCategory":"","specificCategory":"","categoryLabel":"","categorySeed":"","categoryConfidence":"high","contentInterpretations":[{"title":"","mediaReferences":[""],"premise":"","audienceAppeal":"","confidence":"high"}],"queries":["","","",""],"expansionCategoryIds":["","","","",""]}`,
    "",
    "Channel profile:",
    JSON.stringify(channelProfile || {}),
    "",
    "Channel-wide scan (available YouTube metadata, up to 200 uploads):",
    JSON.stringify(channelScanContext(videos, channelProfile || {})),
    "",
    "Creator-provided channel topic and context (use this as the primary niche guidance):",
    JSON.stringify(savedChannelContext),
    ""
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
        maxOutputTokens: 800
      }
    });
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    const plan = normalizeGeminiTrendPlan(parseJsonObject(text), fallbackLane);
    if (plan) {
      if (!plan.nicheTerms.length) plan.nicheTerms = inferredNicheTerms;
      return plan;
    }
    return {
      lane: fallbackLane,
      queries: fallbackQueries,
      nicheTerms: inferredNicheTerms,
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  } catch (error) {
    console.warn("Gemini trend plan failed.", error);
    return {
      lane: fallbackLane,
      queries: fallbackQueries,
      nicheTerms: inferredNicheTerms,
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  }
}
