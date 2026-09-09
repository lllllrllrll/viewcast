import {doc, getDoc} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {activeYouTubeChannelId} from "./youtube-session.js?v=1";

const connectionKey = "viewcastYouTubeConnection";
const connectionsKey = "viewcastYouTubeAllConnections";
const channelKey = "viewcastYouTubeChannel";
const cacheVersion = 37;
const maxAge = 24 * 60 * 60 * 1000;

function normalizeContext(value = {}) {
  return {
    channelTopic: String(value.channelTopic || "").trim().slice(0, 120),
    channelContext: String(value.channelContext || "").trim().slice(0, 1000)
  };
}

function restoreConnections(profile = {}) {
  const cloud = Array.isArray(profile.youtubeConnections)
    ? profile.youtubeConnections.filter((item) => item?.channel?.id) : [];
  const connections = cloud.length ? cloud : (profile.youtubeConnection?.channel?.id ? [profile.youtubeConnection] : []);
  if (!connections.length) return;
  let active;
  try {
    const cachedId = JSON.parse(localStorage.getItem(connectionKey) || "null")?.channel?.id;
    active = connections.find((item) => item.channel.id === cachedId) || connections[0];
  } catch {
    active = connections[0];
  }
  localStorage.setItem(connectionsKey, JSON.stringify(connections));
  localStorage.setItem(connectionKey, JSON.stringify(active));
  localStorage.setItem(channelKey, JSON.stringify(active.channel));
}

export function createInsightsCache({getUser, getDb, setCreatorContext, currentTrendSignals}) {
  let context = normalizeContext();
  const contextKey = () => getUser() ? `viewcastChannelContext:${getUser().uid}` : "";
  const storageKey = (focusId = "") => getUser()
    ? `viewcastAiInsights:${getUser().uid}:${activeYouTubeChannelId() || "none"}:${focusId || "channel"}` : "";
  const fingerprint = (videos, focusId = "") => JSON.stringify({
    version: cacheVersion, focusVideoId: focusId, ...context,
    videos: videos.slice(0, 40).map((video) => ({
      id: video.id, publishedAt: video.snippet?.publishedAt || "", title: video.snippet?.title || "",
      views: video.ownerAnalytics?.views ?? "", likes: video.ownerAnalytics?.likes ?? "",
      comments: video.ownerAnalytics?.comments ?? "", watchMinutes: video.ownerAnalytics?.estimatedMinutesWatched ?? "",
      averageViewPercentage: video.ownerAnalytics?.averageViewPercentage ?? ""
    }))
  });

  async function loadContext() {
    context = normalizeContext();
    setCreatorContext(context);
    const key = contextKey();
    if (!key) return context;
    const hasLocal = Boolean(sessionStorage.getItem(key));
    try {
      context = normalizeContext(JSON.parse(sessionStorage.getItem(key) || "{}"));
      setCreatorContext(context);
    } catch { sessionStorage.removeItem(key); }
    if (!getDb() || !getUser()) return context;
    try {
      const snapshot = await getDoc(doc(getDb(), "users", getUser().uid));
      if (snapshot.exists()) {
        const profile = snapshot.data();
        restoreConnections(profile);
        if (!hasLocal) {
          context = normalizeContext(profile);
          setCreatorContext(context);
          sessionStorage.setItem(key, JSON.stringify(context));
        }
      }
    } catch (error) { console.warn("Could not refresh saved channel context for AI Insights.", error); }
    return context;
  }

  function read(videos, focusId = "") {
    const key = storageKey(focusId);
    if (!key) return null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (!saved?.summary || saved.fingerprint !== fingerprint(videos, focusId)) return null;
      if (Date.now() - saved.savedAt <= maxAge) return saved.summary;
      sessionStorage.removeItem(key);
    } catch { sessionStorage.removeItem(key); }
    return null;
  }

  function save(summary, videos, focusId = "") {
    const key = storageKey(focusId);
    if (!key || !summary) return;
    const savedAt = Date.now();
    sessionStorage.setItem(key, JSON.stringify({fingerprint: fingerprint(videos, focusId), summary, savedAt}));
    const trends = [...(summary.geminiInsights?.validatedTrends || []), ...(summary.currentTrends || []),
      ...currentTrendSignals(summary.trendVideos || [])].filter((trend, index, values) => {
      const normalized = String(trend || "").trim().toLowerCase();
      return normalized && values.findIndex((item) => String(item || "").trim().toLowerCase() === normalized) === index;
    }).slice(0, 4);
    localStorage.setItem(`viewcastRecentTrends:${getUser().uid}:${activeYouTubeChannelId() || "none"}`, JSON.stringify({
      trends, category: summary.channelLane?.specificCategory || summary.channelLane?.primaryCategory || "Channel trend", savedAt
    }));
  }
  return {fingerprint, loadContext, read, save};
}
