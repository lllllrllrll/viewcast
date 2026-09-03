const prefix = "viewcastGeminiVideoAnalysis:";
const maxAge = 24 * 60 * 60 * 1000;

function fingerprint(video, analytics, retentionPoints, searchTerms) {
  return JSON.stringify({
    analysisVersion: 4,
    id: video.id || "",
    views: analytics?.views ?? "",
    likes: analytics?.likes ?? "",
    comments: analytics?.comments ?? "",
    period: analytics?.periodLabel || "",
    averageViewDuration: analytics?.averageViewDuration || "",
    averageViewPercentage: analytics?.averageViewPercentage || "",
    retention: retentionPoints.slice(0, 12).map((point) => [point.position, point.ratio]),
    searchTerms: searchTerms.slice(0, 5).map((term) => [term.term, term.views])
  });
}

export function createVideoAnalysisCache(getCurrentUser) {
  const storageKey = (videoId) => {
    const user = getCurrentUser();
    return user && videoId ? `${prefix}${user.uid}:${videoId}` : "";
  };

  function read(video, analytics, retentionPoints, searchTerms) {
    const key = storageKey(video.id);
    if (!key) return null;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved?.analysis || saved.fingerprint !== fingerprint(video, analytics, retentionPoints, searchTerms)) return null;
      if (Date.now() - saved.savedAt > maxAge) {
        localStorage.removeItem(key);
        return null;
      }
      return saved.analysis;
    } catch {
      localStorage.removeItem(key);
      return null;
    }
  }

  function save(video, analytics, retentionPoints, searchTerms, analysis) {
    const key = storageKey(video.id);
    if (!key || !analysis) return;
    localStorage.setItem(key, JSON.stringify({
      fingerprint: fingerprint(video, analytics, retentionPoints, searchTerms),
      analysis,
      savedAt: Date.now()
    }));
  }

  return {read, save};
}
