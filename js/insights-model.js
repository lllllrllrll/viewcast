import {
  average, compactNumber, dateLabel, durationFromIso, durationFromSeconds,
  median, numberValue, secondsFromIso, shortText, youtubeCategoryName
} from "./insights-format.js?v=1";
import {fetchVideosByIds, fetchYouTubeJson as fetchJson} from "./insights-youtube.js?v=1";

let savedChannelContext = {channelTopic: "", channelContext: ""};

export function setInsightsCreatorContext(value = {}) {
  savedChannelContext = {
    channelTopic: String(value.channelTopic || ""),
    channelContext: String(value.channelContext || "")
  };
}

export function channelVideoCategoryIds(videos) {
  const categoryCounts = new Map();
  videos.forEach((video) => {
    const categoryId = video.snippet?.categoryId;
    if (!categoryId) return;
    categoryCounts.set(categoryId, (categoryCounts.get(categoryId) || 0) + 1);
  });
  return [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([categoryId]) => categoryId);
}

export async function fetchMostPopularVideosByCategory(accessToken, categoryId, maxResults = 12) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("regionCode", "US");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("videoCategoryId", categoryId);
  const payload = await fetchJson(url, accessToken);
  return (payload.items || []).map((video) => ({
    ...video,
    trendSource: "US most popular",
    trendCategoryId: categoryId
  }));
}

export async function fetchMostPopularVideos(accessToken, maxResults = 50) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("regionCode", "US");
  url.searchParams.set("maxResults", String(maxResults));
  const payload = await fetchJson(url, accessToken);
  return (payload.items || []).map((video) => ({
    ...video,
    trendSource: "US most popular — outside your topic"
  }));
}

export async function fetchTrendingVideos(accessToken, videos) {
  const categoryIds = channelVideoCategoryIds(videos);
  if (!categoryIds.length) return fetchMostPopularVideos(accessToken, 25);

  try {
    const results = await Promise.allSettled(
      categoryIds.slice(0, 4).map((categoryId) => fetchMostPopularVideosByCategory(accessToken, categoryId, 10))
    );
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  } catch (error) {
    console.warn("Current popular videos were not available.", error);
    return [];
  }
}

export function videoTitleText(videos) {
  return videos.map((video) => video.snippet?.title || "").join(" ").toLowerCase();
}

export function countMatches(text, words) {
  return words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
}

const gameTopicNames = [
  "fortnite", "minecraft", "roblox", "valorant", "gta", "grand theft auto", "call of duty", "warzone",
  "apex", "apex legends", "league of legends", "valorant", "overwatch", "rocket league", "elden ring",
  "helldivers", "palworld", "pokemon", "zelda", "mario", "sonic", "fnaf", "five nights at freddy",
  "brawl stars", "clash royale", "clash of clans", "among us", "terraria", "stardew valley", "gmod",
  "garry's mod", "geometry dash", "honkai", "genshin", "marvel rivals", "csgo", "counter strike",
  "rainbow six", "r6", "nba 2k", "madden", "fc 24", "fifa"
];

export function lane(key, label, seed, primaryCategory, specificCategory = "", confidence = "medium") {
  return {
    key,
    label,
    seed,
    primaryCategory,
    specificCategory,
    confidence
  };
}

