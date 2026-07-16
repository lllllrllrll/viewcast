import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured, googleOAuthClientId } from "./firebase-config.js";
import { isGeminiAvailable, requestGeminiContent, requestGeminiText } from "./gemini-client.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const form = document.getElementById("videoAnalysisForm");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const refreshInsightsButton = document.getElementById("refreshInsights");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const insightErrorPanel = document.getElementById("insightErrorPanel");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("insightChatForm");
const chatInput = document.getElementById("insightChatInput");

const tokenStorageKey = "viewcastYouTubeAccessToken";
const connectionStorageKey = "viewcastYouTubeConnection";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";
const insightsStorageKeyPrefix = "viewcastAiInsights:";
const insightsCacheMaxAge = 15 * 60 * 1000;

let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let googleIdentityScriptPromise = null;
let latestChannelSummary = null;
let chatHistory = [];

function setStatus(message) {
  let status = document.getElementById("videoAnalysisStatus");
  if (!status && analyzerLoading) {
    status = document.createElement("p");
    status.id = "videoAnalysisStatus";
    status.className = "analysis-status";
    analyzerLoading.querySelector(".analyzer-loader")?.append(status);
  }
  if (status) {
    status.textContent = message || "";
    status.hidden = !message;
  }
}

function setBusy(isBusy, label = "Insights Ready") {
  if (!submitButton) return;
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "Analyzing..." : label;
}

function setRefreshInsightsBusy(isBusy) {
  if (!refreshInsightsButton) return;
  refreshInsightsButton.disabled = isBusy;
  const label = refreshInsightsButton.querySelector("span");
  if (label) label.textContent = isBusy ? "Refreshing..." : "Refresh Insights";
}

function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: number >= 1000 ? 1 : 0
  }).format(number);
}

function wholeNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en").format(Math.round(number));
}

function durationFromSeconds(value) {
  const number = numberValue(value);
  if (number === null) return "";
  const totalSeconds = Math.max(0, Math.round(number));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function secondsFromIso(value = "") {
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function durationFromIso(value = "") {
  const seconds = secondsFromIso(value);
  return seconds === null ? "" : durationFromSeconds(seconds);
}

function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const youtubeCategoryNames = {
  "1": "Film & Animation",
  "2": "Autos & Vehicles",
  "10": "Music",
  "15": "Pets & Animals",
  "17": "Sports",
  "19": "Travel & Events",
  "20": "Gaming",
  "22": "People & Blogs",
  "23": "Comedy",
  "24": "Entertainment",
  "25": "News & Politics",
  "26": "Howto & Style",
  "27": "Education",
  "28": "Science & Technology"
};

function shortText(value = "", max = 280) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function youtubeCategoryName(categoryId) {
  return youtubeCategoryNames[String(categoryId || "")] || "";
}

function bestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url
    || thumbnails.standard?.url
    || thumbnails.high?.url
    || thumbnails.medium?.url
    || thumbnails.default?.url
    || "";
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function videosStorageKey() {
  return currentUser ? videosStorageKeyPrefix + currentUser.uid : "";
}

function readCachedVideos() {
  const key = videosStorageKey();
  if (!key) return [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(saved?.videos) ? saved.videos : [];
  } catch (error) {
    localStorage.removeItem(key);
    return [];
  }
}

function saveCachedVideos(videos) {
  const key = videosStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({
    videos,
    savedAt: Date.now()
  }));
}

function insightsStorageKey(focusVideoId = "") {
  return currentUser ? insightsStorageKeyPrefix + currentUser.uid + ":" + (focusVideoId || "channel") : "";
}

function insightsFingerprint(videos, focusVideoId = "") {
  return JSON.stringify({
    focusVideoId,
    videos: videos.slice(0, 40).map((video) => ({
      id: video.id,
      publishedAt: video.snippet?.publishedAt || "",
      title: video.snippet?.title || "",
      views: video.statistics?.viewCount || "",
      likes: video.statistics?.likeCount || "",
      comments: video.statistics?.commentCount || ""
    }))
  });
}

function readCachedInsights(videos, focusVideoId = "") {
  const key = insightsStorageKey(focusVideoId);
  if (!key) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved?.summary || saved.fingerprint !== insightsFingerprint(videos, focusVideoId)) return null;
    if (Date.now() - saved.savedAt > insightsCacheMaxAge) return null;
    return saved.summary;
  } catch (error) {
    localStorage.removeItem(key);
    return null;
  }
}

function saveCachedInsights(summary, videos, focusVideoId = "") {
  const key = insightsStorageKey(focusVideoId);
  if (!key || !summary) return;
  localStorage.setItem(key, JSON.stringify({
    fingerprint: insightsFingerprint(videos, focusVideoId),
    summary,
    savedAt: Date.now()
  }));
}

function setLibraryStatus(message) {
  if (videoLibraryStatus) videoLibraryStatus.textContent = message || "";
}

function setLibraryBusy(isBusy) {
  if (!refreshVideosButton) return;
  refreshVideosButton.disabled = isBusy;
  refreshVideosButton.textContent = isBusy ? "Loading..." : "Refresh Videos";
}

function updateLibrarySelection(videoId) {
  selectedVideoId = videoId || "";
  videoLibrary?.querySelectorAll(".video-library-card").forEach((card) => {
    const isActive = card.dataset.videoId === selectedVideoId;
    card.classList.toggle("active", isActive);
    card.setAttribute("aria-pressed", String(isActive));
  });
}

