/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const admin = require("firebase-admin");
const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

admin.initializeApp();

const youtubeClientSecret = defineSecret("YOUTUBE_CLIENT_SECRET");
const youtubeClientId = process.env.YOUTUBE_CLIENT_ID || "";
const allowedOrigins = [
  "http://localhost:4173",
  "https://viewcast-a6f31.web.app",
  "https://viewcast-a6f31.firebaseapp.com"
];

function setCorsHeaders(request, response) {
  const origin = request.get("origin");
  if (allowedOrigins.includes(origin)) {
    response.set("Access-Control-Allow-Origin", origin);
  }
  response.set("Vary", "Origin");
  response.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With");
  response.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

async function getFirebaseUser(request) {
  const header = request.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  return admin.auth().verifyIdToken(match[1]);
}

async function exchangeYouTubeCode({code, redirectUri}) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      code,
      client_id: youtubeClientId,
      client_secret: youtubeClientSecret.value(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    logger.error("YouTube token exchange failed.", payload);
    throw new Error(payload.error_description || "YouTube token exchange failed.");
  }
  return payload;
}

async function fetchYouTubeChannel(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("mine", "true");

  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`}
  });

  const payload = await response.json();
  if (!response.ok) {
    logger.error("YouTube channel lookup failed.", payload);
    throw new Error(payload.error?.message || "Could not load YouTube channel.");
  }

  const channel = payload.items?.[0];
  if (!channel) {
    throw new Error("No YouTube channel was found for this Google account.");
  }

  return {
    id: channel.id,
    title: channel.snippet?.title || "",
    url: `https://www.youtube.com/channel/${channel.id}`,
    thumbnail: channel.snippet?.thumbnails?.default?.url || "",
    subscriberCount: channel.statistics?.subscriberCount || "",
    viewCount: channel.statistics?.viewCount || "",
    videoCount: channel.statistics?.videoCount || ""
  };
}

exports.youtubeOAuthExchange = onRequest(
    {secrets: [youtubeClientSecret]},
    async (request, response) => {
      setCorsHeaders(request, response);
      if (request.method === "OPTIONS") {
        response.status(204).send("");
        return;
      }

      if (request.method !== "POST") {
        response.status(405).json({error: "Use POST."});
        return;
      }

      if (!youtubeClientId) {
        response.status(500).json({error: "YOUTUBE_CLIENT_ID is not configured."});
        return;
      }

      try {
        const user = await getFirebaseUser(request);
        if (!user) {
          response.status(401).json({error: "Sign in before connecting YouTube."});
          return;
        }

        const {code, redirectUri} = request.body || {};
        if (!code || !redirectUri) {
          response.status(400).json({error: "Missing OAuth code or redirect URI."});
          return;
        }

        const tokenSet = await exchangeYouTubeCode({code, redirectUri});
        const channel = await fetchYouTubeChannel(tokenSet.access_token);
        const expiresAt = Date.now() + (Number(tokenSet.expires_in || 0) * 1000);
        const connection = {
          channel,
          scopes: String(tokenSet.scope || "").split(" ").filter(Boolean),
          accessToken: tokenSet.access_token,
          tokenType: tokenSet.token_type || "Bearer",
          expiresAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (tokenSet.refresh_token) {
          connection.refreshToken = tokenSet.refresh_token;
        }

        await admin
            .firestore()
            .doc(`users/${user.uid}/integrations/youtube`)
            .set(connection, {merge: true});

        await admin.firestore().doc(`users/${user.uid}`).set({
          youtubeChannelUrl: channel.url,
          youtubeChannelTitle: channel.title,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, {merge: true});

        response.json({channel});
      } catch (error) {
        logger.error("Could not connect YouTube.", error);
        response.status(500).json({error: error.message || "Could not connect YouTube."});
      }
    },
);

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
