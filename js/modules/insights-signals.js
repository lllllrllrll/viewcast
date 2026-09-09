import {shortText} from "../insights-format.js?v=1";
import {addTopicScores, importantWords, normalizedTitleWords, stronglyOverlapsSourceTopic, titleTopicPhrases} from "./insights-topic-language.js?v=1";
import {topVideos} from "./insights-performance.js?v=1";

export function scoredTopicsFromVideos(videos, baseWeight = 1) {
  const scores = new Map();
  videos.forEach((video, index) => {
    addTopicScores(scores, video, Math.max(1, videos.length - index) * baseWeight);
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1]);
}

export function topicSignals(videos, trendVideos = [], {preferTrend = false} = {}) {
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

export function readableTrendQuery(query = "") {
  return String(query || "")
    .replace(/\b(20\d{2}|19\d{2})\b/g, "")
    .replace(/\b(youtube|trending|trend|trends|viral|current|latest)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 40);
}

export function trendReferenceText(trendVideos = []) {
  return [
    ...(trendVideos.trendQueries || []),
    ...trendVideos
      .filter((video) => /niche YouTube trend search$/.test(video.trendSource || ""))
      .slice(0, 20)
      .map((video) => video.snippet?.title || "")
  ].join(" ");
}

export function isGroundedTrendLabel(value, trendVideos = []) {
  const labelWords = importantWords(value);
  if (labelWords.length < 2 || labelWords.length > 6) return false;
  const labelWordSet = new Set(normalizedTitleWords(value));
  const resemblesSourceTitle = trendVideos.some((video) => {
    const titleWords = new Set(normalizedTitleWords(video.snippet?.title || ""));
    if (!labelWordSet.size || !titleWords.size) return false;
    const shared = [...labelWordSet].filter((word) => titleWords.has(word)).length;
    return shared / Math.min(labelWordSet.size, titleWords.size) >= 0.85 &&
      Math.abs(labelWordSet.size - titleWords.size) <= 2;
  });
  if (resemblesSourceTitle) return false;
  const referenceWords = new Set(importantWords(trendReferenceText(trendVideos)));
  const matchingWords = labelWords.filter((word) => referenceWords.has(word)).length;
  return matchingWords >= Math.min(2, labelWords.length);
}

export function currentTrendSignals(trendVideos = []) {
  const externalSignals = trendVideos
    .slice(0, 3)
    .map((video) => {
      const searchTopic = readableTrendQuery(video.trendQuery || "");
      if (searchTopic) return searchTopic;
      const centralPhrase = titleTopicPhrases(video.snippet?.title || "")[0] || "";
      return shortText(centralPhrase, 56);
    })
    .filter(Boolean);
  const uniqueSignals = [...new Set(externalSignals.map((signal) => signal.toLowerCase()))]
    .map((signal) => externalSignals.find((candidate) => candidate.toLowerCase() === signal))
    .slice(0, 3);
  return uniqueSignals;
}

export function currentTrendSignal(videos, trendVideos = []) {
  return currentTrendSignals(trendVideos)[0];
}