function renderVideoLibrary(videos = channelVideos) {
  channelVideos = Array.isArray(videos) ? videos : [];
  if (!videoLibrary) return;

  if (!channelVideos.length) {
    videoLibrary.innerHTML = '<div class="video-library-empty">No uploads are loaded yet. Refresh videos to pull from your linked channel.</div>';
    return;
  }

  videoLibrary.innerHTML = channelVideos.map((video) => {
    const snippet = video.snippet || {};
    const stats = video.statistics || {};
    const title = snippet.title || "Untitled video";
    const thumbnail = bestThumbnail(snippet.thumbnails);
    const published = dateLabel(snippet.publishedAt);
    const duration = durationFromIso(video.contentDetails?.duration);
    const views = wholeNumber(stats.viewCount);
    const meta = [published, views ? views + " views" : ""].filter(Boolean).join(" - ");
    return '<button class="video-library-card" type="button" data-video-id="' + escapeHtml(video.id) + '" aria-pressed="false">'
      + '<div class="video-library-thumb">'
      + (thumbnail ? '<img src="' + escapeHtml(thumbnail) + '" alt="' + escapeHtml(title) + ' thumbnail">' : "")
      + (duration ? '<span class="video-library-duration">' + escapeHtml(duration) + '</span>' : "")
      + '</div>'
      + '<div class="video-library-body"><b>' + escapeHtml(title) + '</b><span>' + escapeHtml(meta || "Upload") + '</span></div>'
      + '</button>';
  }).join("");

  updateLibrarySelection(selectedVideoId);
}

function readCachedAccessToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(tokenStorageKey) || "null");
    if (saved?.accessToken && saved.uid === currentUser?.uid && saved.expiresAt > Date.now() + 60 * 1000) {
      return saved.accessToken;
    }
  } catch (error) {
    // Fall through and clear bad token cache below.
  }
  localStorage.removeItem(tokenStorageKey);
  return "";
}

function saveCachedAccessToken(accessToken) {
  if (!accessToken || !currentUser) return;
  localStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
}

function clearCachedAccessToken() {
  localStorage.removeItem(tokenStorageKey);
}

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Identity Services could not load."));
    document.head.append(script);
  });

  return googleIdentityScriptPromise;
}

async function requestAccessToken() {
  if (!currentUser) throw new Error("Sign in before generating insights.");
  if (!googleOAuthClientId) throw new Error("Missing Google OAuth client ID. Add your Web OAuth client ID in js/firebase-config.js.");

  await loadGoogleIdentityServices();

  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: googleOAuthClientId,
      scope: scopes.join(" "),
      prompt: "consent select_account",
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        saveCachedAccessToken(response.access_token);
        resolve(response.access_token);
      },
      error_callback: (error) => {
        if (error.type === "popup_closed") {
          reject(new Error("Connection canceled."));
          return;
        }
        reject(new Error(error.message || error.type || "Google authorization failed."));
      }
    });

    tokenClient.requestAccessToken();
  });
}

