import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured, googleOAuthClientId } from "./firebase-config.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const form = document.getElementById("videoAnalysisForm");
const submitButton = form?.querySelector('button[type="submit"]');
const videoLibrary = document.getElementById("videoLibrary");
const videoLibraryStatus = document.getElementById("videoLibraryStatus");
const refreshVideosButton = document.getElementById("refreshVideos");
const analyzerDashboard = document.getElementById("analyzerDashboard");
const analyzerLoading = document.getElementById("analyzerLoading");

const tokenStorageKey = "viewcastYouTubeAccessToken";
const connectionStorageKey = "viewcastYouTubeConnection";
const videosStorageKeyPrefix = "viewcastYouTubeVideos:";

let currentUser = null;
let auth = null;
let channelVideos = [];
let selectedVideoId = "";
let analysisRequestId = 0;
let googleIdentityScriptPromise = null;

function setStatus(message) {
  let status = document.getElementById("videoAnalysisStatus");
  if (!status && form) {
    status = document.createElement("span");
    status.id = "videoAnalysisStatus";
    status.className = "analysis-status";
    form.append(status);
  }
  if (status) status.textContent = message || "";
}

function setBusy(isBusy, label = "Generate Insights") {
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

async function fetchTrendingVideos(accessToken, videos) {
  const categoryCounts = new Map();
  videos.forEach((video) => {
    const categoryId = video.snippet?.categoryId;
    if (!categoryId) return;
    categoryCounts.set(categoryId, (categoryCounts.get(categoryId) || 0) + 1);
  });
  const categoryId = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  if (!categoryId) return [];

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("chart", "mostPopular");
    url.searchParams.set("regionCode", "US");
    url.searchParams.set("maxResults", "12");
    url.searchParams.set("videoCategoryId", categoryId);
    const payload = await fetchJson(url, accessToken);
    return payload.items || [];
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

  if (memeScore >= 2 && memeScore >= gamingScore) {
    return {
      key: "memes",
      label: "Meme channel",
      seed: games[0]?.name || importantWords(text).slice(0, 2).join(" ")
    };
  }

  if (games.length >= 2) {
    return {
      key: "general-gaming",
      label: "General gaming channel",
      seed: games.slice(0, 3).map((game) => game.name).join(" ")
    };
  }

  if (games.length === 1 || gamingScore >= 2) {
    return {
      key: "specific-game",
      label: games[0]?.name ? `${games[0].name} channel` : "Game-specific channel",
      seed: games[0]?.name || titleTopicPhrases(topVideos(videos, 1)[0]?.snippet?.title || "")[0] || "video game"
    };
  }

  if (animeScore >= 2) {
    return {
      key: "anime",
      label: "Anime channel",
      seed: importantWords(text).slice(0, 3).join(" ") || "anime"
    };
  }

  return {
    key: "general",
    label: "General creator channel",
    seed: titleTopicPhrases(topVideos(videos, 1)[0]?.snippet?.title || "")[0] || importantWords(text).slice(0, 3).join(" ")
  };
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
  return {lane, videos: videosByQuery};
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
    return ids.length ? fetchVideosByIds(ids, accessToken) : [];
  } catch (error) {
    console.warn("Similar trend videos were not available.", error);
    return [];
  }
}

