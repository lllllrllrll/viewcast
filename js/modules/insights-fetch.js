import {fetchVideosByIds, fetchYouTubeJson as fetchJson} from "../insights-youtube.js?v=5";
import {channelVideoCategoryIds, detectChannelLane, fetchMostPopularVideos, fetchTrendingVideos, trendQueriesForLane} from "./insights-lane.js?v=1";
import {isEnglishTrendVideo, isShortTrendVideo, trendMomentumScore} from "./insights-performance.js?v=1";
import {diversifyTrendVideos, meaningfulCreatorContextWords, selectGlobalPopularTrends, selectOutsideTopicTrends, trendMatchesCreatorContext, trendMatchesNichePlan} from "./insights-trend-selection.js?v=1";

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
        query,
        12,
        90
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
        trendPlan.queries[0],
        15,
        180
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
  const eligibleTrendVideos = merged.filter((video) => {
    if (!video?.id || seen.has(video.id) || ownVideoIds.has(video.id)) return false;
    if (!isEnglishTrendVideo(video)) return false;
    seen.add(video.id);
    return true;
  });
  const strictTrendVideos = eligibleTrendVideos.filter((video) => (
    (!contextControlsTrends || trendMatchesCreatorContext(video)) &&
    trendMatchesNichePlan(video, trendPlan)
  ));
  const broaderTopicVideos = eligibleTrendVideos.filter((video) => (
    trendMatchesNichePlan(video, trendPlan) ||
    (contextControlsTrends && trendMatchesCreatorContext(video))
  ));
  let filteredTrendVideos = [...strictTrendVideos];
  broaderTopicVideos.forEach((video) => {
    if (!filteredTrendVideos.some((candidate) => candidate.id === video.id)) {
      filteredTrendVideos.push(video);
    }
  });
  filteredTrendVideos.sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));

  if (filteredTrendVideos.length < 3 &&
      nicheVideos.length &&
      contextControlsTrends &&
      trendPlan?.queries?.length) {
    const expandedResults = await Promise.allSettled(
      trendPlan.queries.slice(0, 2).map(
        (query) => searchVideosByQuery(
          accessToken,
          query,
          15,
          180
        )
      )
    );
    const expandedVideos = expandedResults
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
        isEnglishTrendVideo(video) &&
        (trendMatchesCreatorContext(video) || trendMatchesNichePlan(video, trendPlan))
      ))
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
    expandedVideos.forEach((video) => {
      if (!filteredTrendVideos.some((candidate) => candidate.id === video.id)) {
        filteredTrendVideos.push(video);
      }
    });
    filteredTrendVideos.sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
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
