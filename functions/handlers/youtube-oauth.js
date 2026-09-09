const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {
  googleOAuthClientSecret,
  googleTokenRequest,
  youtubeChannelId,
} = require("../lib/youtube-auth");

const GOOGLE_OAUTH_CLIENT_ID =
  "109179683402-9u152t0gq2565t9rdci8b896ual2bba7.apps.googleusercontent.com";
const enforceAppCheck = true;

exports.exchangeYouTubeAuthorizationCode = onCall(
    {
      secrets: [googleOAuthClientSecret],
      enforceAppCheck,
      region: "us-central1",
      timeoutSeconds: 30,
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before linking YouTube.",
        );
      }
      const data = request.data || {};
      const code = String(data.code || "");
      const redirectUri = String(data.redirectUri || "");
      if (!code || code.length > 4096 || !/^https?:\/\//.test(redirectUri)) {
        throw new HttpsError(
            "invalid-argument",
            "Invalid Google authorization response.",
        );
      }

      const tokens = await googleTokenRequest({
        code,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: googleOAuthClientSecret.value(),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const channelId = await youtubeChannelId(tokens.access_token);
      const credentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${request.auth.uid}`);
      const existing = await credentialRef.get();
      const existingCredential = existing.data() || {};
      const refreshToken = tokens.refresh_token ||
        existingCredential.refreshToken;
      if (!refreshToken) {
        throw new HttpsError(
            "failed-precondition",
            "Google did not return renewable access. " +
            "Unlink ViewCast in your Google account and link again.",
        );
      }
      const expiresAt = Date.now() +
        Number(tokens.expires_in || 3600) * 1000;
      await credentialRef.set({
        refreshToken,
        accessToken: tokens.access_token,
        expiresAt,
        channelId,
        scope: String(tokens.scope || ""),
        updatedAt: new Date(),
      });
      return {accessToken: tokens.access_token, expiresAt, channelId};
    },
);

exports.getYouTubeAccessToken = onCall(
    {
      secrets: [googleOAuthClientSecret],
      enforceAppCheck,
      region: "us-central1",
      timeoutSeconds: 30,
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before using YouTube.",
        );
      }
      const credentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${request.auth.uid}`);
      const snapshot = await credentialRef.get();
      const credential = snapshot.data();
      if (!credential || !credential.refreshToken) {
        throw new HttpsError(
            "failed-precondition",
            "Link your YouTube channel first.",
        );
      }
      if (credential.accessToken &&
          Number(credential.expiresAt || 0) > Date.now() + 60 * 1000) {
        return {
          accessToken: credential.accessToken,
          expiresAt: credential.expiresAt,
          channelId: credential.channelId,
        };
      }
      const tokens = await googleTokenRequest({
        refresh_token: credential.refreshToken,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: googleOAuthClientSecret.value(),
        grant_type: "refresh_token",
      });
      const expiresAt = Date.now() +
        Number(tokens.expires_in || 3600) * 1000;
      await credentialRef.set({
        accessToken: tokens.access_token,
        expiresAt,
        updatedAt: new Date(),
      }, {merge: true});
      return {
        accessToken: tokens.access_token,
        expiresAt,
        channelId: credential.channelId,
      };
    },
);

exports.revokeYouTubeAuthorization = onCall(
    {enforceAppCheck, region: "us-central1", timeoutSeconds: 30},
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before unlinking YouTube.",
        );
      }
      const credentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${request.auth.uid}`);
      const snapshot = await credentialRef.get();
      const savedCredential = snapshot.data() || {};
      const token = savedCredential.refreshToken;
      if (token) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          body: new URLSearchParams({token}),
        }).catch(() => {});
      }
      await credentialRef.delete();
      return {revoked: true};
    },
);
