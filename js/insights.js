import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
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
const refreshInsightsPageButton = document.getElementById("refreshInsightsPage");
const insightsHeaderActions = document.getElementById("insightsHeaderActions");
const insightRefreshEmpty = document.getElementById("insightRefreshEmpty");
const insightRefreshEmptyContent = document.getElementById("insightRefreshEmptyContent");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");
const insightErrorPanel = document.getElementById("insightErrorPanel");
const insightChannelEmpty = document.getElementById("insightChannelEmpty");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("insightChatForm");
const chatInput = document.getElementById("insightChatInput");
const insightTabs = [...document.querySelectorAll("[data-insights-tab]")];
const insightTabPanels = [...document.querySelectorAll("[data-insights-panel]")];

const tokenStorageKey = "viewcastYouTubeAccessToken";
const connectionStorageKey = "viewcastYouTubeConnection";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";
const insightsStorageKeyPrefix = "viewcastAiInsights:";
const recentTrendsStorageKeyPrefix = "viewcastRecentTrends:";
const channelContextStorageKeyPrefix = "viewcastChannelContext:";
const insightsCacheVersion = 24;
const insightsCacheMaxAge = 6 * 60 * 60 * 1000;

let currentUser = null;
let auth = null;
let db = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let googleIdentityScriptPromise = null;
let latestChannelSummary = null;
let chatHistory = [];
let savedChannelContext = {channelTopic: "", channelContext: ""};

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
    version: insightsCacheVersion,
    focusVideoId,
    channelTopic: savedChannelContext.channelTopic,
    channelContext: savedChannelContext.channelContext,
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

function channelContextStorageKey() {
  return currentUser ? `${channelContextStorageKeyPrefix}${currentUser.uid}` : "";
}

function normalizeSavedChannelContext(value = {}) {
  return {
    channelTopic: String(value.channelTopic || "").trim().slice(0, 120),
    channelContext: String(value.channelContext || "").trim().slice(0, 1000)
  };
}

async function loadSavedChannelContext() {
  savedChannelContext = {channelTopic: "", channelContext: ""};
  const key = channelContextStorageKey();
  if (!key) return savedChannelContext;
  const hasLocalValue = Boolean(localStorage.getItem(key));

  try {
    savedChannelContext = normalizeSavedChannelContext(JSON.parse(localStorage.getItem(key) || "{}"));
  } catch {
    localStorage.removeItem(key);
  }

  if (!db || !currentUser) return savedChannelContext;
  try {
    const snapshot = await getDoc(doc(db, "users", currentUser.uid));
    if (snapshot.exists() && !hasLocalValue) {
      const cloudContext = snapshot.data();
      savedChannelContext = normalizeSavedChannelContext(cloudContext);
      localStorage.setItem(key, JSON.stringify(savedChannelContext));
    }
  } catch (error) {
    console.warn("Could not refresh saved channel context for AI Insights.", error);
  }
  return savedChannelContext;
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
  const savedAt = Date.now();
  localStorage.setItem(key, JSON.stringify({
    fingerprint: insightsFingerprint(videos, focusVideoId),
    summary,
    savedAt
  }));

  const trends = [
    ...(summary.geminiInsights?.validatedTrends || []),
    ...(summary.currentTrends || []),
    ...currentTrendSignals(summary.trendVideos || [])
  ].filter((trend, index, values) => {
    const normalized = String(trend || "").trim().toLowerCase();
    return normalized && values.findIndex(
      (candidate) => String(candidate || "").trim().toLowerCase() === normalized
    ) === index;
  }).slice(0, 4);

  localStorage.setItem(
    `${recentTrendsStorageKeyPrefix}${currentUser.uid}`,
    JSON.stringify({
      trends,
      category: summary.channelLane?.specificCategory ||
        summary.channelLane?.primaryCategory ||
        "Channel trend",
      savedAt
    })
  );
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
  localStorage.removeItem(tokenStorageKey);
  try {
    const saved = JSON.parse(sessionStorage.getItem(tokenStorageKey) || "null");
    if (saved?.accessToken && saved.uid === currentUser?.uid && saved.expiresAt > Date.now() + 60 * 1000) {
      return saved.accessToken;
    }
  } catch (error) {
    // Fall through and clear bad token cache below.
  }
  sessionStorage.removeItem(tokenStorageKey);
  return "";
}

function saveCachedAccessToken(accessToken) {
  if (!accessToken || !currentUser) return;
  sessionStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
}

