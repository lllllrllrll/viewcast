import {isGeminiAvailable, requestGeminiContent, requestGeminiText} from "./gemini-client.js?v=8";
import {numberValue, shortText, youtubeCategoryName} from "./insights-format.js?v=1";
import {parseJsonObject} from "./services/json.js?v=1";
import {isShort, trendEvidence, uploadPerformanceContext} from "./insights-model.js?v=9";
import {
  channelScanContext, compactChannelProfile,
  geminiCreatorContext
} from "./insights-gemini.js?v=8";
import {normalizeGeminiInsights} from "./modules/insights-gemini-normalize.js?v=1";

export {normalizeGeminiInsights};

function geminiContext(summary) {
  const trendReferences = summary.trendVideos
    .slice(0, 5)
    .map((video) => ({
      ...trendEvidence(video),
      likes: numberValue(video.statistics?.likeCount) || 0,
      comments: numberValue(video.statistics?.commentCount) || 0,
      format: isShort(video) ? "Short" : "Video",
      category: youtubeCategoryName(video.snippet?.categoryId),
    }))
    .filter((video) => video.title);
  const visibleIdeas = summary.geminiInsights?.recommendations || summary.topicIdeas;
  const ideas = visibleIdeas.slice(0, 3).map((idea) => `${idea.title}: ${shortText(idea.body, 120)}`);
  return {
    creatorProvidedContext: summary.creatorProvidedContext || geminiCreatorContext(),
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
    trendQueries: summary.trendVideos.trendQueries || [],
    contentInterpretations: (summary.contentInterpretations || []).slice(0, 5)
  };
}

function geminiPageContext(summary, videos) {
  return {
    ...geminiContext(summary),
    averageViews: Math.round(summary.avgViews || 0),
    bestUploadViews: summary.bestViews || 0,
    uploadPerformance: uploadPerformanceContext(videos),
    channelWideScan: channelScanContext(
      videos,
      summary.channelProfile || {},
      {includeCatalog: false}
    )
  };
}

