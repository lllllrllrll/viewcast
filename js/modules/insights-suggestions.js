import {compactNumber, shortText} from "../insights-format.js?v=1";
import {getCreatorContext} from "../services/insights-creator-context.js?v=1";
import {topVideos, trendEvidence, uploadPerformanceContext} from "./insights-performance.js?v=1";
import {meaningfulCreatorContextWords} from "./insights-trend-selection.js?v=1";
import {currentTrendSignal, topicSignals} from "./insights-signals.js?v=1";

export function buildTopicIdeas(videos, trendVideos) {
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

export function buildNextVideoSuggestions(videos, trendVideos) {
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

export function buildCrossoverTrendSuggestions(summary) {
  const category = summary.channelLane?.specificCategory
    || summary.channelLane?.primaryCategory
    || summary.channelLane?.label
    || "your current audience";
  const contextLabel = creatorContextLabel(summary);

  return (summary.trendVideos || []).slice(0, 3).map((video, index) => {
    const evidence = trendEvidence(video);
    const dailyViews = compactNumber(evidence?.viewsPerDay || 0);
    const approaches = [
      "turn its viewer question into a fast test with the result shown first",
      "adapt its core tension into a concise comparison with a clear winner",
      "use its audience interest for a myth-check, reaction, or ranked takeaway"
    ];
    return {
      title: `${contextLabel} Short inspired by: ${shortText(evidence?.title || "current topic trend", 72)}`,
      body: `${evidence?.title || "This same-topic video"} is drawing about ${dailyViews} views per day. Create an original Short for ${category}: ${approaches[index] || approaches[0]}. Use the reference as demand evidence, not as a concept to copy.`,
      label: "Relevant opportunity",
      tone: "good"
    };
  });
}

export function creatorContextLabel(summary) {
  const supplied = summary.creatorProvidedContext || getCreatorContext();
  return shortText(
    supplied?.channelTopic ||
    supplied?.channelContext ||
    summary.channelLane?.specificCategory ||
    summary.channelLane?.primaryCategory ||
    "this channel",
    80
  );
}

export function expansionTrendFallbacks(summary) {
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