async function getAccessToken() {
  return readCachedAccessToken() || requestAccessToken();
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`}
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "YouTube API request failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchUploadsPlaylistId(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchJson(url, accessToken);
  const playlistId = payload.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("No uploads playlist was found for your linked channel.");
  return playlistId;
}

async function fetchChannelProfile(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,brandingSettings,topicDetails");
  url.searchParams.set("mine", "true");
  const payload = await fetchJson(url, accessToken);
  const channel = payload.items?.[0];
  if (!channel) return null;

  return {
    id: channel.id || "",
    title: channel.snippet?.title || "",
    description: shortText(channel.snippet?.description || "", 700),
    customUrl: channel.snippet?.customUrl || "",
    country: channel.snippet?.country || "",
    keywords: shortText(channel.brandingSettings?.channel?.keywords || "", 500),
    subscriberCount: numberValue(channel.statistics?.subscriberCount) || 0,
    videoCount: numberValue(channel.statistics?.videoCount) || 0,
    viewCount: numberValue(channel.statistics?.viewCount) || 0,
    topicCategories: channel.topicDetails?.topicCategories || []
  };
}

async function fetchUploadVideoIds(accessToken) {
  const playlistId = await fetchUploadsPlaylistId(accessToken);
  const ids = [];
  let pageToken = "";

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await fetchJson(url, accessToken);
    payload.items?.forEach((item) => {
      const id = item.contentDetails?.videoId;
      if (id) ids.push(id);
    });
    pageToken = payload.nextPageToken || "";
  } while (pageToken && ids.length < 200);

  return ids;
}

async function fetchVideosByIds(videoIds, accessToken) {
  const videos = [];
  for (let index = 0; index < videoIds.length; index += 50) {
    const chunk = videoIds.slice(index, index + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", chunk.join(","));
    const payload = await fetchJson(url, accessToken);
    videos.push(...(payload.items || []));
  }
  return videos;
}

async function fetchChannelVideos(accessToken) {
  const videoIds = await fetchUploadVideoIds(accessToken);
  if (!videoIds.length) return [];
  return fetchVideosByIds(videoIds, accessToken);
}

function channelVideoCategoryIds(videos) {
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

async function fetchMostPopularVideosByCategory(accessToken, categoryId, maxResults = 12) {
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

async function fetchTrendingVideos(accessToken, videos) {
  const categoryIds = channelVideoCategoryIds(videos);
  if (!categoryIds.length) return [];

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

function videoTitleText(videos) {
  return videos.map((video) => video.snippet?.title || "").join(" ").toLowerCase();
}

function countMatches(text, words) {
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

function lane(key, label, seed, primaryCategory, specificCategory = "", confidence = "medium") {
  return {
    key,
    label,
    seed,
    primaryCategory,
    specificCategory,
    confidence
  };
}

function detectedGameTopics(videos) {
  const text = videoTitleText(videos);
  return gameTopicNames
    .map((name) => ({
      name,
      count: text.split(name).length - 1
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
}

function detectChannelLane(videos) {
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

function trendQueriesForLane(lane) {
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

async function searchVideosByQuery(accessToken, query, maxResults = 8) {
  const publishedAfter = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("q", query);
  url.searchParams.set("order", "relevance");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("publishedAfter", publishedAfter);

  const payload = await fetchJson(url, accessToken);
  const ids = (payload.items || [])
    .map((item) => item.id?.videoId)
    .filter(Boolean);
  return ids.length ? fetchVideosByIds(ids, accessToken) : [];
}

async function fetchLaneTrendVideos(accessToken, videos) {
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

async function fetchGeminiTrendVideos(accessToken, trendPlan) {
  if (!trendPlan?.queries?.length) return {lane: null, videos: []};
  const results = await Promise.allSettled(
    trendPlan.queries.slice(0, 4).map((query) => searchVideosByQuery(accessToken, query, 6))
  );
  return {
    lane: trendPlan.lane,
    videos: results.flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .map((video) => ({...video, trendSource: "Gemini trend search"}))
  };
}

async function fetchSimilarTrendVideos(accessToken, videos) {
  const seedVideo = topVideos(videos, 1)[0] || videos[0];
  const seedTitle = seedVideo?.snippet?.title || "";
  const query = titleTopicPhrases(seedTitle)[0] || importantWords(seedTitle).slice(0, 4).join(" ");
  if (!query) return [];

  try {
    const publishedAfter = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("q", query);
    url.searchParams.set("order", "relevance");
    url.searchParams.set("maxResults", "12");
    url.searchParams.set("publishedAfter", publishedAfter);

    const payload = await fetchJson(url, accessToken);
    const ids = (payload.items || [])
      .map((item) => item.id?.videoId)
      .filter(Boolean);
    const foundVideos = ids.length ? await fetchVideosByIds(ids, accessToken) : [];
    return foundVideos.map((video) => ({...video, trendSource: "Similar upload search"}));
  } catch (error) {
    console.warn("Similar trend videos were not available.", error);
    return [];
  }
}

async function fetchTrendReferenceVideos(accessToken, videos, trendPlan = null) {
  const lane = detectChannelLane(videos);
  const [popularResult, similarResult, laneResult] = await Promise.allSettled([
    fetchTrendingVideos(accessToken, videos),
    fetchSimilarTrendVideos(accessToken, videos),
    fetchLaneTrendVideos(accessToken, videos)
  ]);
  const merged = [
    ...(laneResult.status === "fulfilled" ? laneResult.value.videos : []),
    ...(similarResult.status === "fulfilled" ? similarResult.value : []),
    ...(popularResult.status === "fulfilled" ? popularResult.value : [])
  ];
  const seen = new Set();
  const trendVideos = merged.filter((video) => {
    if (!video?.id || seen.has(video.id)) return false;
    seen.add(video.id);
    return true;
  });
  trendVideos.channelLane = trendPlan?.lane || (laneResult.status === "fulfilled" ? laneResult.value.lane : lane);
  trendVideos.trendQueries = trendPlan?.queries || trendQueriesForLane(trendVideos.channelLane);
  return trendVideos;
}

function videoScore(video) {
  const stats = video.statistics || {};
  const views = numberValue(stats.viewCount) || 0;
  const likes = numberValue(stats.likeCount) || 0;
  const comments = numberValue(stats.commentCount) || 0;
  return views + likes * 20 + comments * 40;
}

function isShort(video) {
  const seconds = secondsFromIso(video.contentDetails?.duration);
  return seconds !== null && seconds <= 75;
}

function topVideos(videos, count = 8) {
  return [...videos].sort((a, b) => videoScore(b) - videoScore(a)).slice(0, count);
}

function formatStandardTime(hour) {
  const normalizedHour = ((hour % 24) + 24) % 24;
  const suffix = normalizedHour >= 12 ? "PM" : "AM";
  const displayHour = normalizedHour % 12 || 12;
  return `${displayHour} ${suffix}`;
}

function bestUploadSlot(videos, format = "all") {
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

function recommendedLength(videos, format) {
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

function normalizedTitleWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function importantWords(text) {
  return normalizedTitleWords(text)
    .filter((word) => word.length > 2 && !topicStopWords.has(word));
}

function titleTopicPhrases(text) {
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

function phraseWords(phrase) {
  return importantWords(phrase);
}

function normalizedPhrase(phrase) {
  return phraseWords(phrase).join(" ");
}

function stronglyOverlapsSourceTopic(topic, sourceTopics) {
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

function addTopicScores(scores, video, weight) {
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

function scoredTopicsFromVideos(videos, baseWeight = 1) {
  const scores = new Map();
  videos.forEach((video, index) => {
    addTopicScores(scores, video, Math.max(1, videos.length - index) * baseWeight);
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1]);
}

function topicSignals(videos, trendVideos = [], {preferTrend = false} = {}) {
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

function readableTrendQuery(query = "") {
  return String(query || "")
    .replace(/\b(20\d{2}|19\d{2})\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 40);
}

function currentTrendSignal(videos, trendVideos = []) {
  const sourceTopics = topVideos(videos, 16).flatMap((video) => titleTopicPhrases(video.snippet?.title));
  const trendTopics = scoredTopicsFromVideos(topVideos(trendVideos, 20), 2)
    .map(([topic]) => topic)
    .filter((topic) => !stronglyOverlapsSourceTopic(topic, sourceTopics));
  if (trendTopics.length) return trendTopics[0];

  const query = (trendVideos.trendQueries || [])
    .map(readableTrendQuery)
    .find(Boolean);
  if (query && !stronglyOverlapsSourceTopic(query, sourceTopics)) return query;
  const laneLabel = trendVideos.channelLane?.specificCategory
    || trendVideos.channelLane?.primaryCategory
    || trendVideos.channelLane?.label;
  return laneLabel ? `${laneLabel} trends` : "Current creator trends";
}

function isOwnUploadRestatement(value, videos = []) {
  if (!value) return false;
  const sourceTopics = topVideos(videos, 16).flatMap((video) => titleTopicPhrases(video.snippet?.title));
  return stronglyOverlapsSourceTopic(value, sourceTopics);
}

function buildTopicIdeas(videos, trendVideos) {
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

function buildNextVideoSuggestions(videos, trendVideos) {
  const performance = uploadPerformanceContext(videos);
  const top = performance.topPerformers[0];
  const second = performance.topPerformers[1];
  const under = performance.underPerformers[0];
  const medianViews = compactNumber(performance.medianViews);
  const averageViews = compactNumber(performance.averageViews);
  const trend = currentTrendSignal(videos, trendVideos);
  const trendReference = trendVideos[0]?.snippet?.title || trend;
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
      title: `${category}: trend explainer with a twist`,
      body: top
        ? `Use the hook pattern from your ${compactNumber(top.views)}-view top upload, but apply it to ${trendReference}. Make the promise about why the trend matters now.`
        : `Package ${trendReference} as a clear viewer question, then answer it with your channel's usual style instead of copying the trend format.`,
      label: "Trend"
    },
    {
      title: `${betterFormat} idea: compare the trend to your lane`,
      body: `Your ${betterFormat.toLowerCase()} format averages about ${compactNumber(betterFormatViews)} views. Turn ${trend} into a comparison, ranking, test, or myth-check that fits ${category}.`,
      label: "Format",
      tone: "warn"
    },
    {
      title: "Avoid the weaker angle, keep the stronger promise",
      body: second
        ? `Your strong uploads beat the ${medianViews} median when the idea is easy to understand fast. If ${under?.title || "a past upload"} underperformed, avoid that vague angle and make the next concept instantly searchable.`
        : `Aim above your ${averageViews} average by making the idea specific enough to search and broad enough to connect with ${trend}.`,
      label: "Angle"
    }
  ];
}

