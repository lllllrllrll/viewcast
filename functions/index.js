const {getApps, initializeApp} = require("firebase-admin/app");

if (!getApps().length) initializeApp();

exports.deleteAccount = require("./handlers/account").deleteAccount;
exports.exchangeYouTubeAuthorizationCode =
  require("./handlers/youtube-oauth").exchangeYouTubeAuthorizationCode;
exports.generateGeminiContent =
  require("./handlers/gemini").generateGeminiContent;
exports.getPrivateYouTubeVideoAnalytics =
  require("./handlers/youtube-analytics").getPrivateYouTubeVideoAnalytics;
exports.getYouTubeAccessToken =
  require("./handlers/youtube-oauth").getYouTubeAccessToken;
exports.revokeYouTubeAuthorization =
  require("./handlers/youtube-oauth").revokeYouTubeAuthorization;
