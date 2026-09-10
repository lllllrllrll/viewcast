import {addNotifications} from "../../components/notifications.js";

export function notifyVideoAnalysisComplete(video, geminiAnalysis) {
  const href = `pages/analyzer.html?video=${encodeURIComponent(video.id)}`;
  const timelineNotifications = (geminiAnalysis?.timelineInterestPoints || [])
    .slice(0, 2)
    .map((point, index) => ({
      id: `video:${video.id}:point:${index}:${point.timestamp}`,
      title: `${point.timestamp} · ${point.title}`,
      message: point.suggestion,
      href,
      tone: point.severity === "high" ? "rose" : "amber"
    }));

  addNotifications([
    {
      id: `video:${video.id}:complete`,
      title: "Video analysis ready",
      message: video.snippet?.title || "Your selected video has new recommendations.",
      href,
      tone: "teal"
    },
    ...timelineNotifications
  ]);
}
