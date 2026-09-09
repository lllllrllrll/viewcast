import {fetchYouTubeJson as fetchJson} from "../insights-youtube.js?v=5";
import {importantWords, titleTopicPhrases} from "./insights-topic-language.js?v=1";
import {topVideos} from "./insights-performance.js?v=1";

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
