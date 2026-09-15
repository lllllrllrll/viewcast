import {isGeminiAvailable, requestGeminiContent} from "../gemini-client.js?v=9";
import {parseJsonObject} from "../services/json.js?v=1";
import {
  durationFromIso,
  durationFromSeconds,
  numberValue,
  secondsFromIso,
  shortText,
  youtubeCategoryName
} from "../insights-format.js?v=1";

function percent(value) {
  const number = numberValue(value);
  return number === null ? "" : `${Math.round(number * 10) / 10}%`;
}

export function retentionDipContext(retentionPoints, video, maxDips = 4) {
  const durationSeconds = secondsFromIso(video?.contentDetails?.duration) || 0;
  if (retentionPoints.length < 2) return [];
  // Compare short windows rather than only adjacent samples so gradual but
  // meaningful audience losses are surfaced alongside sharp single-point dips.
  const windowSize = Math.max(1, Math.round(retentionPoints.length * 0.03));
  const candidates = retentionPoints
    .slice(windowSize)
    .map((point, index) => {
      const previous = retentionPoints[index];
      const drop = previous.ratio - point.ratio;
      const positionPercent = Math.round(point.position * 100);
      const phase = positionPercent <= 15
        ? "Hook / intro"
        : positionPercent >= 85 ? "Ending / CTA" : "Main content";
      return {
        time: durationSeconds ? durationFromSeconds(point.position * durationSeconds) : `${Math.round(point.position * 100)}%`,
        startTime: durationSeconds ? durationFromSeconds(previous.position * durationSeconds) : `${Math.round(previous.position * 100)}%`,
        positionPercent,
        phase,
        fromPercent: Math.round(previous.ratio * 100),
        toPercent: Math.round(point.ratio * 100),
        dropPoints: Math.round(drop * 100),
        windowSeconds: durationSeconds ? Math.max(1, Math.round((point.position - previous.position) * durationSeconds)) : null
      };
    })
    .filter((dip) => dip.dropPoints >= 2)
    .sort((a, b) => b.dropPoints - a.dropPoints);

  const selected = [];
  for (const dip of candidates) {
    const overlapsExisting = selected.some((item) => Math.abs(item.positionPercent - dip.positionPercent) < 4);
    if (!overlapsExisting) selected.push(dip);
    if (selected.length >= maxDips) break;
  }
  return selected.map((dip, index) => ({...dip, rank: index + 1}));
}

function channelVideoContext(videos) {
  return videos.slice(0, 6).map((video) => ({
    id: video.id || "",
    title: video.snippet?.title || "Untitled video",
    publishedAt: video.snippet?.publishedAt || "",
    views: numberValue(video.ownerAnalytics?.views) || 0,
    likes: numberValue(video.ownerAnalytics?.likes) || 0,
    comments: numberValue(video.ownerAnalytics?.comments) || 0,
    analyticsPeriod: video.ownerAnalytics?.periodLabel || "90D",
    duration: durationFromIso(video.contentDetails?.duration),
    youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId)
  }));
}

function videoAnalysisContext(video, analytics, retentionPoints, searchTerms, channelProfile, videos) {
  const durationSeconds = secondsFromIso(video.contentDetails?.duration) || 0;
  const views = videos.map((item) => numberValue(item.ownerAnalytics?.views)).filter((value) => value !== null);
  const averageViews = views.length ? Math.round(views.reduce((sum, value) => sum + value, 0) / views.length) : 0;
  const retentionSamples = retentionPoints
    .filter((_, index) => index % Math.max(1, Math.floor(retentionPoints.length / 5)) === 0)
    .slice(0, 5)
    .map((point) => ({
      time: durationSeconds ? durationFromSeconds(point.position * durationSeconds) : `${Math.round(point.position * 100)}%`,
      retentionPercent: Math.round(point.ratio * 100)
    }));
  const retentionDips = retentionDipContext(retentionPoints, video);

  return {
    channelProfile: {
      title: channelProfile?.title || channelProfile?.snippet?.title || "",
      description: shortText(channelProfile?.description || channelProfile?.snippet?.description || "", 120)
    },
    selectedVideo: {
      id: video.id || "",
      title: video.snippet?.title || "Untitled video",
      description: shortText(video.snippet?.description || "", 140),
      tags: (video.snippet?.tags || []).slice(0, 4),
      publishedAt: video.snippet?.publishedAt || "",
      duration: durationFromIso(video.contentDetails?.duration),
      youtubeCategoryName: youtubeCategoryName(video.snippet?.categoryId),
      privateAnalytics: analytics ? {
        period: analytics.periodLabel || "Analytics API",
        views: Number(analytics.views) || 0,
        likes: Number(analytics.likes) || 0,
        comments: Number(analytics.comments) || 0,
        shares: Number(analytics.shares) || 0,
        subscribersGained: Number(analytics.subscribersGained) || 0,
        subscribersLost: Number(analytics.subscribersLost) || 0,
        averageViewDuration: durationFromSeconds(analytics.averageViewDuration),
        averageViewPercentage: percent(analytics.averageViewPercentage),
        estimatedMinutesWatched: Math.round(analytics.estimatedMinutesWatched || 0)
      } : null,
      retentionSamples,
      retentionDips,
      youtubeSearchTerms: searchTerms.slice(0, 3).map((term) => ({
        term: term.term,
        views: term.views,
        period: term.periodLabel
      }))
    },
    channelComparison: {
      averageViews,
      recentUploads: channelVideoContext(videos)
    }
  };
}