export function detectedGameTopics(videos) {
  const text = videoTitleText(videos);
  return gameTopicNames
    .map((name) => ({
      name,
      count: text.split(name).length - 1
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

export function detectChannelLane(videos) {
  const text = videoTitleText(videos);
  const games = detectedGameTopics(videos);
  const memeScore = countMatches(text, ["meme", "memes", "funny", "shitpost", "edit", "edits", "compilation", "reaction"]);
  const gamingScore = countMatches(text, ["gaming", "gameplay", "walkthrough", "ranked", "update", "patch", "boss", "build", "loadout", "stream"]);
  const animeScore = countMatches(text, ["anime", "manga", "jojo", "one piece", "naruto", "dragon ball", "jjk", "jujutsu", "demon slayer"]);
  const musicScore = countMatches(text, ["music", "song", "songs", "album", "beat", "beats", "cover", "remix", "lyrics", "instrumental", "rap", "artist", "guitar", "piano"]);

  if (musicScore >= 2 && musicScore >= gamingScore && musicScore >= memeScore) {
    const specific = text.includes("beat") || text.includes("instrumental") ? "Beats"
      : text.includes("cover") ? "Covers"
      : text.includes("rap") ? "Rap"
      : "Music";
    return lane(
      "music",
      specific === "Music" ? "Music" : `Music - ${specific}`,
      specific,
      "Music",
      specific,
      "medium"
    );
  }

  if (memeScore >= 2 && memeScore >= gamingScore) {
    return lane("memes", "Memes", games[0]?.name || importantWords(text).slice(0, 2).join(" "), "Memes", games[0]?.name || "Memes");
  }

  if (games.length >= 2) {
    const hasDominantGame = games[0].count >= 2 && games[0].count >= (games[1]?.count || 0) * 2;
    if (hasDominantGame) {
      return lane(games[0].name, `Gaming - ${games[0].name}`, games[0].name, "Gaming", games[0].name, "medium");
    }
    return lane("general-gaming", "Gaming - General gaming", games.slice(0, 3).map((game) => game.name).join(" "), "Gaming", "General gaming");
  }

  if (games.length === 1 || gamingScore >= 2) {
    const game = games[0]?.name || titleTopicPhrases(topVideos(videos, 1)[0]?.snippet?.title || "")[0] || "Video game";
    return lane("specific-game", games[0]?.name ? `Gaming - ${game}` : "Gaming - Game-specific", game, "Gaming", game);
  }

  if (animeScore >= 2) {
    return lane("anime", "Anime", importantWords(text).slice(0, 3).join(" ") || "anime", "Anime", "Anime");
  }

  return lane("general", "General", titleTopicPhrases(topVideos(videos, 1)[0]?.snippet?.title || "")[0] || importantWords(text).slice(0, 3).join(" "), "General", "");
}

export function trendQueriesForLane(lane) {
  const seed = lane.seed || "youtube";
  const year = new Date().getFullYear();

  if (lane.key === "memes") {
    return [
      `${seed} meme trends`,
      `trending memes ${year}`,
      `viral meme format ${seed}`
    ];
  }

  if (lane.primaryCategory === "Music" || lane.key === "music") {
    return [
      `${seed} music trends`,
      `${seed} song ideas`,
      `trending ${seed} music`
    ];
  }

  if (lane.key === "general-gaming") {
    return [
      `trending new video games ${year}`,
      `new games everyone is playing`,
      `viral gaming trends`
    ];
  }

  if (lane.key === "specific-game") {
    return [
      `${seed} update`,
      `${seed} tips tricks`,
      `${seed} funny moments`,
      `${seed} meta`
    ];
  }

  if (lane.key === "anime") {
    return [
      `${seed} anime memes`,
      `${seed} anime trend`,
      `anime topics trending`
    ];
  }

  return [
    `${seed} trend`,
    `${seed} ideas`,
    `trending youtube topics ${seed}`
  ];
}

export async function searchVideosByQuery(
  accessToken,
  query,
  maxResults = 8,
  maxAgeDays = 30,
  shortsOnly = false
) {
  const publishedAfter = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("q", query);
  url.searchParams.set("order", "viewCount");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("publishedAfter", publishedAfter);
  url.searchParams.set("regionCode", "US");
  url.searchParams.set("relevanceLanguage", "en");
  if (shortsOnly) url.searchParams.set("videoDuration", "short");

  const payload = await fetchJson(url, accessToken);
  const ids = (payload.items || [])
    .map((item) => item.id?.videoId)
    .filter(Boolean);
  const videos = ids.length ? await fetchVideosByIds(ids, accessToken) : [];
  return shortsOnly
    ? videos.filter((video) =>
      isShortTrendVideo(video) && isEnglishTrendVideo(video)
    )
    : videos;
}

export async function fetchLaneTrendVideos(accessToken, videos) {
  const lane = detectChannelLane(videos);
  const queries = trendQueriesForLane(lane);
  const results = await Promise.allSettled(
    queries.slice(0, 3).map((query) => searchVideosByQuery(accessToken, query, 6))
  );
  const videosByQuery = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  return {
    lane,
    videos: videosByQuery.map((video) => ({...video, trendSource: "Category trend search"}))
  };
}

export async function fetchGeminiTrendVideos(accessToken, trendPlan) {
  if (!trendPlan?.queries?.length) return {lane: null, videos: []};
  let videos = [];
  let recentError = null;
  try {
    const results = await Promise.allSettled(
      trendPlan.queries.slice(0, 3).map((query) => searchVideosByQuery(
        accessToken,
        `${query} shorts`,
        8,
        45,
        true
      ))
    );
    videos = results.flatMap((result, index) => {
      if (result.status === "rejected") {
        recentError = result.reason;
        return [];
      }
      return result.value.map((video) => ({
        ...video,
        trendSource: "Niche YouTube trend search",
        trendQuery: trendPlan.queries[index]
      }));
    });
  } catch (error) {
    recentError = error;
    console.warn("Current niche trends were not available.", error);
  }

  // Do not retry quota-limited requests. A retry only spends more quota and
  // produces another 429 without improving the result.
  if (!videos.length && recentError?.status !== 429) {
    try {
      videos = (await searchVideosByQuery(
        accessToken,
        `${trendPlan.queries[0]} shorts`,
        12,
        90,
        true
      )).map((video) => ({
        ...video,
        trendSource: "Expanded niche YouTube trend search",
        trendQuery: trendPlan.queries[0]
      }));
    } catch (error) {
      console.warn("Expanded niche trends were not available.", error);
    }
  }

  return {
    lane: trendPlan.lane,
    videos,
    quotaLimited: recentError?.status === 429
  };
}

export async function fetchTrendReferenceVideos(accessToken, videos, trendPlan = null) {
  const lane = detectChannelLane(videos);
  const contextControlsTrends = meaningfulCreatorContextWords().length > 0;
  const ownCategoryIds = new Set(channelVideoCategoryIds(videos));
  let nicheResult = {lane: trendPlan?.lane || lane, videos: []};
  try {
    nicheResult = await fetchGeminiTrendVideos(accessToken, trendPlan);
  } catch (error) {
    console.warn("Niche trend search was not available.", error);
  }
  let laneResult = {lane, videos: []};
  const quotaLimited = nicheResult.quotaLimited === true;
  if (!nicheResult.videos.length && !contextControlsTrends && !quotaLimited) {
    try {
      laneResult = await fetchLaneTrendVideos(accessToken, videos);
    } catch (error) {
      console.warn("Category trend search was not available.", error);
    }
  }
  let outsideVideos = [];
  try {
    // One inexpensive videos.list call replaces the previous platform-wide and
    // eight-category search burst. This avoids quota spikes and HTTP 429 loops.
    if (!quotaLimited) outsideVideos = await fetchMostPopularVideos(accessToken, 25);
  } catch (error) {
    console.warn("Popular trend references were not available.", error);
  }
  const nicheVideos = nicheResult.videos;
  const merged = [
    ...nicheVideos,
    // The deterministic lane search is the fallback when Gemini's niche searches
    // return nothing, rather than a competing source that can dilute the niche.
    ...(!nicheVideos.length ? laneResult.videos : [])
  ];
  const seen = new Set();
  const ownVideoIds = new Set(videos.map((video) => video.id).filter(Boolean));
  let filteredTrendVideos = merged.filter((video) => {
    if (!video?.id || seen.has(video.id) || ownVideoIds.has(video.id)) return false;
    if (!isShortTrendVideo(video)) return false;
    if (!isEnglishTrendVideo(video)) return false;
    if (contextControlsTrends && !trendMatchesCreatorContext(video)) return false;
    if (!trendMatchesNichePlan(video, trendPlan)) return false;
    seen.add(video.id);
    return true;
  }).sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));

  if (!filteredTrendVideos.length &&
      nicheVideos.length &&
      contextControlsTrends &&
      trendPlan?.queries?.length) {
    const expandedResults = await Promise.allSettled(
      trendPlan.queries.slice(0, 2).map(
        (query) => searchVideosByQuery(
          accessToken,
          `${query} shorts`,
          12,
          90,
          true
        )
      )
    );
    filteredTrendVideos = expandedResults
      .flatMap((result, index) => result.status === "fulfilled"
        ? result.value.map((video) => ({
          ...video,
          trendSource: "Expanded niche YouTube trend search",
          trendQuery: trendPlan.queries[index]
        }))
        : [])
      .filter((video, index, values) => (
        video?.id &&
        !ownVideoIds.has(video.id) &&
        values.findIndex((candidate) => candidate.id === video.id) === index &&
        trendMatchesCreatorContext(video) &&
        trendMatchesNichePlan(video, trendPlan)
      ))
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  }

  if (!filteredTrendVideos.length && !quotaLimited && !trendPlan?.queries?.length) {
    const categoryFallback = await fetchTrendingVideos(accessToken, videos);
    filteredTrendVideos = categoryFallback
      .filter((video, index, values) => (
        video?.id &&
        isShortTrendVideo(video) &&
        isEnglishTrendVideo(video) &&
        !ownVideoIds.has(video.id) &&
        values.findIndex((candidate) => candidate.id === video.id) === index
      ))
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  }

  const trendVideos = diversifyTrendVideos(filteredTrendVideos, trendPlan?.queries || []);
  trendVideos.channelLane = trendPlan?.lane
    || nicheResult.lane
    || laneResult.lane
    || lane;
  trendVideos.trendQueries = trendPlan?.queries || trendQueriesForLane(trendVideos.channelLane);
  trendVideos.contentInterpretations = trendPlan?.contentInterpretations || [];
  const outsideCandidates = outsideVideos;
  trendVideos.outsideTrendVideos = selectOutsideTopicTrends(
    outsideCandidates,
    ownVideoIds,
    ownCategoryIds,
    trendPlan?.expansionCategoryIds || []
  );
  trendVideos.globalTrendVideos = selectGlobalPopularTrends(
    outsideCandidates.filter(isShortTrendVideo)
  );
  return trendVideos;
}

export function videoScore(video) {
  const stats = video.statistics || {};
  const views = numberValue(stats.viewCount) || 0;
  const likes = numberValue(stats.likeCount) || 0;
  const comments = numberValue(stats.commentCount) || 0;
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

export function meaningfulCreatorContextWords() {
  const genericContextWords = new Set([
    "channel", "creator", "content", "youtube", "uploads", "audience",
    "topic", "niche", "page", "account"
  ]);
  return importantWords(
    `${savedChannelContext.channelTopic} ${savedChannelContext.channelContext}`
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
  return selected;
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
    views: numberValue(video.statistics?.viewCount) || 0,
    likes: numberValue(video.statistics?.likeCount) || 0,
    comments: numberValue(video.statistics?.commentCount) || 0,
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

const topicStopWords = new Set([
  "the", "and", "for", "with", "you", "your", "this", "that", "from", "into", "what", "when", "why", "how",
  "are", "was", "were", "will", "can", "about", "after", "before", "video", "short", "shorts", "part", "new",
  "best", "worst", "full", "official", "live", "first", "last", "more", "less", "just", "like", "than",
  "gets", "got", "get", "has", "had", "have", "does", "did", "using", "use", "made", "make", "making"
]);

export function normalizedTitleWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

export function importantWords(text) {
  return normalizedTitleWords(text)
    .filter((word) => word.length > 2 && !topicStopWords.has(word));
}

export function titleTopicPhrases(text) {
  const words = normalizedTitleWords(text);
  const important = words.filter((word) => word.length > 2 && !topicStopWords.has(word));
  const phrases = [];

  if (important.length >= 2 && important.length <= 5) {
    phrases.push(important.join(" "));
  }

  for (let size = Math.min(4, important.length); size >= 2; size -= 1) {
    for (let index = 0; index <= important.length - size; index += 1) {
      phrases.push(important.slice(index, index + size).join(" "));
    }
  }

  return [...new Set(phrases)]
    .filter((phrase) => phrase.length <= 44)
    .slice(0, 8);
}

export function phraseWords(phrase) {
  return importantWords(phrase);
}

export function normalizedPhrase(phrase) {
  return phraseWords(phrase).join(" ");
}

export function stronglyOverlapsSourceTopic(topic, sourceTopics) {
  const topicWords = new Set(phraseWords(topic));
  if (!topicWords.size) return true;

  return sourceTopics.some((sourceTopic) => {
    const sourceWords = new Set(phraseWords(sourceTopic));
    if (!sourceWords.size) return false;
    const shared = [...topicWords].filter((word) => sourceWords.has(word)).length;
    const topicCoverage = shared / topicWords.size;
    const sourceCoverage = shared / sourceWords.size;
    return normalizedPhrase(topic) === normalizedPhrase(sourceTopic)
      || topicCoverage >= 0.9
      || (topicWords.size <= 2 && sourceCoverage >= 0.75);
  });
}

export function addTopicScores(scores, video, weight) {
  const phrases = titleTopicPhrases(video.snippet?.title);
  const words = importantWords(video.snippet?.title);

  phrases.forEach((phrase, index) => {
    const phraseWeight = weight * (phrases.length - index + 1);
    scores.set(phrase, (scores.get(phrase) || 0) + phraseWeight);
  });

  if (!phrases.length) {
    words.forEach((word) => {
      scores.set(word, (scores.get(word) || 0) + weight);
    });
  }
}

export function scoredTopicsFromVideos(videos, baseWeight = 1) {
  const scores = new Map();
  videos.forEach((video, index) => {
    addTopicScores(scores, video, Math.max(1, videos.length - index) * baseWeight);
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1]);
}

export function topicSignals(videos, trendVideos = [], {preferTrend = false} = {}) {
  const sourceTopics = topVideos(videos, 12).flatMap((video) => titleTopicPhrases(video.snippet?.title));

  if (preferTrend && trendVideos.length) {
    const trendTopics = scoredTopicsFromVideos(topVideos(trendVideos, 16), 2)
      .map(([topic]) => topic)
      .filter((topic) => !stronglyOverlapsSourceTopic(topic, sourceTopics))
      .slice(0, 8);
    if (trendTopics.length) return trendTopics;
  }

  const scores = new Map();
  scoredTopicsFromVideos(topVideos(videos, 12), 2).forEach(([topic, score]) => {
    scores.set(topic, (scores.get(topic) || 0) + score);
  });
  scoredTopicsFromVideos(topVideos(trendVideos, 12), 1).forEach(([topic, score]) => {
    scores.set(topic, (scores.get(topic) || 0) + score);
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([topic]) => topic)
    .slice(0, 8);
}

export function readableTrendQuery(query = "") {
  return String(query || "")
    .replace(/\b(20\d{2}|19\d{2})\b/g, "")
    .replace(/\b(youtube|trending|trend|trends|viral|current|latest)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 40);
}

export function trendReferenceText(trendVideos = []) {
  return [
    ...(trendVideos.trendQueries || []),
    ...trendVideos
      .filter((video) => /niche YouTube trend search$/.test(video.trendSource || ""))
      .slice(0, 20)
      .map((video) => video.snippet?.title || "")
  ].join(" ");
}

export function isGroundedTrendLabel(value, trendVideos = []) {
  const labelWords = importantWords(value);
  if (labelWords.length < 2 || labelWords.length > 6) return false;
  const referenceWords = new Set(importantWords(trendReferenceText(trendVideos)));
  const matchingWords = labelWords.filter((word) => referenceWords.has(word)).length;
  return matchingWords >= Math.min(2, labelWords.length);
}

export function currentTrendSignals(trendVideos = []) {
  const externalSignals = trendVideos
    .slice(0, 3)
    .map((video) => shortText(video.snippet?.title || "", 56))
    .filter(Boolean);
  const uniqueSignals = [...new Set(externalSignals.map((signal) => signal.toLowerCase()))]
    .map((signal) => externalSignals.find((candidate) => candidate.toLowerCase() === signal))
    .slice(0, 3);
  return uniqueSignals;
}

export function currentTrendSignal(videos, trendVideos = []) {
  return currentTrendSignals(trendVideos)[0];
}

export function buildTopicIdeas(videos, trendVideos) {
  const topics = topicSignals(videos, trendVideos, {preferTrend: true});
  const best = topVideos(videos, 3);
  const trendTitle = trendVideos[0]?.snippet?.title || "";
  const primary = topics[0] || "your strongest topic";
  const secondary = topics[1] || "a viewer problem";
  const third = topics[2] || "a current trend";
  const bestTitle = best[0]?.snippet?.title || "your top upload";

  return [
    {
      title: `Make a ${primary} follow-up`,
      body: `Build from ${bestTitle}. Use the same viewer promise, then add a fresher angle around ${secondary}.`,
      label: "Topic"
    },
    {
      title: `Turn ${secondary} into a Short`,
      body: `Make a fast 3-step Short that answers one specific question, then point viewers to a longer upload for the full breakdown.`,
      label: "Short"
    },
    {
      title: trendTitle ? `Connect ${third} to a current trend` : `Test a trend-shaped version of ${third}`,
      body: trendTitle
        ? `A nearby YouTube trend signal is ${trendTitle}. Borrow the format, not the idea, and apply it to your channel niche.`
        : `Use your recent high-performing title patterns and package ${third} as a timely comparison, challenge, or mistake video.`,
      label: "Trend"
    }
  ];
}

export function buildNextVideoSuggestions(videos, trendVideos) {
  const performance = uploadPerformanceContext(videos);
  const top = performance.topPerformers[0];
  const second = performance.topPerformers[1];
  const under = performance.underPerformers[0];
  const medianViews = compactNumber(performance.medianViews);
  const averageViews = compactNumber(performance.averageViews);
  const trend = currentTrendSignal(videos, trendVideos);
  const primaryEvidence = trendEvidence(trendVideos[0]);
  const secondaryEvidence = trendEvidence(trendVideos.find((video) => video.trendQuery !== trendVideos[0]?.trendQuery) || trendVideos[1]);
  const trendReference = primaryEvidence?.title || trend;
  const betterFormat = performance.shortAverageViews > performance.videoAverageViews ? "Short" : "video";
  const betterFormatViews = performance.shortAverageViews > performance.videoAverageViews
    ? performance.shortAverageViews
    : performance.videoAverageViews;
  const category = trendVideos.channelLane?.specificCategory
    || trendVideos.channelLane?.primaryCategory
    || trendVideos.channelLane?.label
    || "your niche";

  return [
    {
      title: `${category}: explain “${shortText(trendReference, 72)}”`,
      body: top
        ? `${trendReference} is an external YouTube signal from ${primaryEvidence?.publishedLabel || "the last 60 days"} (${compactNumber(primaryEvidence?.views || 0)} views; about ${compactNumber(primaryEvidence?.viewsPerDay || 0)}/day). Use the hook pattern from your ${compactNumber(top.views)}-view top upload, then explain why this topic matters now.`
        : `${trendReference} is an external YouTube signal from ${primaryEvidence?.publishedLabel || "the last 60 days"}. Turn it into a clear viewer question and answer it in your own style.`,
      label: "Current trend"
    },
    {
      title: secondaryEvidence
        ? `${betterFormat} test: “${shortText(secondaryEvidence.title, 68)}”`
        : `${betterFormat} test: compare the trend to your lane`,
      body: secondaryEvidence
        ? `This separate external signal was published ${secondaryEvidence.publishedLabel} and is averaging about ${compactNumber(secondaryEvidence.viewsPerDay)} views/day. Adapt its viewer question into a comparison, ranking, test, or myth-check for ${category}; your ${betterFormat.toLowerCase()} format averages ${compactNumber(betterFormatViews)} views.`
        : `Your ${betterFormat.toLowerCase()} format averages about ${compactNumber(betterFormatViews)} views. Turn ${trend} into a comparison, ranking, test, or myth-check that fits ${category}.`,
      label: "Current trend",
      tone: "warn"
    },
    {
      title: "Avoid the weaker angle, keep the stronger promise",
      body: second
        ? `Your strong uploads beat the ${medianViews} median when the idea is easy to understand fast. If ${under?.title || "a past upload"} underperformed, avoid that vague angle and make the next concept instantly searchable.`
        : `Aim above your ${averageViews} average by making the idea specific enough to search and broad enough to connect with ${trend}.`,
      label: "Channel data"
    }
  ];
}

export function buildCrossoverTrendSuggestions(summary) {
  const category = summary.channelLane?.specificCategory
    || summary.channelLane?.primaryCategory
    || summary.channelLane?.label
    || "your current audience";
  const performance = uploadPerformanceContext(summary.recent || []);
  const preferredFormat = performance.shortAverageViews > performance.videoAverageViews ? "Short" : "video";
  const contextLabel = creatorContextLabel(summary);

  return (summary.outsideTrendVideos || []).slice(0, 3).map((video) => {
    const evidence = trendEvidence(video);
    const outsideCategory = youtubeCategoryName(video.snippet?.categoryId) || "Outside topic";
    const dailyViews = compactNumber(evidence?.viewsPerDay || 0);
    return {
      title: `${outsideCategory} crossover: ${shortText(evidence?.title || "popular trend", 72)}`,
      body: `${evidence?.title || "This popular video"} is drawing about ${dailyViews} views per day. For ${contextLabel}, test the outside subject in a ${preferredFormat}, but preserve the pacing, humor, expertise, or payoff your ${category} audience expects. Treat it as one measurable pilot before changing the channel direction.`,
      label: "Targeted crossover",
      tone: "good"
    };
  });
}

export function creatorContextLabel(summary) {
  const supplied = summary.creatorProvidedContext || savedChannelContext;
  return shortText(
    supplied?.channelTopic ||
    supplied?.channelContext ||
    summary.channelLane?.specificCategory ||
    summary.channelLane?.primaryCategory ||
    "this channel",
    80
  );
}

export function expansionTrendFallbacks(summary) {
  const channelCategory = String(
    summary.channelLane?.primaryCategory ||
    summary.channelLane?.label ||
    ""
  ).toLowerCase();
  const options = [
    {
      category: "Gaming",
      title: "New-release challenge and first-reaction videos",
      bridgeWords: ["meme", "funny", "reaction", "challenge", "character", "story", "gaming"],
      body: "Gaming audiences respond to timely challenges built around a new release, update, character, or competitive rule. Study how creators explain the stakes immediately, show the result early, and turn one challenge into a repeatable series."
    },
    {
      category: "Science & Technology",
      title: "AI tool tests and side-by-side product comparisons",
      bridgeWords: ["analysis", "review", "tool", "experiment", "tutorial", "education", "tech"],
      body: "Practical AI experiments and clear A-versus-B comparisons give viewers an immediate reason to click. Use a visible test, measurable result, and decisive recommendation instead of a broad product overview."
    },
    {
      category: "Sports",
      title: "Major-event reactions, predictions, and rapid breakdowns",
      bridgeWords: ["reaction", "competition", "challenge", "commentary", "debate", "sports"],
      body: "Event-led videos perform best when the creator publishes while attention is concentrated. Lead with one strong prediction or disputed moment, support it with evidence, and invite viewers to take a side."
    },
    {
      category: "Music",
      title: "Song breakdowns, remixes, and process reveals",
      bridgeWords: ["meme", "edit", "reaction", "artist", "audio", "music", "remix"],
      body: "Music discovery expands through recognizable songs paired with a transformation or behind-the-scenes process. Show the before-and-after result first, then explain the creative decisions that produced it."
    },
    {
      category: "Education",
      title: "Fast visual explainers built around one surprising question",
      bridgeWords: ["analysis", "guide", "history", "explain", "education", "tutorial", "story"],
      body: "Focused explainers package a complex subject as one concrete question with a visual payoff. Keep the title specific, establish why the answer matters, and remove background that delays the explanation."
    },
    {
      category: "Entertainment",
      title: "Trailer, announcement, and pop-culture reaction formats",
      bridgeWords: ["meme", "funny", "reaction", "story", "culture", "character", "commentary"],
      body: "Entertainment reactions gain momentum when they add a clear interpretation instead of only summarizing the news. Choose one reveal, explain what it changes, and make the creator's perspective the reason to watch."
    }
  ];
  const contextWords = meaningfulCreatorContextWords();
  const contextLabel = creatorContextLabel(summary);
  return options
    .filter((item) => !channelCategory.includes(item.category.toLowerCase()))
    .sort((a, b) => (
      contextWords.filter((word) => b.bridgeWords.includes(word)).length -
      contextWords.filter((word) => a.bridgeWords.includes(word)).length
    ))
    .slice(0, 3)
    .map((item) => ({
      category: item.category,
      title: item.title,
      body: `${item.body} For ${contextLabel}, carry over the channel's established voice and audience promise rather than copying the outside creator.`,
      label: `${item.category} expansion`,
      tone: "warn"
    }));
}

export function buildChannelSummary(videos, trendVideos, channelProfile = null) {
  const recent = videos.slice(0, 20);
  const longVideos = videos.filter((video) => !isShort(video));
  const shorts = videos.filter(isShort);
  const views = videos.map((video) => numberValue(video.statistics?.viewCount)).filter((value) => value !== null);
  const avgViews = average(views) || 0;
  const best = topVideos(videos, 1)[0];
  const bestViews = numberValue(best?.statistics?.viewCount) || 0;
  const topics = topicSignals(videos, trendVideos, {preferTrend: true});
  const channelLane = trendVideos.channelLane || detectChannelLane(videos);
  const currentTrends = currentTrendSignals(trendVideos);
  const currentTrend = currentTrends[0];

  return {
    recent,
    avgViews,
    bestViews,
    best,
    bestUploadTime: bestUploadSlot(videos, "all"),
    videoUploadTime: bestUploadSlot(videos, "video"),
    shortUploadTime: bestUploadSlot(videos, "short"),
    nextVideoLength: recommendedLength(longVideos.length ? longVideos : videos, "video"),
    nextShortLength: recommendedLength(shorts.length ? shorts : videos, "short"),
    topSignal: topics[0] || currentTrend || "Current trends",
    currentTrend,
    currentTrends,
    globalTrendVideos: trendVideos.globalTrendVideos || [],
    channelLane,
    contentInterpretations: trendVideos.contentInterpretations || [],
    outsideTrendVideos: trendVideos.outsideTrendVideos || [],
    channelProfile,
    creatorProvidedContext: savedChannelContext,
    nextVideoSuggestions: buildNextVideoSuggestions(videos, trendVideos),
    topicIdeas: buildTopicIdeas(videos, trendVideos),
    trendVideos
  };
}
