import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const button = document.getElementById("connectYouTube");
let currentUser = null;
let auth = null;
let db = null;

function setButton(label, disabled = false) {
  if (!button) return;
  const icon = button.querySelector("svg");
  button.textContent = "";
  if (icon) button.append(icon);
  button.append(document.createTextNode(label));
  button.disabled = disabled;
}

function createProvider() {
  const provider = new GoogleAuthProvider();
  scopes.forEach((scope) => provider.addScope(scope));
  provider.setCustomParameters({prompt: "consent"});
  return provider;
}

function userHasGoogleProvider(user) {
  return user.providerData.some((provider) => provider.providerId === "google.com");
}

async function connectGoogleProvider(user) {
  const provider = createProvider();
  try {
    return userHasGoogleProvider(user)
      ? reauthenticateWithPopup(user, provider)
      : linkWithPopup(user, provider);
  } catch (error) {
    if (error.code === "auth/provider-already-linked") {
      return reauthenticateWithPopup(user, provider);
    }
    throw error;
  }
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${accessToken}`}
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || "YouTube API request failed.");
  }
  return payload;
}

async function fetchChannel(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("mine", "true");

  const payload = await fetchJson(url, accessToken);
  const channel = payload.items?.[0];
  if (!channel) throw new Error("No YouTube channel was found for this Google account.");

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

async function fetchAnalyticsSummary(accessToken) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 28);

  const formatDate = (date) => date.toISOString().slice(0, 10);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", formatDate(startDate));
  url.searchParams.set("endDate", formatDate(endDate));
  url.searchParams.set("metrics", "views,estimatedMinutesWatched,averageViewDuration,subscribersGained");

  try {
    const payload = await fetchJson(url, accessToken);
    const [views, estimatedMinutesWatched, averageViewDuration, subscribersGained] =
      payload.rows?.[0] || [];
    return {
      views: views || 0,
      estimatedMinutesWatched: estimatedMinutesWatched || 0,
      averageViewDuration: averageViewDuration || 0,
      subscribersGained: subscribersGained || 0
    };
  } catch (error) {
    console.warn("YouTube Analytics summary was not available yet.", error);
    return null;
  }
}

async function saveYouTubeConnection({channel, analyticsSummary}) {
  await setDoc(
    doc(db, "users", currentUser.uid),
    {
      youtubeConnection: {
        channel,
        analyticsSummary,
        scopes,
        connectedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      },
      youtubeChannelUrl: channel.url,
      youtubeChannelTitle: channel.title,
      updatedAt: serverTimestamp()
    },
    {merge: true}
  );
}

async function connectYouTube() {
  if (!currentUser) return;

  try {
    setButton("Connecting...", true);
    const result = await connectGoogleProvider(currentUser);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Google did not return a YouTube access token.");
    }

    const channel = await fetchChannel(credential.accessToken);
    const analyticsSummary = await fetchAnalyticsSummary(credential.accessToken);
    await saveYouTubeConnection({channel, analyticsSummary});
    localStorage.setItem("viewcastYouTubeChannel", JSON.stringify(channel));
    setButton(channel.title || "YouTube connected");
  } catch (error) {
    console.error("Could not connect YouTube.", error);
    setButton("Connect YouTube");
    button.title = error.message || "Could not connect YouTube.";
  }
}

if (button && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (!user) {
      setButton("Sign in to connect", true);
      return;
    }

    const savedChannel = JSON.parse(localStorage.getItem("viewcastYouTubeChannel") || "null");
    setButton(savedChannel?.title || "Connect YouTube");
  });

  button.addEventListener("click", connectYouTube);
}