function clearCachedAccessToken() {
  localStorage.removeItem(tokenStorageKey);
  sessionStorage.removeItem(tokenStorageKey);
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

async function fetchMostPopularVideos(accessToken, maxResults = 50) {
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

async function fetchOutsideCategoryTrends(accessToken) {
  const fallbackCategoryIds = ["20", "10", "17", "24", "28", "27", "23", "1"];
  const results = await Promise.allSettled(
    fallbackCategoryIds.map((categoryId) =>
      fetchMostPopularVideosByCategory(accessToken, categoryId, 6)
    )
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  ).map((video) => ({
    ...video,
    trendSource: "US most popular — expansion category"
  }));
}

async function fetchTrendingVideos(accessToken, videos) {
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

async function searchVideosByQuery(
  accessToken,
  query,
  maxResults = 8,
  maxAgeDays = 30
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
  const recentResults = await Promise.allSettled(
    trendPlan.queries.slice(0, 2).map((query) => searchVideosByQuery(accessToken, query, 8))
  );
  let videos = recentResults.flatMap((result, index) => result.status === "fulfilled"
    ? result.value.map((video) => ({
      ...video,
      trendSource: "Niche YouTube trend search",
      trendQuery: trendPlan.queries[index]
    }))
    : []);

  if (!videos.length) {
    const fallbackResults = await Promise.allSettled(
      trendPlan.queries.slice(0, 2).map(
        (query) => searchVideosByQuery(accessToken, query, 10, 90)
      )
    );
    videos = fallbackResults.flatMap((result, index) => result.status === "fulfilled"
      ? result.value.map((video) => ({
        ...video,
        trendSource: "Expanded niche YouTube trend search",
        trendQuery: trendPlan.queries[index]
      }))
      : []);
  }

  return {
    lane: trendPlan.lane,
    videos
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
  const contextControlsTrends = meaningfulCreatorContextWords().length > 0;
  const ownCategoryIds = new Set(channelVideoCategoryIds(videos));
  const [
    nicheResult,
    popularResult,
    similarResult,
    laneResult,
    outsideResult,
    outsideCategoryResult
  ] = await Promise.allSettled([
    fetchGeminiTrendVideos(accessToken, trendPlan),
    contextControlsTrends ? Promise.resolve([]) : fetchTrendingVideos(accessToken, videos),
    contextControlsTrends ? Promise.resolve([]) : fetchSimilarTrendVideos(accessToken, videos),
    contextControlsTrends ? Promise.resolve({lane: null, videos: []}) : fetchLaneTrendVideos(accessToken, videos),
    fetchMostPopularVideos(accessToken),
    fetchOutsideCategoryTrends(accessToken)
  ]);
  const nicheVideos = nicheResult.status === "fulfilled" ? nicheResult.value.videos : [];
  const merged = [
    ...nicheVideos,
    // The deterministic lane search is the fallback when Gemini's niche searches
    // return nothing, rather than a competing source that can dilute the niche.
    ...(!nicheVideos.length && laneResult.status === "fulfilled" ? laneResult.value.videos : []),
    ...(similarResult.status === "fulfilled" ? similarResult.value : []),
    ...(popularResult.status === "fulfilled" ? popularResult.value : [])
  ];
  const seen = new Set();
  const ownVideoIds = new Set(videos.map((video) => video.id).filter(Boolean));
  let filteredTrendVideos = merged.filter((video) => {
    if (!video?.id || seen.has(video.id) || ownVideoIds.has(video.id)) return false;
    if (contextControlsTrends && !trendMatchesCreatorContext(video)) return false;
    seen.add(video.id);
    return true;
  }).sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));

  if (!filteredTrendVideos.length &&
      nicheVideos.length &&
      contextControlsTrends &&
      trendPlan?.queries?.length) {
    const expandedResults = await Promise.allSettled(
      trendPlan.queries.slice(0, 2).map(
        (query) => searchVideosByQuery(accessToken, query, 10, 90)
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
        trendMatchesCreatorContext(video)
      ))
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  }

  if (!filteredTrendVideos.length) {
    const categoryFallback = await fetchTrendingVideos(accessToken, videos);
    filteredTrendVideos = categoryFallback
      .filter((video, index, values) => (
        video?.id &&
        !ownVideoIds.has(video.id) &&
        values.findIndex((candidate) => candidate.id === video.id) === index
      ))
      .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a));
  }

  const trendVideos = diversifyTrendVideos(filteredTrendVideos, trendPlan?.queries || []);
  trendVideos.channelLane = trendPlan?.lane
    || (nicheResult.status === "fulfilled" ? nicheResult.value.lane : null)
    || (laneResult.status === "fulfilled" ? laneResult.value.lane : lane);
  trendVideos.trendQueries = trendPlan?.queries || trendQueriesForLane(trendVideos.channelLane);
  trendVideos.contentInterpretations = trendPlan?.contentInterpretations || [];
  const outsideCandidates = [
    ...(outsideResult.status === "fulfilled" ? outsideResult.value : []),
    ...(outsideCategoryResult.status === "fulfilled"
      ? outsideCategoryResult.value
      : [])
  ];
  trendVideos.outsideTrendVideos = selectOutsideTopicTrends(
    outsideCandidates,
    ownVideoIds,
    ownCategoryIds,
    trendPlan?.expansionCategoryIds || []
  );
  trendVideos.globalTrendVideos = selectGlobalPopularTrends(
    outsideCandidates
  );
  return trendVideos;
}

function videoScore(video) {
  const stats = video.statistics || {};
  const views = numberValue(stats.viewCount) || 0;
  const likes = numberValue(stats.likeCount) || 0;
  const comments = numberValue(stats.commentCount) || 0;
  return views + likes * 20 + comments * 40;
}

