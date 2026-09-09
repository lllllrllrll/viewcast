const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

const enforceAppCheck = true;

exports.deleteAccount = onCall(
    {
      enforceAppCheck,
      region: "us-central1",
      timeoutSeconds: 30,
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Sign in before deleting your account.",
        );
      }

      const authTimeSeconds = Number(request.auth.token.auth_time || 0);
      if (!authTimeSeconds || Date.now() / 1000 - authTimeSeconds > 5 * 60) {
        throw new HttpsError(
            "failed-precondition",
            "Reauthenticate before deleting your account.",
        );
      }

      const uid = request.auth.uid;
      const youtubeCredentialRef = getFirestore()
          .doc(`_internalYouTubeAuth/${uid}`);
      const youtubeCredential = await youtubeCredentialRef.get();
      const savedYouTubeCredential = youtubeCredential.data() || {};
      const googleRefreshToken = savedYouTubeCredential.refreshToken;
      if (googleRefreshToken) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          body: new URLSearchParams({token: googleRefreshToken}),
        }).catch(() => {});
      }
      await youtubeCredentialRef.delete();
      try {
        await getAuth().deleteUser(uid);
      } catch (error) {
        logger.error("Firebase Auth account deletion failed", {uid, error});
        throw new HttpsError(
            "internal",
            "The account could not be deleted. Please try again.",
        );
      }

      try {
        // Firestore deletion is idempotent. Perform it after deleting the Auth
        // identity so a cleanup failure can never leave a usable account with
        // a missing profile.
        await getFirestore().doc(`users/${uid}`).delete();
        logger.info("Deleted ViewCast account and profile", {uid});
        return {deleted: true, profileDeleted: true};
      } catch (error) {
        logger.error("Deleted Auth account but profile cleanup failed", {
          uid,
          error,
        });
        return {deleted: true, profileDeleted: false};
      }
    },
);

/**
 * Validates Gemini message and supported media payloads.
 * @param {Array<object>} contents Gemini request messages.
 * @return {void}
 */
