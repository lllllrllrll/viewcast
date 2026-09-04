const tokenStorageKey = "viewcastYouTubeAccessToken";
// Access tokens remain session-only. The Spark-compatible browser flow cannot
// renew them silently, so users reconnect after Google expires the token.
localStorage.removeItem(tokenStorageKey);
export async function getRenewedYouTubeAccessToken(uid, channelId = "") {
  try {
    const cached = JSON.parse(sessionStorage.getItem(tokenStorageKey) || "null");
    if (cached?.accessToken && cached.uid === uid &&
        (!channelId || cached.channelId === channelId) &&
        cached.expiresAt > Date.now() + 60 * 1000) {
      return cached.accessToken;
    }
  } catch {
    sessionStorage.removeItem(tokenStorageKey);
  }
  throw new Error("Your YouTube session expired. Open My Channel and reconnect to refresh analytics.");
}

export async function revokeStoredYouTubeAuthorization() {
  let accessToken = "";
  try {
    accessToken = JSON.parse(sessionStorage.getItem(tokenStorageKey) || "null")?.accessToken || "";
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      await new Promise((resolve) => window.google.accounts.oauth2.revoke(accessToken, resolve));
    }
  } finally {
    localStorage.removeItem(tokenStorageKey);
    sessionStorage.removeItem(tokenStorageKey);
  }
}
