import {initializeApp, getApps} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getFunctions, httpsCallable} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import {firebaseConfig} from "./firebase-config.js";
import {ensureAppCheckToken} from "./firebase-app-check.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const functions = getFunctions(app, "us-central1");

export async function getPrivateVideoAnalytics(videoId) {
  await ensureAppCheckToken(app);
  const callable = httpsCallable(functions, "getPrivateYouTubeVideoAnalytics");
  const response = await callable({videoId});
  return {
    analytics: response.data?.analytics || null,
    retentionPoints: Array.isArray(response.data?.retentionPoints)
      ? response.data.retentionPoints
      : [],
    searchTerms: Array.isArray(response.data?.searchTerms)
      ? response.data.searchTerms
      : []
  };
}
