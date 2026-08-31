import {initializeApp, getApps} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getFunctions, httpsCallable} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import {firebaseConfig} from "./firebase-config.js";
import {ensureAppCheckToken} from "./firebase-app-check.js";

const tokenStorageKey = "viewcastYouTubeAccessToken";
// Remove bearer tokens left by older builds. Renewable credentials stay on the
// authenticated backend, so reopening still works without persistent JS access.
localStorage.removeItem(tokenStorageKey);
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const functions = getFunctions(app, "us-central1");

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => window.setTimeout(() => reject(new Error(message)), milliseconds))
  ]);
}

async function readyAppCheck() {
  return withTimeout(
    ensureAppCheckToken(app),
    10000,
    "Firebase App Check could not authorize this browser. Allow localhost in the App Check reCAPTCHA configuration, then reload."
  );
}

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
  await readyAppCheck();
  const call = httpsCallable(functions, "exchangeYouTubeAuthorizationCode");
  const response = await withTimeout(
    call({code, redirectUri}),
    20000,
    "YouTube linking timed out while contacting the secure backend."
  );
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
  await readyAppCheck();
  const call = httpsCallable(functions, "getYouTubeAccessToken");
  const response = await withTimeout(
    call(),
    20000,
    "The secure YouTube authorization service timed out. Reload and try again."
  );
  if (channelId && response.data?.channelId !== channelId) {
    throw new Error("The linked Google account does not own the active YouTube channel.");
  }
  return saveToken(response.data || {}, uid);
}

export async function revokeStoredYouTubeAuthorization() {
  await readyAppCheck();
  const call = httpsCallable(functions, "revokeYouTubeAuthorization");
  try {
    await call();
  } finally {
    localStorage.removeItem(tokenStorageKey);
    sessionStorage.removeItem(tokenStorageKey);
  }
}
