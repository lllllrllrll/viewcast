const VIDEO_CACHE_PREFIX = "viewcastYouTubeVideos:";
const OVERVIEW_CACHE_PREFIX = "viewcastOverviewData:";
const VIDEO_CACHE_VERSION = 5;

function isLivestream(video = {}) {
  const state = video.snippet?.liveBroadcastContent;
  return Boolean(video.liveStreamingDetails) || state === "live" || state === "upcoming";
}

export function youtubeVideoCacheKey(uid, channelId = "") {
  return uid ? `${VIDEO_CACHE_PREFIX}${uid}:${channelId || "none"}` : "";
}

export function readCachedYouTubeVideos(uid, channelId = "") {
  const preferredKey = youtubeVideoCacheKey(uid, channelId);
  if (!preferredKey) return [];

  const collections = [];
  const userVideoPrefix = `${VIDEO_CACHE_PREFIX}${uid}:`;
  const userOverviewPrefix = `${OVERVIEW_CACHE_PREFIX}${uid}:`;
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index) || "";
    if (key !== preferredKey && !key.startsWith(userVideoPrefix) && !key.startsWith(userOverviewPrefix)) continue;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (Array.isArray(saved?.videos)) collections.push({videos: saved.videos, preferred: key === preferredKey});
    } catch {
      // Ignore one stale cache entry without hiding the remaining uploads.
    }
  }

  collections.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  const seen = new Set();
  return collections.flatMap(({videos}) => videos).filter((video) => {
    if (!video?.id || seen.has(video.id) || isLivestream(video)) return false;
    seen.add(video.id);
    return true;
  });
}

export function saveCachedYouTubeVideos(uid, channelId, videos = []) {
  const key = youtubeVideoCacheKey(uid, channelId);
  if (!key) return;
  sessionStorage.setItem(key, JSON.stringify({
    version: VIDEO_CACHE_VERSION,
    videos: videos.filter((video) => video?.id && !isLivestream(video)),
    savedAt: Date.now()
  }));
}