async function fetchTrendReferenceVideos(accessToken, videos) {
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
  trendVideos.channelLane = laneResult.status === "fulfilled" ? laneResult.value.lane : lane;
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
    const key = `${day} ${String(slotHour % 24).padStart(2, "0")}:00`;
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

function buildChannelSummary(videos, trendVideos) {
  const recent = videos.slice(0, 20);
  const longVideos = videos.filter((video) => !isShort(video));
  const shorts = videos.filter(isShort);
  const views = videos.map((video) => numberValue(video.statistics?.viewCount)).filter((value) => value !== null);
  const avgViews = average(views) || 0;
  const best = topVideos(videos, 1)[0];
  const bestViews = numberValue(best?.statistics?.viewCount) || 0;
  const topics = topicSignals(videos, trendVideos, {preferTrend: true});
  const channelLane = trendVideos.channelLane || detectChannelLane(videos);

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
    topSignal: topics[0] || "More uploads",
    channelLane,
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

function drawPerformanceMix(videos) {
  if (typeof drawLineChart !== "function") return;
  const recent = [...videos].slice(0, 10).reverse();
  const values = recent.map((video) => numberValue(video.statistics?.viewCount) || 0);
  const labels = recent.map((video, index) => {
    const title = video.snippet?.title || `Upload ${index + 1}`;
    return title.length > 14 ? title.slice(0, 13) + "..." : title;
  });
  drawLineChart("retentionChart", values, values, labels, {ySuffix: ""});
}

function updateRecommendations(items) {
  document.querySelectorAll(".activity-item").forEach((item, index) => {
    const insight = items[index] || {title: " ", body: " ", label: " "};
    const timeEl = item.querySelector("time");
    item.querySelector("b").textContent = insight.title;
    item.querySelector("span").textContent = insight.body;
    timeEl.textContent = insight.label;
    timeEl.className = ["comparison-badge", insight.tone].filter(Boolean).join(" ");
  });
}

function updateTable(summary) {
  const tbody = document.querySelector("table tbody");
  if (!tbody) return;
  const trendTitle = summary.trendVideos[0]?.snippet?.title || "Similar trend signals unavailable";
  const rows = [
    ["Channel category", "Detected from your upload titles", summary.channelLane?.label || "General creator channel", "Context"],
    ["Upload timing", "Strong uploads cluster around this slot", `Post the next video near ${summary.videoUploadTime}; test Shorts near ${summary.shortUploadTime}.`, "Schedule"],
    ["Video length", "Your stronger long-form upload durations set the range", `Aim for ${summary.nextVideoLength} unless the topic needs more depth.`, "Format"],
    ["Short length", "Your strongest short-form durations set the range", `Aim for ${summary.nextShortLength} with the payoff in the opening seconds.`, "Format"],
    ["Topic direction", "High-performing titles and trend titles overlap", summary.topicIdeas[0]?.title || "Make a direct follow-up", "Idea"],
    ["Trend context", "Similar videos and current popular videos", trendTitle, summary.trendVideos.length ? "Live signal" : "Limited"]
  ];

  tbody.innerHTML = rows.map(([area, signal, recommendation, impact]) => `
    <tr>
      <td>${escapeHtml(area)}</td>
      <td>${escapeHtml(signal)}</td>
      <td>${escapeHtml(recommendation)}</td>
      <td><span class="trend ${impact === "Limited" ? "warn" : "good"}">${escapeHtml(impact)}</span></td>
    </tr>
  `).join("");
}

function setAnalyzerLoading(isLoading) {
  if (analyzerLoading) analyzerLoading.hidden = !isLoading;
}

function setAnalyzerResultsVisible(isVisible) {
  analyzerDashboard?.classList.toggle("analyzer-results-hidden", !isVisible);
}

function clearAnalyzerResults() {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
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
    item.querySelector("b").textContent = " ";
    item.querySelector("span").textContent = " ";
    const timeEl = item.querySelector("time");
    timeEl.textContent = " ";
    timeEl.className = "comparison-badge";
  });
  const tbody = document.querySelector("table tbody");
  if (tbody) {
    tbody.innerHTML = Array.from({length: 3}, () => "<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>").join("");
  }
  if (typeof drawLineChart === "function") drawLineChart("retentionChart", [], [], []);
}

function renderChannelInsights(summary) {
  const bestTone = toneForRatio(summary.bestViews, summary.avgViews);
  setMetric(0, summary.bestUploadTime, "Best performers", "good");
  setMetric(1, summary.nextVideoLength, summary.videoUploadTime, "good");
  setMetric(2, summary.nextShortLength, summary.shortUploadTime, "warn");
  setMetric(3, summary.topSignal, summary.channelLane?.label || (summary.bestViews ? `${compactNumber(summary.bestViews)} top views` : "Signal"), bestTone);
  updateRecommendations(summary.topicIdeas);
  updateTable(summary);
  drawPerformanceMix(summary.recent);
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

async function generateChannelInsights({allowPrompt = true, focusVideoId = ""} = {}) {
  const connection = localStorage.getItem(connectionStorageKey);
  if (!connection) {
    window.location.href = "channel.html?link=required";
    return;
  }

  const requestId = ++analysisRequestId;

  try {
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
    const accessToken = readCachedAccessToken();
    const trendVideos = accessToken ? await fetchTrendReferenceVideos(accessToken, videos) : [];
    if (requestId !== analysisRequestId) return;

    const orderedVideos = focusVideoId
      ? [videos.find((video) => video.id === focusVideoId), ...videos.filter((video) => video.id !== focusVideoId)].filter(Boolean)
      : videos;
    const summary = buildChannelSummary(orderedVideos, trendVideos);
    renderChannelInsights(summary);
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(true);
    setStatus(trendVideos.length
      ? "Channel insights generated from your uploads and similar trend signals."
      : "Channel insights generated from your uploads. Similar trend signals were unavailable.");
    setLibraryStatus(focusVideoId ? "Insights weighted toward the selected upload." : "Channel-level insights are ready.");
  } catch (error) {
    if (requestId !== analysisRequestId) return;
    setAnalyzerLoading(false);
    setAnalyzerResultsVisible(false);
    if (error.message === "Connection canceled.") {
      setStatus("");
      return;
    }
    console.error("Could not generate channel insights.", error);
    setStatus(error.message || "Could not generate channel insights.");
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
    loadVideoLibrary({allowPrompt: false});
  });

  form.addEventListener("submit", handleGenerateInsights);
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
