import {initializeApp, getApps} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getFunctions, httpsCallable} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import {firebaseConfig} from "./firebase-config.js";
import {ensureAppCheck, ensureAppCheckToken} from "./firebase-app-check.js";

const tokenStorageKey = "viewcastYouTubeAccessToken";
// Remove bearer tokens left by older builds. Renewable credentials stay on the
// authenticated backend, so reopening still works without persistent JS access.
localStorage.removeItem(tokenStorageKey);
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
ensureAppCheck(app);
const functions = getFunctions(app, "us-central1");

function saveToken(result, uid) {
  const token = {
    accessToken: result.accessToken,
    expiresAt: Number(result.expiresAt || 0),
    channelId: result.channelId || "",
    uid
  };
  sessionStorage.setItem(tokenStorageKey, JSON.stringify(token));
  localStorage.removeItem(tokenStorageKey);
  return token.accessToken;
}

export async function exchangeYouTubeCode(code, redirectUri, uid) {
  await ensureAppCheckToken(app);
  const call = httpsCallable(functions, "exchangeYouTubeAuthorizationCode");
  const response = await call({code, redirectUri});
  return {
    ...response.data,
    accessToken: saveToken(response.data || {}, uid)
  };
}

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
  await ensureAppCheckToken(app);
  const call = httpsCallable(functions, "getYouTubeAccessToken");
  const response = await call();
  if (channelId && response.data?.channelId !== channelId) {
    throw new Error("The linked Google account does not own the active YouTube channel.");
  }
  return saveToken(response.data || {}, uid);
}

export async function revokeStoredYouTubeAuthorization() {
  await ensureAppCheckToken(app);
  const call = httpsCallable(functions, "revokeYouTubeAuthorization");
  try {
    await call();
  } finally {
    localStorage.removeItem(tokenStorageKey);
    sessionStorage.removeItem(tokenStorageKey);
  }
}
