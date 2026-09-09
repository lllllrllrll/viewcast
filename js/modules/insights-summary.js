import {average, numberValue} from "../insights-format.js?v=1";
import {getCreatorContext} from "../services/insights-creator-context.js?v=1";
import {detectChannelLane} from "./insights-lane.js?v=1";
import {bestUploadSlot, isShort, recommendedLength, topVideos} from "./insights-performance.js?v=1";
import {currentTrendSignals, topicSignals} from "./insights-signals.js?v=1";
import {buildNextVideoSuggestions, buildTopicIdeas} from "./insights-suggestions.js?v=1";

export function buildChannelSummary(videos, trendVideos, channelProfile = null) {
  const recent = videos.slice(0, 20);
  const longVideos = videos.filter((video) => !isShort(video));
  const shorts = videos.filter(isShort);
  const views = videos.map((video) => numberValue(video.ownerAnalytics?.views)).filter((value) => value !== null);
  const avgViews = average(views) || 0;
  const best = topVideos(videos, 1)[0];
  const bestViews = numberValue(best?.ownerAnalytics?.views) || 0;
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
    analyticsSource: "youtube-studio",
    analyticsPeriod: videos[0]?.ownerAnalytics?.periodLabel || "90D",
    creatorProvidedContext: getCreatorContext(),
    nextVideoSuggestions: buildNextVideoSuggestions(videos, trendVideos),
    topicIdeas: buildTopicIdeas(videos, trendVideos),
    trendVideos
  };
}