export async function buildGeminiPageInsights(summary, videos) {
  if (!isGeminiAvailable()) return null;

  const prompt = [
    "You are ViewCast's YouTube strategist. Return compact JSON only. No trailing commas.",
    "Use only supplied channel stats, trend references, and upload patterns. Do not invent analytics.",
    "Base advice on repeated channel-wide evidence, using scan coverage as confidence. Never imply access to unsupplied data.",
    "Treat creatorProvidedContext as the primary source for the channel niche, audience, goals, and requested content direction.",
    "Classify the channel niche from repeated upload patterns, then make every card and suggestion match that niche.",
    "Use contentInterpretations to understand what the creator's titles mean and which media they reference. Treat the raw title only as a lookup key and performance label, never as a ready-made topic.",
    "Base concepts on resolved references, premise, audience appeal, and external trends. Never recycle an upload title or merely propose a follow-up.",
    "When an interpretation has low confidence or no resolved media reference, do not build a recommendation around that interpretation.",
    "Use 12-hour time like 'Tue 6 PM'. Avoid generic advice such as make a follow-up, post more, extend the video, or improve the hook.",
    "Return exactly 3 nextVideoSuggestions and exactly 3 recommendations. Every item needs a non-empty title, body, label, and tone.",
    "Ground 2 suggestions in distinct accepted trendReferences and 1 in channel performance. Cite the trend title/date/viewsPerDay or a supplied performance number; label them Current trend or Channel data.",
    "For the channel-grounded suggestion, cite a supplied performance number and use the label 'Channel data'.",
    "A trend reference is supporting evidence, not a concept to copy. Transform its viewer demand into an original angle for this channel.",
    "recommendations must be 3 important strategic tips the creator can act on now, such as packaging, upload timing, format length, niche/trend fit, Shorts strategy, or weak-angle avoidance.",
    "topTopicSignal.value must be a supported 2-6 word shared viewer interest, not a copied or lightly rewritten title.",
    "topTopicSignal.detail must credit the strongest supporting trendReference by its exact video title and channel name.",
    "Every word in topTopicSignal.value must be supported by the supplied external YouTube trend references or trend queries. Do not invent a trend.",
    "Reject trend references that are broad-only matches, stale topics, archival/reuploads, or irrelevant to creator context.",
    "Return validatedTrends as up to 3 exact, character-for-character title strings copied from distinct accepted trendReferences. Use fewer than 3 when fewer are genuinely current and relevant; never fill space with a weak match.",
    "Use only references included in validatedTrends for trend-grounded nextVideoSuggestions. If fewer than 2 references pass, replace the unsupported trend suggestion with channel-data advice instead of using a rejected reference.",
    "Return exactly 3 crossoverTrends as relevant Shorts opportunities for this channel, using three distinct accepted trendReferences when available.",
    "Each crossover trend must cite a same-topic reference and turn its demand into an original Short with hook, format, and payoff. Label it Relevant opportunity.",
    "JSON shape:",
    `{"cards":{"bestUploadTime":{"value":"","detail":"","tone":"good"},"nextVideoLength":{"value":"","detail":"","tone":"good"},"nextShortLength":{"value":"","detail":"","tone":"warn"},"topTopicSignal":{"value":"","detail":"","tone":"good"}},"validatedTrends":["","",""],"nextVideoSuggestions":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"crossoverTrends":[{"title":"","body":"","label":"Relevant opportunity","tone":"good"},{"title":"","body":"","label":"Relevant opportunity","tone":"good"},{"title":"","body":"","label":"Relevant opportunity","tone":"good"}],"recommendations":[{"title":"","body":"","label":"","tone":"good"},{"title":"","body":"","label":"","tone":"warn"},{"title":"","body":"","label":"","tone":"good"}],"chatIntro":""}`,
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
        maxOutputTokens: 700
      }
    });

    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    const parsedInsights = parseJsonObject(text);
    if (!parsedInsights) {
      // Gemini can occasionally hit its output limit mid-object. The page still
      // has complete deterministic channel analysis, so render that instead of
      // discarding the entire result or spending credits on an automatic retry.
      console.warn("Gemini returned incomplete JSON; using channel-data insights.");
      return normalizeGeminiInsights({}, summary);
    }
    return normalizeGeminiInsights(parsedInsights, summary);
  } catch (error) {
    console.warn("Gemini page insights failed.", error);
    const fallback = normalizeGeminiInsights({}, summary);
    fallback.aiUnavailable = true;
    fallback.aiErrorCode = String(error.code || error.message || "unavailable");
    return fallback;
  }
}

export async function buildGeminiChatReply(question, summary, chatHistory = []) {
  if (!isGeminiAvailable()) return "An error has occurred. The AI assistant is unavailable right now.";

  const fullContext = summary ? geminiContext(summary) : null;
  const chatContext = fullContext ? {
    creatorProvidedContext: fullContext.creatorProvidedContext,
    channelCategory: fullContext.channelCategory,
    currentYouTubeTrend: fullContext.currentYouTubeTrend,
    bestUploadTime: fullContext.bestUploadTime,
    nextVideoLength: fullContext.nextVideoLength,
    nextShortLength: fullContext.nextShortLength,
    suggestedIdeas: fullContext.suggestedIdeas,
    trendReferences: fullContext.trendReferences.slice(0, 3)
  } : null;
  const systemInstruction = [
    "Give concise, practical YouTube advice using only the supplied channel context.",
    "Do not invent analytics. Answer in 2-3 short sentences.",
    "",
    "Channel context:",
    chatContext ? JSON.stringify(chatContext) : "No channel data yet. Ask one focused question."
  ].join("\n");

  try {
    const text = await requestGeminiText({
      contents: chatHistory.slice(-3),
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 96
      }
    });

    return text || "I couldn't generate a response. Please try again.";
  } catch (error) {
    console.error("Gemini advice failed.", error);
    return "AI chat is temporarily unavailable, but the recommendations above still use your channel uploads and YouTube performance data.";
  }
}
