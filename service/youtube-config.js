export const googleOAuthClientId = "PASTE_GOOGLE_OAUTH_CLIENT_ID_HERE";

export const youtubeOAuthExchangeUrl =
  "https://us-central1-viewcast-a6f31.cloudfunctions.net/youtubeOAuthExchange";

export const youtubeOAuthConfigured =
  googleOAuthClientId && !googleOAuthClientId.startsWith("PASTE_");