function trendAgeDays(video) {
  const publishedAt = new Date(video.snippet?.publishedAt || "").getTime();
  if (!Number.isFinite(publishedAt)) return 999;
  return Math.max(1, (Date.now() - publishedAt) / (24 * 60 * 60 * 1000));
}

function trendMomentumScore(video) {
  const views = numberValue(video.statistics?.viewCount) || 0;
  const likes = numberValue(video.statistics?.likeCount) || 0;
  const comments = numberValue(video.statistics?.commentCount) || 0;
  const ageDays = trendAgeDays(video);
  const dailyViews = views / ageDays;
  const engagementRate = views ? (likes + comments * 2) / views : 0;
  const nicheBoost = /niche YouTube trend search$/.test(video.trendSource || "") ? 1.35 : 1;
  return dailyViews * (1 + Math.min(engagementRate * 20, 1.5)) * nicheBoost;
}

function meaningfulCreatorContextWords() {
  const genericContextWords = new Set([
    "channel", "creator", "content", "youtube", "uploads", "audience",
    "topic", "niche", "page", "account"
  ]);
  return importantWords(
    `${savedChannelContext.channelTopic} ${savedChannelContext.channelContext}`
  ).filter((word) => !genericContextWords.has(word));
}

function trendMatchesCreatorContext(video) {
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

function outsideContextBridgeMultiplier(video) {
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

function outsideTrendRank(video) {
  return trendMomentumScore(video) * outsideContextBridgeMultiplier(video);
}

function trendTitlesOverlap(first, second) {
  const firstWords = new Set(importantWords(first?.snippet?.title || ""));
  const secondWords = new Set(importantWords(second?.snippet?.title || ""));
  if (!firstWords.size || !secondWords.size) return false;
  const shared = [...firstWords].filter((word) => secondWords.has(word)).length;
  return shared / Math.min(firstWords.size, secondWords.size) >= 0.6;
}

function diversifyTrendVideos(videos, queries = []) {
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

function selectOutsideTopicTrends(
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

function selectGlobalPopularTrends(videos = []) {
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

function trendEvidence(video) {
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
    .replace(/\b(youtube|trending|trend|trends|viral|current|latest)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 40);
}

function trendReferenceText(trendVideos = []) {
  return [
    ...(trendVideos.trendQueries || []),
    ...trendVideos
      .filter((video) => /niche YouTube trend search$/.test(video.trendSource || ""))
      .slice(0, 20)
      .map((video) => video.snippet?.title || "")
  ].join(" ");
}

function isGroundedTrendLabel(value, trendVideos = []) {
  const labelWords = importantWords(value);
  if (labelWords.length < 2 || labelWords.length > 6) return false;
  const referenceWords = new Set(importantWords(trendReferenceText(trendVideos)));
  const matchingWords = labelWords.filter((word) => referenceWords.has(word)).length;
  return matchingWords >= Math.min(2, labelWords.length);
}

function currentTrendSignals(trendVideos = []) {
  const externalSignals = trendVideos
    .slice(0, 3)
    .map((video) => shortText(video.snippet?.title || "", 56))
    .filter(Boolean);
  const uniqueSignals = [...new Set(externalSignals.map((signal) => signal.toLowerCase()))]
    .map((signal) => externalSignals.find((candidate) => candidate.toLowerCase() === signal))
    .slice(0, 3);
  return uniqueSignals;
}

function currentTrendSignal(videos, trendVideos = []) {
  return currentTrendSignals(trendVideos)[0];
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

function buildCrossoverTrendSuggestions(summary) {
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

function creatorContextLabel(summary) {
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

function effectiveExpansionTrendVideos(summary) {
  const ownCategoryIds = new Set(channelVideoCategoryIds(summary.recent || []));
  const combined = [
    ...(summary.outsideTrendVideos || []),
    ...(summary.trendVideos || []).filter((video) => {
      const categoryId = String(video.snippet?.categoryId || "");
      return categoryId && !ownCategoryIds.has(categoryId);
    })
  ];
  return combined
    .filter((video, index, values) => (
      video?.id &&
      values.findIndex((candidate) => candidate.id === video.id) === index
    ))
    .sort((a, b) => trendMomentumScore(b) - trendMomentumScore(a))
    .slice(0, 3);
}

function expansionTrendFallbacks(summary) {
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

function crossoverFallbacks(summary) {
  const channelCategory = summary.channelLane?.specificCategory ||
    summary.channelLane?.primaryCategory ||
    summary.channelLane?.label ||
    "your audience";
  const performance = uploadPerformanceContext(summary.recent || []);
  const preferredFormat = performance.shortAverageViews >
    performance.videoAverageViews ? "Short" : "video";
  const contextLabel = creatorContextLabel(summary);
  return expansionTrendFallbacks(summary).map((trend) => ({
    title: `${trend.category} crossover for ${channelCategory}`,
    body: `Use the “${trend.title}” format as a ${preferredFormat} for ${contextLabel}. Keep ${trend.category} as the main subject, but introduce it through the pacing, humor, expertise, or viewer problem your ${channelCategory} audience already recognizes. Test one pilot and compare its click-through and retention with your channel median before making a series.`,
    label: "Targeted crossover",
    tone: "good"
  }));
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

function setTrendMetric(values = [], detail = "", trendClass = "good") {
  const card = document.querySelector(".insights-trends-card");
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  const trends = values.filter(Boolean).slice(0, 3);

  if (valueEl) {
    valueEl.textContent = "";
    const list = document.createElement("ol");
    list.className = "youtube-trend-list";
    trends.forEach((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      list.append(item);
    });
    valueEl.append(list);
  }
  if (trendEl) {
    trendEl.textContent = detail || "Niche trends";
    trendEl.className = ["trend", trendClass].filter(Boolean).join(" ");
  }
}

function updateActivityItems(selector, items, relatedVideoGroups = []) {
  document.querySelectorAll(selector).forEach((item, index) => {
    const hasInsight = Boolean(items[index]);
    item.hidden = !hasInsight;
    const insight = items[index] || {title: " ", body: " ", label: " "};
    const timeEl = item.querySelector("time");
    const bodyEl = item.querySelector("span");
    const contentEl = item.querySelector("div");
    const existingToggle = item.querySelector(".read-more-button");
    const existingExamples = item.querySelector(".trend-video-examples");
    if (existingToggle) existingToggle.remove();
    if (existingExamples) existingExamples.remove();

    item.querySelector("b").textContent = insight.title;
    bodyEl.textContent = insight.body;
    timeEl.textContent = insight.label;
    timeEl.className = ["comparison-badge", insight.tone].filter(Boolean).join(" ");

    item.classList.remove("is-expanded");
    item.classList.add("is-collapsible");
    if (contentEl) {
      const relatedVideos = relatedVideoGroups[index] || [];
      if (relatedVideos.length) {
        const examples = document.createElement("div");
        examples.className = "trend-video-examples";
        const heading = document.createElement("small");
        heading.textContent = "Videos from other creators";
        examples.append(heading);

        relatedVideos.slice(0, 3).forEach((video) => {
          const link = document.createElement("a");
          link.className = "trend-video-example";
          link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";

          const thumbnail = bestThumbnail(video.snippet?.thumbnails);
          if (thumbnail) {
            const image = document.createElement("img");
            image.src = thumbnail;
            image.alt = "";
            image.loading = "lazy";
            link.append(image);
          }

          const title = document.createElement("span");
          title.textContent = video.snippet?.title || "Watch on YouTube";
          link.append(title);
          examples.append(link);
        });
        contentEl.append(examples);
      }

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

function relatedVideosForSuggestions(items = [], trendVideos = []) {
  return items.map((item, index) => {
    if (!/trend/i.test(item?.label || "")) return [];
    const suggestionText = `${item.title || ""} ${item.body || ""}`.toLowerCase();
    const referencedVideo = trendVideos.find((video) => {
      const title = String(video.snippet?.title || "").trim().toLowerCase();
      return title && suggestionText.includes(title);
    }) || trendVideos[index];
    if (!referencedVideo) return [];

    const sameQuery = trendVideos.filter((video) => (
      video.trendQuery
      && video.trendQuery === referencedVideo.trendQuery
      && video.id !== referencedVideo.id
    ));
    return [referencedVideo, ...sameQuery]
      .filter((video, videoIndex, values) => values.findIndex((candidate) => candidate.id === video.id) === videoIndex)
      .slice(0, 3);
  });
}

function updateNextVideoSuggestions(items, trendVideos = []) {
  updateActivityItems(
    "#nextVideoSuggestions .activity-item",
    items,
    relatedVideosForSuggestions(items, trendVideos)
  );
}

function updateOutsideTopicTrends(videos = [], summary = {}) {
  const contextLabel = creatorContextLabel(summary);
  const items = videos.slice(0, 3).map((video) => {
    const evidence = trendEvidence(video);
    const category = youtubeCategoryName(video.snippet?.categoryId) || "Popular video";
    const format = isShort(video) ? "Short" : "video";
    return {
      title: evidence?.title || "Popular YouTube video",
      body: `${category} · ${evidence?.publishedLabel || "Recently published"} · ${compactNumber(evidence?.views || 0)} views · about ${compactNumber(evidence?.viewsPerDay || 0)} views per day. For ${contextLabel}, study this ${format}'s opening promise, pacing, thumbnail hierarchy, and payoff, then adapt those mechanics to the channel's existing voice and viewer expectations.`,
      label: "Outside your topic",
      tone: "warn"
    };
  });

  expansionTrendFallbacks(summary).forEach((fallback) => {
    if (items.length < 3) items.push(fallback);
  });
  updateActivityItems("#outsideTopicTrends .activity-item", items);
}

function updateCrossoverTrends(items = [], outsideTrendVideos = []) {
  const relatedVideos = items.map((item, index) => {
    const text = `${item?.title || ""} ${item?.body || ""}`.toLowerCase();
    const referencedVideo = outsideTrendVideos.find((video) => {
      const title = String(video.snippet?.title || "").trim().toLowerCase();
      return title && text.includes(title);
    }) || outsideTrendVideos[index];
    return referencedVideo ? [referencedVideo] : [];
  });
  updateActivityItems("#targetedCrossoverTrends .activity-item", items, relatedVideos);
}

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
    ? `${topic} ${category} videos`
    : `${topic} videos`;
}

function buildPlatformTrendGroups(videos = []) {
  const recent = videos
    .filter((video, index, values) => (
      video?.id &&
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
    .filter((video) => video?.id && trendAgeDays(video) <= 30)
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
    body: `${group.videoCount ? `${group.videoCount} recent videos across ${group.channelCount} channels · ` : ""}${compactNumber(group.averageViewsPerDay)} average views per day · ${group.engagementRate.toFixed(1)}% engagement · ${group.searchMomentum}. Metrics use videos published during the past 30 days.`,
    label,
    tone: "good"
  }));
}

function opportunityGroups(platformGroups = [], nicheGroups = []) {
  const contextWords = new Set(meaningfulCreatorContextWords());
  const nicheWords = new Set(nicheGroups.flatMap((group) =>
    importantWords(group.title || "")
  ));
  const outsideGroups = platformGroups.filter((group) => {
    const words = importantWords(group.title || "");
    const contextOverlap = words.filter((word) => contextWords.has(word)).length;
    const nicheOverlap = words.filter((word) => nicheWords.has(word)).length;
    return contextOverlap === 0 && nicheOverlap < Math.max(1, words.length / 2);
  });
  return [...outsideGroups, ...platformGroups]
    .filter((group, index, groups) =>
      groups.findIndex((candidate) => candidate.title === group.title) === index
    )
    .slice(0, 3);
}

function opportunityItems(groups, summary) {
  const contextLabel = creatorContextLabel(summary);
  const performance = uploadPerformanceContext(summary.recent || []);
  const preferredFormat = performance.shortAverageViews >
    performance.videoAverageViews ? "Short" : "video";
  const strategies = [
    {
      angle: `Turn the outside trend into a challenge governed by ${contextLabel} rules`,
      concept: `I Tried ${groupTitlePlaceholder(0)} Using Only ${contextLabel} Rules`,
      execution: "Open with the final result, state one constraint in the first 15 seconds, and let the familiar channel expertise drive the experiment."
    },
    {
      angle: `Translate the outside trend for a ${contextLabel} audience`,
      concept: `What ${contextLabel} Creators Can Learn From ${groupTitlePlaceholder(1)}`,
      execution: "Show one recognizable example, identify three transferable techniques, and demonstrate one of them inside the channel’s normal format."
    },
    {
      angle: `Let viewers decide how the outside trend enters ${contextLabel}`,
      concept: `${groupTitlePlaceholder(2)}, Rebuilt for ${contextLabel} Viewers`,
      execution: "Offer two crossover directions through a poll or comments, create the winning version, and use the audience decision as the hook for a follow-up."
    }
  ];
  return groups.map((group, index) => {
    const strategy = strategies[index] || strategies[0];
    const trendName = group.title.replace(/\s+videos$/i, "");
    const concept = strategy.concept.replace(
      groupTitlePlaceholder(index),
      trendName
    );
    return {
      title: strategy.angle,
      body: `Suggested video: “${concept}.” How to bridge it: ${strategy.execution} Keep roughly 70% of the video grounded in ${contextLabel} and use the remaining 30% to test ${trendName}. If click-through and retention beat the channel median, develop it into a series. Evidence: ${compactNumber(group.averageViewsPerDay)} views per day across ${group.channelCount || group.videos.length} channels.`,
      label: "Crossover playbook",
      tone: "warn"
    };
  });
}

function groupTitlePlaceholder(index) {
  return `__OUTSIDE_TREND_${index}__`;
}

function trendSectionFallbackItems(type, summary) {
  const contextLabel = creatorContextLabel(summary);
  if (type === "platform") {
    return [
      {
        title: "Gaming releases and challenge formats",
        body: "Track new releases, major updates, and creator challenges gaining several high-velocity uploads during the 30-day window.",
        label: "Platform signal",
        tone: "warn"
      },
      {
        title: "Music releases and performance formats",
        body: "Watch release reactions, live performances, remixes, and process videos with fast views-per-day growth and strong engagement.",
        label: "Platform signal",
        tone: "warn"
      },
      {
        title: "Sports and entertainment event reactions",
        body: "Monitor time-sensitive reactions, predictions, and breakdowns published around major events and announcements.",
        label: "Platform signal",
        tone: "warn"
      }
    ];
  }
  if (type === "niche") {
    return [
      {
        title: `${contextLabel}: new releases and announcements`,
        body: `Monitor fresh videos about releases, updates, or news directly connected to ${contextLabel}.`,
        label: "Niche watchlist",
        tone: "warn"
      },
      {
        title: `${contextLabel}: comparisons and ranked choices`,
        body: `Look for repeated A-versus-B, ranking, review, and “best option” formats within ${contextLabel}.`,
        label: "Niche watchlist",
        tone: "warn"
      },
      {
        title: `${contextLabel}: challenges and reaction formats`,
        body: `Track challenge, experiment, reaction, and transformation videos that are appearing across multiple ${contextLabel} creators.`,
        label: "Niche watchlist",
        tone: "warn"
      }
    ];
  }
  return [
    {
      title: `Bring challenge storytelling into ${contextLabel}`,
      body: `Suggested video: “I Tried My Hardest ${contextLabel} Goal With One Major Constraint.” Open with the result, explain the rule in the first 15 seconds, and build toward a measurable payoff. Treat this as a 70% familiar, 30% exploratory pilot.`,
      label: "Crossover opportunity",
      tone: "warn"
    },
    {
      title: `Use documentary-style transformation in ${contextLabel}`,
      body: `Suggested video: “I Changed My ${contextLabel} Process for 30 Days—Here’s What Happened.” Establish the before state, show two setbacks, and make the final comparison visible instead of delivering only an explanation.`,
      label: "Crossover opportunity",
      tone: "warn"
    },
    {
      title: `Add audience participation to ${contextLabel}`,
      body: `Suggested video: “My Viewers Control My Next ${contextLabel} Project.” Use a poll, submissions, bracket, or comment-driven decision, then show how the winning choice changes the outcome and tees up a follow-up video.`,
      label: "Crossover opportunity",
      tone: "warn"
    }
  ];
}

function renderTrendSections(summary) {
  const platformGroups = buildPlatformTrendGroups(summary.globalTrendVideos || []);
  const nicheGroups = buildTrendGroups(summary.trendVideos || []);
  const crossoverGroups = opportunityGroups(platformGroups, nicheGroups);
  const platformItems = platformGroups.length
    ? trendGroupItems(platformGroups, "Platform-wide")
    : trendSectionFallbackItems("platform", summary);
  const nicheItems = nicheGroups.length
    ? trendGroupItems(nicheGroups, "Your niche")
    : trendSectionFallbackItems("niche", summary);
  const opportunities = crossoverGroups.length
    ? opportunityItems(crossoverGroups, summary)
    : trendSectionFallbackItems("opportunities", summary);
  updateActivityItems(
    "#platformWideTrends .activity-item",
    platformItems,
    platformGroups.map((group) => group.videos)
  );
  updateActivityItems(
    "#nicheTrends .activity-item",
    nicheItems,
    nicheGroups.map((group) => group.videos)
  );
  updateActivityItems(
    "#trendOpportunities .activity-item",
    opportunities,
    crossoverGroups.map((group) => group.videos)
  );
}

function hasLiveTrendResults(summary) {
  return buildPlatformTrendGroups(summary?.globalTrendVideos || []).length > 0 &&
    buildTrendGroups(summary?.trendVideos || []).length > 0;
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
  setRefreshButtonPlacement(true, insightErrorPanel?.querySelector(".insight-error-content"));
  setStatus("An error has occurred. AI Insights could not be generated right now.");
  setLibraryStatus("AI Insights could not be generated right now.");
}

function showInsightGenerationError() {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  if (insightErrorPanel) insightErrorPanel.hidden = false;
  setRefreshButtonPlacement(true, insightErrorPanel?.querySelector(".insight-error-content"));
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
    contentInterpretations,
    expansionCategoryIds
  };
}

async function buildGeminiTrendPlan(videos, channelProfile = null) {
  const fallbackLane = detectChannelLane(videos);
  if (!isGeminiAvailable()) {
    return {
      lane: fallbackLane,
      queries: trendQueriesForLane(fallbackLane),
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  }

  const prompt = [
    "You are classifying a YouTube channel for ViewCast.",
    "Use the creator-provided topic and context first, then the channel profile and repeated patterns across uploads, descriptions, tags, YouTube category names, formats, dates, and performance.",
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
    "When creator-provided context exists, ignore resolved upload media references while choosing queries and use only that creator context. Each query must contain at least one meaningful term written in the creator context.",
    "Also choose exactly 5 expansionCategoryIds for popular trends outside the current topic. Choose from Film & Animation=1, Music=10, Sports=17, Gaming=20, Comedy=23, Entertainment=24, Education=27, and Science & Technology=28.",
    "The expansion categories must remain outside the creator's current topic, but they must offer a credible bridge to the audience interests, tone, skills, goals, or presentation style explicitly described in creator-provided context. Rank the strongest bridge first.",
    "Return JSON only with this shape. No trailing commas:",
    `{"categoryKey":"","primaryCategory":"","specificCategory":"","categoryLabel":"","categorySeed":"","categoryConfidence":"high","contentInterpretations":[{"title":"","mediaReferences":[""],"premise":"","audienceAppeal":"","confidence":"high"}],"queries":["","","",""],"expansionCategoryIds":["","","","",""]}`,
    "",
    "Channel profile:",
    JSON.stringify(channelProfile || {}),
    "",
    "Creator-provided channel topic and context (use this as the primary niche guidance):",
    JSON.stringify(savedChannelContext),
    "",
    "Channel uploads:",
    JSON.stringify(channelVideoContext(videos))
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
        maxOutputTokens: 1800
      }
    });
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    return normalizeGeminiTrendPlan(safeJsonParse(text), fallbackLane) || {
      lane: fallbackLane,
      queries: trendQueriesForLane(fallbackLane),
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  } catch (error) {
    console.warn("Gemini trend plan failed.", error);
    return {
      lane: fallbackLane,
      queries: trendQueriesForLane(fallbackLane),
      contentInterpretations: [],
      expansionCategoryIds: []
    };
  }
}

function geminiContext(summary) {
  const trendReferences = summary.trendVideos
    .slice(0, 8)
    .map((video) => ({
      ...trendEvidence(video),
      likes: numberValue(video.statistics?.likeCount) || 0,
      comments: numberValue(video.statistics?.commentCount) || 0,
      format: isShort(video) ? "Short" : "Video",
      category: youtubeCategoryName(video.snippet?.categoryId),
    }))
    .filter((video) => video.title);
  const outsideTrendReferences = (summary.outsideTrendVideos || [])
    .slice(0, 6)
    .map((video) => ({
      ...trendEvidence(video),
      category: youtubeCategoryName(video.snippet?.categoryId) || "Popular video",
      format: isShort(video) ? "Short" : "Video"
    }))
    .filter((video) => video.title);
  const visibleIdeas = summary.geminiInsights?.recommendations || summary.topicIdeas;
  const ideas = visibleIdeas.slice(0, 3).map((idea) => `${idea.title}: ${shortText(idea.body, 120)}`);
  return {
    creatorProvidedContext: summary.creatorProvidedContext || savedChannelContext,
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
    outsideTrendReferences,
    trendQueries: summary.trendVideos.trendQueries || [],
    contentInterpretations: summary.contentInterpretations || []
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
  const outsideTitles = (summary.outsideTrendVideos || [])
    .map((video) => String(video.snippet?.title || "").trim())
    .filter(Boolean);
  const fallbacks = buildCrossoverTrendSuggestions(summary);
  const normalized = (Array.isArray(items) ? items : [])
    .filter((item) => {
      const text = `${item?.title || ""} ${item?.body || ""}`.toLowerCase();
      return outsideTitles.some((title) => text.includes(title.toLowerCase()));
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

function normalizeGeminiInsights(value, summary) {
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
  const trendDetail = `${summary.channelLane?.specificCategory
    || summary.channelLane?.primaryCategory
    || summary.channelLane?.label
    || "Niche"} on YouTube`;
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
    validatedTrends,
    crossoverTrends,
    nextVideoSuggestions,
    recommendations,
    chatIntro: String(value.chatIntro || compactAdviceSummary(summary)).slice(0, 360)
  };
}

async function buildGeminiPageInsights(summary, videos) {
  if (!isGeminiAvailable()) return null;

  const prompt = [
    "You are ViewCast's YouTube strategist. Return compact JSON only. No trailing commas.",
    "Use only supplied channel stats, trend references, and upload patterns. Do not invent analytics.",
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
    "Every word in topTopicSignal.value must be supported by the supplied external YouTube trend references or trend queries. Do not invent a trend.",
    "Review every trendReference for semantic relevance to creatorProvidedContext and present-day usefulness. Reject videos that only share a broad category word, discuss an old event/topic despite being newly uploaded, are archival/reuploads, or do not help this specific creator.",
    "Return validatedTrends as up to 3 exact, character-for-character title strings copied from distinct accepted trendReferences. Use fewer than 3 when fewer are genuinely current and relevant; never fill space with a weak match.",
    "Use only references included in validatedTrends for trend-grounded nextVideoSuggestions. If fewer than 2 references pass, replace the unsupported trend suggestion with channel-data advice instead of using a rejected reference.",
    "Return exactly 3 crossoverTrends using outsideTrendReferences. Each must keep the outside subject as the primary topic while connecting it to this channel's audience perspective, strongest format, presentation style, or creator expertise.",
    "Every crossover trend must name its exact outside reference, explain why the existing audience could enter it, and use the label 'Targeted crossover'. Do not turn the outside subject into another video about the existing channel topic.",
    "JSON shape:",
    `{"cards":{"bestUploadTime":{"value":"","detail":"","tone":"good"},"nextVideoLength":{"value":"","detail":"","tone":"good"},"nextShortLength":{"value":"","detail":"","tone":"warn"},"topTopicSignal":{"value":"","detail":"","tone":"good"}},"validatedTrends":["","",""],"nextVideoSuggestions":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"crossoverTrends":[{"title":"","body":"","label":"Targeted crossover","tone":"good"},{"title":"","body":"","label":"Targeted crossover","tone":"good"},{"title":"","body":"","label":"Targeted crossover","tone":"good"}],"recommendations":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"chatIntro":""}`,
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
        maxOutputTokens: 1600
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
    summary ? JSON.stringify(geminiContext(summary)) : "No channel data analyzed yet. Ask the user questions to understand their goals and niche."
  ].join("\n");

  try {
    const text = await requestGeminiText({
      contents: chatHistory.slice(-6),
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 240
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
  if (isLoading) setRefreshButtonPlacement(false);
}

function setAnalyzerResultsVisible(isVisible) {
  analyzerDashboard?.classList.toggle("analyzer-results-hidden", !isVisible);
  setRefreshButtonPlacement(!isVisible);
}

function activateInsightsTab(tabName, {focus = false} = {}) {
  const activeName = tabName === "trends" ? "trends" : "analysis";
  insightTabs.forEach((tab) => {
    const isActive = tab.dataset.insightsTab === activeName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    if (isActive && focus) tab.focus();
  });
  insightTabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.insightsPanel !== activeName;
  });
}

function handleInsightsTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const currentIndex = Math.max(0, insightTabs.indexOf(event.currentTarget));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? insightTabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + insightTabs.length) % insightTabs.length;
  activateInsightsTab(insightTabs[nextIndex]?.dataset.insightsTab, {focus: true});
}

function setRefreshButtonPlacement(centered, target = insightRefreshEmptyContent) {
  if (!refreshInsightsPageButton) return;
  const destination = centered ? target : insightsHeaderActions;
  if (destination && refreshInsightsPageButton.parentElement !== destination) {
    destination.append(refreshInsightsPageButton);
  }
  if (insightRefreshEmpty) {
    insightRefreshEmpty.hidden = !centered || destination !== insightRefreshEmptyContent;
  }
}

function hasLinkedChannel() {
  try {
    const connection = JSON.parse(localStorage.getItem(connectionStorageKey) || "null");
    return Boolean(connection?.channel?.id);
  } catch (error) {
    return false;
  }
}

function showChannelLinkPrompt(show) {
  if (insightChannelEmpty) insightChannelEmpty.hidden = !show;
  if (show) {
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(false);
    setRefreshButtonPlacement(false);
  }
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
  const geminiInsights = summary.geminiInsights
    ? normalizeGeminiInsights(summary.geminiInsights, summary)
    : null;
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
  updateRecommendations(geminiInsights?.recommendations || summary.topicIdeas);
  renderTrendSections(summary);
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
  if (!hasLinkedChannel()) {
    showChannelLinkPrompt(true);
    return;
  }
  showChannelLinkPrompt(false);
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

    let accessToken = readCachedAccessToken();
    if (!accessToken && allowPrompt) {
      setStatus("YouTube access is required to search current trends...");
      accessToken = await requestAccessToken();
      if (requestId !== analysisRequestId) return;
    }
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
    let trendVideos = accessToken
      ? await fetchTrendReferenceVideos(accessToken, videos, trendPlan)
      : [];
    if (accessToken &&
        !trendVideos.length &&
        !trendVideos.outsideTrendVideos?.length &&
        allowPrompt) {
      clearCachedAccessToken();
      setStatus("Renewing YouTube access to load current trends...");
      accessToken = await requestAccessToken();
      if (requestId !== analysisRequestId) return;
      trendVideos = await fetchTrendReferenceVideos(
        accessToken,
        videos,
        trendPlan
      );
    }
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
    if (trendVideos.length && trendVideos.outsideTrendVideos?.length) {
      saveCachedInsights(summary, videos, focusVideoId);
    }
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
    }
  }
}

async function handleGenerateInsights(event) {
  event.preventDefault();
  await generateChannelInsights({allowPrompt: true});
}

function handleRefreshInsightsPage() {
  window.location.reload();
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
activateInsightsTab("analysis");

if (form && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, async (user) => {
    let refreshedUser = user;
    if (user) {
      try {
        await user.reload();
        refreshedUser = auth.currentUser || user;
      } catch (error) {
        console.warn("Could not refresh email verification status for AI Insights.", error);
      }
    }

    currentUser = refreshedUser?.emailVerified ? refreshedUser : null;
    selectedVideoId = "";
    clearAnalyzerResults();

    if (!hasLinkedChannel()) {
      showChannelLinkPrompt(true);
      return;
    }
    showChannelLinkPrompt(false);

    if (!currentUser) {
      channelVideos = [];
      renderVideoLibrary([]);
      setStatus(refreshedUser ? "Verify your email before generating AI insights." : "Sign in before generating AI insights.");
      setLibraryStatus(refreshedUser ? "Verify your email to unlock channel insights." : "Sign in and link a channel to generate channel insights.");
      return;
    }

    await loadSavedChannelContext();

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
  refreshInsightsPageButton?.addEventListener("click", handleRefreshInsightsPage);
  chatForm?.addEventListener("submit", handleChatQuestion);
  document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
    button.addEventListener("click", () => sendChatQuestion(button.dataset.chatPrompt || button.textContent.trim()));
  });
  analyzerDashboard?.addEventListener("click", handleReadMoreClick);
  insightTabs.forEach((tab) => {
    tab.addEventListener("click", async () => {
      const tabName = tab.dataset.insightsTab;
      activateInsightsTab(tabName);
      if (tabName === "trends" &&
          currentUser &&
          hasLinkedChannel() &&
          !hasLiveTrendResults(latestChannelSummary)) {
        await generateChannelInsights({
          allowPrompt: true,
          forceRefresh: true
        });
        activateInsightsTab("trends");
      }
    });
    tab.addEventListener("keydown", handleInsightsTabKeydown);
  });
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