function normalizeGeminiVideoAnalysis(value) {
  if (!value || typeof value !== "object") return null;
  const labels = value.metricLabels || {};
  const edits = Array.isArray(value.recommendedEdits)
    ? value.recommendedEdits.slice(0, 5).map((item) => ({
      segment: String(item.segment || "Overall").slice(0, 40),
      issue: String(item.issue || "Opportunity").slice(0, 80),
      recommendation: String(item.recommendation || "Make one clear improvement based on the supplied analytics.").slice(0, 220),
      impact: String(item.impact || "AI").slice(0, 32)
    }))
    : [];
  const timeline = Array.isArray(value.timelineInterestPoints)
    ? value.timelineInterestPoints.slice(0, 8).map((item) => ({
      timestamp: String(item.timestamp || "0:00").slice(0, 12),
      title: String(item.title || item.issue || "Improvement opportunity").slice(0, 90),
      suggestion: String(item.suggestion || item.recommendation || "Tighten this moment to keep viewers engaged.").slice(0, 260),
      severity: ["high", "medium", "low"].includes(String(item.severity).toLowerCase()) ? String(item.severity).toLowerCase() : "medium"
    }))
    : [];

  return {
    metricLabels: {
      views: String(labels.views || "Gemini").slice(0, 18),
      likes: String(labels.likes || "Gemini").slice(0, 18),
      comments: String(labels.comments || "Gemini").slice(0, 18),
      averageViewDuration: String(labels.averageViewDuration || "Gemini").slice(0, 18)
    },
    recommendedEdits: edits,
    timelineInterestPoints: timeline
  };
}

export async function buildGeminiVideoAnalysis({video, analytics, retentionPoints, searchTerms, channelProfile, videos}) {
  if (!isGeminiAvailable()) return null;

  const prompt = [
    "You are ViewCast's YouTube video analyst. Return compact JSON only.",
    "Inspect the attached public YouTube video directly, then combine what you observe with the supplied private analytics, retention samples, search terms, and compact channel comparison.",
    "Metric labels must be short: Above avg, Needs lift, Strong, Watch drop, or Unavailable.",
    "Prioritize retentionDips by dropPoints. For each major dip, cite its timestamp and measured change, label causes as hypotheses, and give a concrete edit.",
    "Use practical fixes: shorten/rewrite the intro, move payoff earlier, cut repetition, add pattern interrupts, add chapter/card/pinned-comment recovery, tighten title-thumbnail promise, or make a follow-up/Shorts cutdown.",
    "If retention samples exist but retentionDips is empty, explicitly say there was no significant 2+ point drop in the sampled curve. If retention data is absent, say it is unavailable.",
    "Create timelineInterestPoints for the major retention drops before adding other opportunities. Use exact timestamps and include the measured before-to-after percentages in each title or suggestion.",
    "Return JSON only with this shape:",
    `{"metricLabels":{"views":"","likes":"","comments":"","averageViewDuration":""},"recommendedEdits":[{"segment":"","issue":"","recommendation":"","impact":""}],"timelineInterestPoints":[{"timestamp":"0:00","title":"","suggestion":"","severity":"high|medium|low"}]}`,
    "",
    "Video and channel data:",
    JSON.stringify(videoAnalysisContext(video, analytics, retentionPoints, searchTerms, channelProfile, videos))
  ].join("\n");

  try {
    const payload = await requestGeminiContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: `https://www.youtube.com/watch?v=${video.id}`,
                mimeType: "video/*"
              }
            },
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 420
      }
    });
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    return normalizeGeminiVideoAnalysis(parseJsonObject(text));
  } catch (error) {
    if (error.code === "plan/basic-feature-limit-reached") throw error;
    console.warn("Gemini video analysis failed.", error);
    return null;
  }
}