function buildChannelSummary(videos, trendVideos, channelProfile = null) {
  const recent = videos.slice(0, 20);
  const longVideos = videos.filter((video) => !isShort(video));
  const shorts = videos.filter(isShort);
  const views = videos.map((video) => numberValue(video.statistics?.viewCount)).filter((value) => value !== null);
  const avgViews = average(views) || 0;
  const best = topVideos(videos, 1)[0];
  const bestViews = numberValue(best?.statistics?.viewCount) || 0;
  const topics = topicSignals(videos, trendVideos, {preferTrend: true});
  const channelLane = trendVideos.channelLane || detectChannelLane(videos);
  const currentTrend = currentTrendSignal(videos, trendVideos);

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
    channelLane,
    channelProfile,
    nextVideoSuggestions: buildNextVideoSuggestions(videos, trendVideos),
    topicIdeas: buildTopicIdeas(videos, trendVideos),
    trendVideos
  };
}

function toneForRatio(value, baseline) {
  if (!baseline || !value) return "warn";
  const ratio = value / baseline;
  if (ratio >= 1.1) return "good";
  if (ratio >= 0.75) return "warn";
  return "bad";
}

function setMetric(index, value, trend = "", trendClass = "") {
  const card = document.querySelectorAll(".metric-card")[index];
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  if (valueEl) valueEl.textContent = value === "" || value === null || value === undefined ? " " : value;
  if (trendEl) {
    trendEl.textContent = trend || " ";
    trendEl.className = ["trend", trendClass].filter(Boolean).join(" ");
  }
}

function updateActivityItems(selector, items) {
  document.querySelectorAll(selector).forEach((item, index) => {
    const insight = items[index] || {title: " ", body: " ", label: " "};
    const timeEl = item.querySelector("time");
    const bodyEl = item.querySelector("span");
    const contentEl = item.querySelector("div");
    const existingToggle = item.querySelector(".read-more-button");
    if (existingToggle) existingToggle.remove();

    item.querySelector("b").textContent = insight.title;
    bodyEl.textContent = insight.body;
    timeEl.textContent = insight.label;
    timeEl.className = ["comparison-badge", insight.tone].filter(Boolean).join(" ");

    item.classList.remove("is-expanded");
    item.classList.add("is-collapsible");
    if (contentEl) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "read-more-button";
      toggle.textContent = "Read more";
      toggle.setAttribute("aria-expanded", "false");
      contentEl.append(toggle);
    }

    requestAnimationFrame(() => updateReadMoreVisibility(item));
  });
}

function updateReadMoreVisibility(item) {
  const bodyEl = item.querySelector("span");
  const toggle = item.querySelector(".read-more-button");
  if (!bodyEl || !toggle || item.classList.contains("is-expanded")) return;

  const isOverflowing = bodyEl.scrollHeight > bodyEl.clientHeight + 1;
  item.classList.toggle("is-collapsible", isOverflowing);
  toggle.hidden = !isOverflowing;
}

function updateRecommendations(items) {
  updateActivityItems(".search-terms-panel .activity-item", items);
}

function updateNextVideoSuggestions(items) {
  updateActivityItems("#nextVideoSuggestions .activity-item", items);
}

function setChatSeedMessage(message = "Hi! I'm your ViewCast assistant. To give you the best advice, should we focus on growing your views, increasing your subscribers, or improving your retention today?") {
  if (!chatMessages) return;
  chatMessages.innerHTML = "";
  chatHistory = [];
  appendChatMessage("assistant", message);
}

function showMissingGeminiKeyMessage() {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  if (insightErrorPanel) insightErrorPanel.hidden = false;
  setStatus("An error has occurred. AI Insights could not be generated right now.");
  setLibraryStatus("AI Insights could not be generated right now.");
}

function showInsightGenerationError() {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  if (insightErrorPanel) insightErrorPanel.hidden = false;
  setStatus("An error has occurred. AI Insights could not be generated right now.");
  setLibraryStatus("AI Insights could not be generated right now.");
}

