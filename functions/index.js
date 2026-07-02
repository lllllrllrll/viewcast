const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions");
const {GoogleGenerativeAI} = require("@google/generative-ai");

setGlobalOptions({maxInstances: 10});

/**
 * Generic helper to make YouTube API calls securely.
 * Uses user's accessToken or server-side YOUTUBE_API_KEY if provided.
 */
async function callYouTubeAPI(url, accessToken) {
    const headers = { "Content-Type": "application/json" };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    // Append server-side API Key if available and no token provided
    const apiKey = process.env.YOUTUBE_API_KEY;
    const finalUrl = new URL(url);
    if (!accessToken && apiKey) {
        finalUrl.searchParams.set("key", apiKey);
    }

    const response = await fetch(finalUrl.href, { headers });
    const data = await response.json();

    if (!response.ok) {
        throw new HttpsError("internal", data.error?.message || "YouTube API call failed.");
    }
    return data;
}

/**
 * Fetch Channel Data
 */
exports.getYouTubeChannelData = onCall({ secrets: ["YOUTUBE_API_KEY"] }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const { accessToken, mine } = request.data;
    let url = "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails";
    if (mine) url += "&mine=true";
    return await callYouTubeAPI(url, accessToken);
});

/**
 * Fetch Playlist Items (e.g., Uploads)
 */
exports.getYouTubePlaylistItems = onCall({ secrets: ["YOUTUBE_API_KEY"] }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const { accessToken, playlistId, maxResults, pageToken } = request.data;

    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails,snippet");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", maxResults || 50);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    return await callYouTubeAPI(url.href, accessToken);
});

/**
 * Fetch Video Details
 */
exports.getYouTubeVideos = onCall({ secrets: ["YOUTUBE_API_KEY"] }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const { accessToken, ids } = request.data;

    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", ids.join(","));

    return await callYouTubeAPI(url.href, accessToken);
});

/**
 * Fetch Search Results
 */
exports.searchYouTube = onCall({ secrets: ["YOUTUBE_API_KEY"] }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const { accessToken, q, type, order, maxResults, publishedAfter } = request.data;

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", q);
    if (type) url.searchParams.set("type", type);
    if (order) url.searchParams.set("order", order);
    if (maxResults) url.searchParams.set("maxResults", maxResults);
    if (publishedAfter) url.searchParams.set("publishedAfter", publishedAfter);

    return await callYouTubeAPI(url.href, accessToken);
});

/**
 * Securely fetch YouTube Analytics Data.
 */
exports.getYouTubeAnalytics = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const { accessToken, startDate, endDate, metrics, dimensions, filters, sort, maxResults } = request.data;

    const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("endDate", endDate);
    url.searchParams.set("metrics", metrics);
    if (dimensions) url.searchParams.set("dimensions", dimensions);
    if (filters) url.searchParams.set("filters", filters);
    if (sort) url.searchParams.set("sort", sort);
    if (maxResults) url.searchParams.set("maxResults", String(maxResults));

    const response = await fetch(url.href, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    if (!response.ok) throw new HttpsError("internal", data.error?.message || "Analytics API failed.");
    return data;
});

/**
 * Cloud Function to generate AI advice for YouTube creators using Gemini.
 */
exports.generateChannelAdvice = onCall({
  secrets: ["GEMINI_API_KEY"],
  enforceAppCheck: false,
}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const { question, history, context, modelName } = request.data;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) throw new HttpsError("failed-precondition", "Gemini API key missing.");

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName || "gemini-1.5-flash" });

    const systemInstruction = `You are ViewCast's YouTube assistant. Give concise (2-4 sentences), practical advice based on this context: ${JSON.stringify(context || {})}`;

    const chat = model.startChat({
      history: (history || []).map(item => ({
        role: item.role,
        parts: [{ text: item.parts[0].text }]
      })),
      systemInstruction: { parts: [{ text: systemInstruction }] }
    });

    const result = await chat.sendMessage(question);
    const response = await result.response;
    return { text: response.text().trim() };
  } catch (error) {
    throw new HttpsError("internal", error.message);
  }
});
