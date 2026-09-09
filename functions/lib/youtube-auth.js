const {HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {getFirestore} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

const googleOAuthClientSecret = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_OAUTH_CLIENT_ID =
  "109179683402-9u152t0gq2565t9rdci8b896ual2bba7.apps.googleusercontent.com";

/**
 * Exchanges an OAuth code or refresh token with Google.
 * @param {object} parameters OAuth token endpoint parameters.
 * @return {Promise<object>} Google token response.
 */
async function googleTokenRequest(parameters) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams(parameters),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    logger.error("Google OAuth token exchange failed", {
      status: response.status,
      error: payload.error,
    });
    throw new HttpsError(
        "failed-precondition",
        "Your YouTube connection needs to be linked again.",
    );
  }
  return payload;
}

/**
 * Resolves the channel owned by a Google access token.
 * @param {string} accessToken Google OAuth access token.
 * @return {Promise<string>} YouTube channel ID.
 */
async function youtubeChannelId(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("mine", "true");
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`},
  });
  const payload = await response.json().catch(() => ({}));
  const channelId = payload.items && payload.items[0] && payload.items[0].id;
  if (!response.ok || !channelId) {
    throw new HttpsError(
        "failed-precondition",
        "No YouTube channel was available for this Google account.",
    );
  }
  return channelId;
}

/**
 * Returns a valid server-side YouTube credential for a Firebase user.
 * @param {string} uid Firebase user ID.
 * @return {Promise<object>} Stored credential with a current access token.
 */
async function privateYouTubeCredential(uid) {
  const credentialRef = getFirestore().doc(`_internalYouTubeAuth/${uid}`);
  const snapshot = await credentialRef.get();
  const credential = snapshot.data();
  if (!credential || !credential.refreshToken || !credential.channelId) {
    throw new HttpsError(
        "failed-precondition",
        "Link your YouTube channel before loading private analytics.",
    );
  }

  const grantedScopes = String(credential.scope || "").split(/\s+/);
  if (!grantedScopes.includes(
      "https://www.googleapis.com/auth/yt-analytics.readonly")) {
    throw new HttpsError(
        "failed-precondition",
        "Relink YouTube once to grant private Analytics access.",
    );
  }

  if (credential.accessToken &&
      Number(credential.expiresAt || 0) > Date.now() + 60 * 1000) {
    return credential;
  }

  const tokens = await googleTokenRequest({
    refresh_token: credential.refreshToken,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: googleOAuthClientSecret.value(),
    grant_type: "refresh_token",
  });
  const expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  await credentialRef.set({
    accessToken: tokens.access_token,
    expiresAt,
    updatedAt: new Date(),
  }, {merge: true});
  return {...credential, accessToken: tokens.access_token, expiresAt};
}

/**
 * Fetches one YouTube Analytics report with the user's private token.
 * @param {URL} url Analytics API URL.
 * @param {string} accessToken Google OAuth access token.
 * @return {Promise<object>} Parsed report.
 */
async function privateYouTubeReport(url, accessToken) {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    logger.warn("YouTube private Analytics request failed", {
      status: response.status,
      reason: payload.error && payload.error.message,
    });
    throw new HttpsError(
        response.status === 403 ? "permission-denied" : "unavailable",
        payload.error && payload.error.message ||
          "YouTube private Analytics could not be loaded.",
    );
  }
  return payload;
}

/**
 * Formats an Analytics API date.
 * @param {Date} date Date to format.
 * @return {string} YYYY-MM-DD date.
 */
function analyticsDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns an Analytics API date a number of days ago.
 * @param {number} days Days before today.
 * @return {string} YYYY-MM-DD date.
 */
function analyticsStartDate(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return analyticsDate(date);
}

/**
 * Loads the first private report range containing rows.
 * @param {string} accessToken Google OAuth access token.
 * @param {Function} buildUrl Builds a report URL for a date range.
 * @return {Promise<object>} Report and selected range label.
 */
async function firstPrivateReport(accessToken, buildUrl) {
  const ranges = [
    {startDate: analyticsStartDate(28), label: "28D"},
    {startDate: "2008-07-01", label: "Lifetime"},
  ];
  for (const range of ranges) {
    const report = await privateYouTubeReport(
        buildUrl(range.startDate, analyticsDate(new Date())),
        accessToken,
    );
    if (report.rows && report.rows.length) return {report, label: range.label};
  }
  return {report: {rows: []}, label: "Lifetime"};
}

module.exports = {
  analyticsDate,
  analyticsStartDate,
  firstPrivateReport,
  googleOAuthClientSecret,
  googleTokenRequest,
  privateYouTubeCredential,
  privateYouTubeReport,
  youtubeChannelId,
};