function hideInsightError() {
  if (insightErrorPanel) insightErrorPanel.hidden = true;
}

function appendChatMessage(role, message, addToHistory = true) {
  if (!chatMessages) return;
  const bubble = document.createElement("div");
  bubble.className = ["chat-message", role].join(" ");
  bubble.textContent = message;
  chatMessages.append(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (addToHistory) {
    const geminiRole = role === "user" ? "user" : "model";
    chatHistory.push({ role: geminiRole, parts: [{ text: message }] });
  }

  return bubble;
}

function compactAdviceSummary(summary) {
  const trendTitle = summary.trendVideos[0]?.snippet?.title || "Similar trend signals unavailable";
  return `I classified this as ${summary.channelLane?.label || "a general creator channel"}. Start with ${summary.topicIdeas[0]?.title || "a direct follow-up"}, post long-form near ${summary.videoUploadTime}, test Shorts near ${summary.shortUploadTime}, aim for ${summary.nextVideoLength} on the next video and ${summary.nextShortLength} on the next Short. Trend reference: ${trendTitle}.`;
}

function channelVideoContext(videos) {
  return videos.slice(0, 12).map((video) => ({
    title: video.snippet?.title || "Untitled video",
    description: shortText(video.snippet?.description || "", 90),
    tags: (video.snippet?.tags || []).slice(0, 4),
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.statistics?.viewCount) || 0,
    likes: numberValue(video.statistics?.likeCount) || 0,
    comments: numberValue(video.statistics?.commentCount) || 0,
    duration: durationFromIso(video.contentDetails?.duration),
    format: isShort(video) ? "Short" : "Video",
    youtubeCategoryId: video.snippet?.categoryId || "",
    youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId)
  }));
}

function uploadPerformanceContext(videos) {
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
    topPerformers: [...mapped].sort((a, b) => b.views - a.views).slice(0, 5),
    underPerformers: [...mapped].sort((a, b) => a.views - b.views).slice(0, 4),
    recentUploads: mapped.slice(0, 6)
  };
}

function compactChannelProfile(profile = {}) {
  return {
    title: profile.title || profile.snippet?.title || "",
    description: shortText(profile.description || profile.snippet?.description || "", 180),
    subscriberCount: profile.subscriberCount || profile.statistics?.subscriberCount || "",
    videoCount: profile.videoCount || profile.statistics?.videoCount || ""
  };
}

function normalizeGeminiTrendPlan(value, fallbackLane) {
  if (!value || typeof value !== "object") return null;
  const rawQueries = Array.isArray(value.queries) ? value.queries : [];
  const queries = rawQueries
    .map((query) => String(query || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!queries.length) return null;

  const primaryCategory = String(value.primaryCategory || value.categoryLabel || fallbackLane.label || "General").slice(0, 60);
  const specificCategory = String(value.specificCategory || value.categorySeed || fallbackLane.seed || primaryCategory).slice(0, 80);
  const categoryLabel = specificCategory && specificCategory.toLowerCase() !== primaryCategory.toLowerCase()
    ? `${primaryCategory} - ${specificCategory}`
    : primaryCategory;

  return {
    lane: {
      key: String(value.categoryKey || primaryCategory.toLowerCase().replace(/\s+/g, "-") || fallbackLane.key || "general").slice(0, 40),
      label: categoryLabel.slice(0, 80),
      seed: specificCategory || queries[0],
      primaryCategory,
      specificCategory,
      confidence: String(value.categoryConfidence || "medium").slice(0, 20)
    },
    queries
  };
}

async function buildGeminiTrendPlan(videos, channelProfile = null) {
  const fallbackLane = detectChannelLane(videos);
  if (!isGeminiAvailable()) {
    return {
      lane: fallbackLane,
      queries: trendQueriesForLane(fallbackLane)
    };
  }

  const prompt = [
    "You are classifying a YouTube channel for ViewCast.",
    "Use the channel profile first, then repeated patterns across uploads, descriptions, tags, YouTube category names, formats, dates, and performance.",
    "Decide the channel's broad category and, when possible, a specific subcategory. Do not classify from one ambiguous word or one outlier upload.",
    "Use clean creator categories. Examples: Music, Gaming, Roblox, Minecraft, Fortnite, Anime, Memes, Sports, Beauty, Education, Tech, Vlogs, Cooking.",
    "If the channel is broad gaming, primaryCategory should be Gaming and specificCategory should be General gaming. If it is mostly Roblox, primaryCategory should be Gaming and specificCategory should be Roblox.",
    "If a channel has music videos, songs, covers, albums, beats, or artist content, classify it as Music. Use a specific subcategory like Rap, Covers, Beats, or Artist edits only when clear.",
    "If the channel mixes memes with another fandom, game, anime, or music niche, classify the primary content type and put the fandom/game/style in specificCategory.",
    "Then choose trend-search queries that match that classification. A Roblox channel should search Roblox-specific topics; a Music channel should search music trends for its style; a meme channel should search meme formats/trends.",
    "Return JSON only with this shape:",
    `{"categoryKey":"","primaryCategory":"","specificCategory":"","categoryLabel":"","categorySeed":"","categoryConfidence":"high","queries":["","",""]}`,
    "",
    "Channel profile:",
    JSON.stringify(channelProfile || {}, null, 2),
    "",
    "Channel uploads:",
    JSON.stringify(channelVideoContext(videos), null, 2)
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
        responseMimeType: "application/json"
      }
    });
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    return normalizeGeminiTrendPlan(safeJsonParse(text), fallbackLane) || {
      lane: fallbackLane,
      queries: trendQueriesForLane(fallbackLane)
    };
  } catch (error) {
    console.warn("Gemini trend plan failed.", error);
    return {
      lane: fallbackLane,
      queries: trendQueriesForLane(fallbackLane)
    };
  }
}

function geminiContext(summary) {
  const trendReferences = summary.trendVideos
    .slice(0, 5)
    .map((video) => ({
      title: video.snippet?.title || "",
      publishedAt: video.snippet?.publishedAt || "",
      views: numberValue(video.statistics?.viewCount) || 0,
      likes: numberValue(video.statistics?.likeCount) || 0,
      comments: numberValue(video.statistics?.commentCount) || 0,
      format: isShort(video) ? "Short" : "Video",
      category: youtubeCategoryName(video.snippet?.categoryId),
      source: video.trendSource || "Trend reference"
    }))
    .filter((video) => video.title);
  const visibleIdeas = summary.geminiInsights?.recommendations || summary.topicIdeas;
  const ideas = visibleIdeas.slice(0, 3).map((idea) => `${idea.title}: ${shortText(idea.body, 120)}`);
  return {
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
    trendQueries: summary.trendVideos.trendQueries || []
  };
}

function geminiPageContext(summary, videos) {
  return {
    ...geminiContext(summary),
    averageViews: Math.round(summary.avgViews || 0),
    bestUploadViews: summary.bestViews || 0,
    uploadPerformance: uploadPerformanceContext(videos)
  };
}

function safeJsonParse(value) {
  const cleaned = String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
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

function normalizeGeminiInsights(value, summary) {
  if (!value || typeof value !== "object") return null;
  const cards = value.cards || {};
  const fallbackIdeas = summary.topicIdeas || [];
  const fallbackSuggestions = summary.nextVideoSuggestions || fallbackIdeas;
  const trendValue = isOwnUploadRestatement(cards.topTopicSignal?.value, summary.recent)
    ? summary.currentTrend
    : cards.topTopicSignal?.value;
  const trendDetail = isOwnUploadRestatement(cards.topTopicSignal?.detail, summary.recent)
    ? summary.channelLane?.label
    : cards.topTopicSignal?.detail;
  const recommendations = Array.isArray(value.recommendations)
    ? value.recommendations.slice(0, 3).map((item, index) => normalizeRecommendation(item, fallbackIdeas[index]))
    : [];
  const nextVideoSuggestions = Array.isArray(value.nextVideoSuggestions)
    ? value.nextVideoSuggestions.slice(0, 3).map((item, index) => normalizeConceptSuggestion(item, fallbackSuggestions[index]))
    : [];

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
        detail: String(trendDetail || "Current YouTube trend").slice(0, 32),
        tone: cards.topTopicSignal?.tone || "good"
      }
    },
    nextVideoSuggestions: nextVideoSuggestions.length ? nextVideoSuggestions : fallbackSuggestions.slice(0, 3),
    recommendations: recommendations.length ? recommendations : fallbackIdeas.slice(0, 3),
    chatIntro: String(value.chatIntro || compactAdviceSummary(summary)).slice(0, 360)
  };
}

async function buildGeminiPageInsights(summary, videos) {
  if (!isGeminiAvailable()) return null;

  const prompt = [
    "You are ViewCast's YouTube strategist. Return compact JSON only.",
    "Use only supplied channel stats, trend references, and upload patterns. Do not invent analytics.",
    "Classify the channel niche from repeated upload patterns, then make every card and suggestion match that niche.",
    "Use 12-hour time like 'Tue 6 PM'. Avoid generic advice such as make a follow-up, post more, extend the video, or improve the hook.",
    "nextVideoSuggestions must be specific new video concepts tied to a high/low performer pattern and an external trend signal.",
    "topTopicSignal must summarize external YouTube trends, not restate this channel's own titles.",
    "JSON shape:",
    `{"cards":{"bestUploadTime":{"value":"","detail":"","tone":"good"},"nextVideoLength":{"value":"","detail":"","tone":"good"},"nextShortLength":{"value":"","detail":"","tone":"warn"},"topTopicSignal":{"value":"","detail":"","tone":"good"}},"nextVideoSuggestions":[{"title":"","body":"","label":"","tone":"good"}],"recommendations":[{"title":"","body":"","label":"","tone":"good"}],"chatIntro":""}`,
    "",
    "Channel data:",
    JSON.stringify(geminiPageContext(summary, videos), null, 2)
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
        maxOutputTokens: 900
      }
    });

    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    return normalizeGeminiInsights(safeJsonParse(text), summary);
  } catch (error) {
    console.warn("Gemini page insights failed.", error);
    if (error.message === "AI_INSIGHTS_RATE_LIMITED" || error.code === "functions/resource-exhausted") {
      throw new Error("AI_INSIGHTS_RATE_LIMITED");
    }
    return null;
  }
}

async function buildGeminiChatReply(question, summary) {
  if (!isGeminiAvailable()) return "An error has occurred. The AI assistant is unavailable right now.";

  const systemInstruction = [
    "You are ViewCast's YouTube channel advice assistant.",
    "Give concise, practical creator advice. Do not invent analytics beyond the provided context.",
    "Use the channel category and trend references to suggest specific next actions.",
    "Keep the answer to 2-4 short sentences.",
    "",
    "Channel context:",
    summary ? JSON.stringify(geminiContext(summary), null, 2) : "No channel data analyzed yet. Ask the user questions to understand their goals and niche."
  ].join("\n");

  try {
    const text = await requestGeminiText({
      contents: chatHistory.slice(-6),
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 420
      }
    });

    return text || "I couldn't generate a response. Please try again.";
  } catch (error) {
    console.error("Gemini advice failed.", error);
    return "I'm having trouble connecting to my brain right now.";
  }
}

function setAnalyzerLoading(isLoading) {
  if (analyzerLoading) analyzerLoading.hidden = !isLoading;
}

function setAnalyzerResultsVisible(isVisible) {
  analyzerDashboard?.classList.toggle("analyzer-results-hidden", !isVisible);
}

function clearAnalyzerResults() {
  latestChannelSummary = null;
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  hideInsightError();
  document.querySelectorAll(".metric-card").forEach((card) => {
    const valueEl = card.querySelector(".metric-value");
    const trendEl = card.querySelector(".trend");
    if (valueEl) valueEl.textContent = " ";
    if (trendEl) {
      trendEl.textContent = " ";
      trendEl.className = "trend";
    }
  });
  document.querySelectorAll(".activity-item").forEach((item) => {
    item.classList.remove("is-collapsible", "is-expanded");
    item.querySelector(".read-more-button")?.remove();
    item.querySelector("b").textContent = " ";
    item.querySelector("span").textContent = " ";
    const timeEl = item.querySelector("time");
    timeEl.textContent = " ";
    timeEl.className = "comparison-badge";
  });
  setChatSeedMessage();
}

function renderChannelInsights(summary) {
  latestChannelSummary = summary;
  const bestTone = toneForRatio(summary.bestViews, summary.avgViews);
  const geminiInsights = summary.geminiInsights;
  const cards = geminiInsights?.cards || {};
  setMetric(
    0,
    cards.bestUploadTime?.value || summary.bestUploadTime,
    cards.bestUploadTime?.detail || "Best performers",
    cards.bestUploadTime?.tone || "good"
  );
  setMetric(
    1,
    cards.nextVideoLength?.value || summary.nextVideoLength,
    cards.nextVideoLength?.detail || summary.videoUploadTime,
    cards.nextVideoLength?.tone || "good"
  );
  setMetric(
    2,
    cards.nextShortLength?.value || summary.nextShortLength,
    cards.nextShortLength?.detail || summary.shortUploadTime,
    cards.nextShortLength?.tone || "warn"
  );
  setMetric(
    3,
    isOwnUploadRestatement(cards.topTopicSignal?.value, summary.recent) ? summary.currentTrend : (cards.topTopicSignal?.value || summary.currentTrend || summary.topSignal),
    cards.topTopicSignal?.detail || "Current YouTube trend",
    cards.topTopicSignal?.tone || bestTone
  );
  updateNextVideoSuggestions(geminiInsights?.nextVideoSuggestions || summary.nextVideoSuggestions);
  updateRecommendations(geminiInsights?.recommendations || summary.topicIdeas);
  setChatSeedMessage(geminiInsights?.chatIntro || compactAdviceSummary(summary));
}

async function loadVideosWithRetry(allowPrompt) {
  let accessToken = readCachedAccessToken();
  if (!accessToken && !allowPrompt) return readCachedVideos();
  accessToken = accessToken || await requestAccessToken();

  try {
    return await fetchChannelVideos(accessToken);
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    clearCachedAccessToken();
    if (!allowPrompt) throw error;
    setLibraryStatus("YouTube access expired. Please approve once to refresh insights.");
    const refreshedToken = await requestAccessToken();
    return fetchChannelVideos(refreshedToken);
  }
}

async function loadVideoLibrary({allowPrompt = false, generateAfterLoad = false} = {}) {
  if (!currentUser) return [];

  const cachedVideos = readCachedVideos();
  if (cachedVideos.length) renderVideoLibrary(cachedVideos);

  if (!readCachedAccessToken() && !allowPrompt) {
    setLibraryStatus(cachedVideos.length ? "Showing saved uploads. Generate insights from saved data or refresh for current data." : "Refresh videos to load uploads from your linked channel.");
    if (generateAfterLoad && cachedVideos.length) await generateChannelInsights({allowPrompt: false});
    return cachedVideos;
  }

  try {
    setLibraryBusy(true);
    setLibraryStatus("Loading uploads from YouTube...");
    const videos = await loadVideosWithRetry(allowPrompt);
    saveCachedVideos(videos);
    renderVideoLibrary(videos);
    setLibraryStatus(videos.length ? "Uploads loaded. Generate insights for your channel." : "No uploads were found on your linked channel.");
    if (generateAfterLoad && videos.length) await generateChannelInsights({allowPrompt});
    return videos;
  } catch (error) {
    console.error("Could not load channel videos.", error);
    setLibraryStatus(error.message || "Could not load videos from YouTube.");
    return cachedVideos;
  } finally {
    setLibraryBusy(false);
  }
}

async function generateChannelInsights({allowPrompt = true, focusVideoId = "", forceRefresh = false} = {}) {
  const connection = localStorage.getItem(connectionStorageKey);
  if (!connection) {
    window.location.href = "channel.html?link=required";
    return;
  }
  if (!isGeminiAvailable()) {
    showMissingGeminiKeyMessage();
    return;
  }

  const requestId = ++analysisRequestId;

  try {
    hideInsightError();
    setBusy(true);
    setAnalyzerResultsVisible(false);
    setAnalyzerLoading(true);
    setStatus(readCachedAccessToken() ? "Analyzing your channel..." : "Requesting YouTube access...");

    let videos = channelVideos.length ? channelVideos : readCachedVideos();
    if (!videos.length) {
      videos = await loadVideoLibrary({allowPrompt});
    }
    if (requestId !== analysisRequestId) return;
    if (!videos.length) throw new Error("Load your channel uploads before generating insights.");

    updateLibrarySelection(focusVideoId);
    const cachedSummary = forceRefresh ? null : readCachedInsights(videos, focusVideoId);
    if (cachedSummary) {
      renderChannelInsights(cachedSummary);
      setAnalyzerLoading(false);
      setAnalyzerResultsVisible(true);
      setStatus("");
      setLibraryStatus("Showing recently generated AI insights.");
      return;
    }

    const accessToken = readCachedAccessToken();
    let channelProfile = null;
    if (accessToken) {
      setStatus("Loading channel profile...");
      try {
        channelProfile = await fetchChannelProfile(accessToken);
      } catch (error) {
        console.warn("Could not load channel profile for Gemini classification.", error);
      }
      if (requestId !== analysisRequestId) return;
    }
    setStatus("Classifying your channel...");
    const trendPlan = await buildGeminiTrendPlan(videos, channelProfile);
    if (requestId !== analysisRequestId) return;
    setStatus("Searching trends chosen by Gemini...");
    const trendVideos = accessToken ? await fetchTrendReferenceVideos(accessToken, videos, trendPlan) : [];
    if (requestId !== analysisRequestId) return;

    const orderedVideos = focusVideoId
      ? [videos.find((video) => video.id === focusVideoId), ...videos.filter((video) => video.id !== focusVideoId)].filter(Boolean)
      : videos;
    const summary = buildChannelSummary(orderedVideos, trendVideos, channelProfile);
    setStatus("Asking Gemini for AI insights...");
    summary.geminiInsights = await buildGeminiPageInsights(summary, orderedVideos);
    if (!summary.geminiInsights) throw new Error("AI_INSIGHTS_GENERATION_FAILED");
    if (requestId !== analysisRequestId) return;
    renderChannelInsights(summary);
    saveCachedInsights(summary, videos, focusVideoId);
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    setStatus("");
    setLibraryStatus(forceRefresh
      ? (focusVideoId ? "Selected-upload insights refreshed." : "Channel-level insights refreshed.")
      : (focusVideoId ? "Insights weighted toward the selected upload." : "Channel-level insights are ready."));
  } catch (error) {
    if (requestId !== analysisRequestId) return;
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(false);
    if (error.message === "Connection canceled.") {
      setStatus("");
      return;
    }
    console.error("Could not generate channel insights.", error);
    if (error.message === "AI_INSIGHTS_RATE_LIMITED") {
      showInsightGenerationError();
      setLibraryStatus("AI Insights usage limit reached. Try again in about a minute.");
    } else if (error.message === "AI_INSIGHTS_GENERATION_FAILED") {
      showInsightGenerationError();
    } else {
      setStatus(error.message || "Could not generate channel insights.");
    }
  } finally {
    if (requestId === analysisRequestId) {
      setAnalyzerLoading(false);
      setBusy(false);
      setRefreshInsightsBusy(false);
    }
  }
}

async function handleGenerateInsights(event) {
  event.preventDefault();
  await generateChannelInsights({allowPrompt: true});
}

async function handleRefreshInsights() {
  setRefreshInsightsBusy(true);
  try {
    await generateChannelInsights({
      allowPrompt: true,
      focusVideoId: selectedVideoId,
      forceRefresh: true
    });
  } finally {
    setRefreshInsightsBusy(false);
  }
}

async function handleChatQuestion(event) {
  event.preventDefault();
  const question = chatInput?.value.trim() || "";
  await sendChatQuestion(question);
}

async function sendChatQuestion(question) {
  if (!question) return;
  appendChatMessage("user", question);
  if (chatInput) chatInput.value = "";
  const thinking = appendChatMessage("assistant", "Thinking...", false);
  if (chatInput) chatInput.disabled = true;

  try {
    const reply = await buildGeminiChatReply(question, latestChannelSummary);
    if (thinking) {
      thinking.textContent = reply;
      const geminiRole = "model";
      chatHistory.push({ role: geminiRole, parts: [{ text: reply }] });
    }
  } catch (error) {
    console.warn("Gemini advice failed.", error);
    if (thinking) {
      thinking.textContent = "I'm having trouble connecting to my brain right now.";
    }
  } finally {
    if (chatInput) {
      chatInput.disabled = false;
      chatInput.focus();
    }
  }
}

function handleReadMoreClick(event) {
  const button = event.target instanceof Element ? event.target.closest(".read-more-button") : null;
  if (!button) return;
  const item = button.closest(".activity-item");
  if (!item) return;
  const isExpanded = item.classList.toggle("is-expanded");
  button.textContent = isExpanded ? "Show less" : "Read more";
  button.setAttribute("aria-expanded", String(isExpanded));
}

clearAnalyzerResults();

if (form && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    selectedVideoId = "";
    clearAnalyzerResults();
    if (!user) {
      channelVideos = [];
      renderVideoLibrary([]);
      setStatus("Sign in before generating AI insights.");
      setLibraryStatus("Sign in and link a channel to generate channel insights.");
      return;
    }

    const cachedVideos = readCachedVideos();
    if (cachedVideos.length) {
      renderVideoLibrary(cachedVideos);
      setLibraryStatus("Showing saved uploads. Generate insights or refresh for current data.");
    } else {
      setLibraryStatus("Loading uploads for channel insights...");
    }
    if (!isGeminiAvailable()) {
      showMissingGeminiKeyMessage();
      return;
    }
    loadVideoLibrary({allowPrompt: false, generateAfterLoad: true});
  });

  form.addEventListener("submit", handleGenerateInsights);
  refreshInsightsButton?.addEventListener("click", handleRefreshInsights);
  chatForm?.addEventListener("submit", handleChatQuestion);
  document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
    button.addEventListener("click", () => sendChatQuestion(button.dataset.chatPrompt || button.textContent.trim()));
  });
  analyzerDashboard?.addEventListener("click", handleReadMoreClick);
  videoLibrary?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest("[data-video-id]");
    if (!card) return;
    generateChannelInsights({allowPrompt: true, focusVideoId: card.dataset.videoId});
  });
  refreshVideosButton?.addEventListener("click", () => loadVideoLibrary({allowPrompt: true, generateAfterLoad: true}));
} else if (form) {
  setStatus("Firebase is not configured yet.");
}
