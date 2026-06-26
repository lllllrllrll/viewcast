import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  deleteField,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const connectButton = document.getElementById("connectYouTube");
const unlinkButton = document.getElementById("unlinkYouTube");
const connectionStorageKey = "viewcastYouTubeConnection";
const channelStorageKey = "viewcastYouTubeChannel";
const tokenStorageKey = "viewcastYouTubeAccessToken";
let currentUser = null;
let auth = null;
let db = null;
let hasLinkedChannel = false;

function setButton(label, disabled = false) {
  if (!connectButton) return;
  const icon = connectButton.querySelector("svg");
  connectButton.textContent = "";
  if (icon) connectButton.append(icon);
  connectButton.append(document.createTextNode(label));
  connectButton.disabled = disabled;
}

function setUnlinkButton({visible = hasLinkedChannel, disabled = false} = {}) {
  if (!unlinkButton) return;
  unlinkButton.hidden = !visible;
  unlinkButton.disabled = disabled;
}

function readSavedConnection() {
  try {
    const savedConnection = JSON.parse(localStorage.getItem(connectionStorageKey) || "null");
    if (savedConnection?.channel) return savedConnection;

    const savedChannel = JSON.parse(localStorage.getItem(channelStorageKey) || "null");
    return savedChannel ? {channel: savedChannel, analyticsSummary: {}} : null;
  } catch (error) {
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(channelStorageKey);
    return null;
  }
}

function saveCachedConnection(connection) {
  localStorage.setItem(connectionStorageKey, JSON.stringify(connection));
  localStorage.setItem(channelStorageKey, JSON.stringify(connection.channel || {}));
}

function saveCachedAccessToken(accessToken) {
  if (!accessToken || !currentUser) return;
  localStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
}

async function getSavedConnection(user) {
  const cachedConnection = readSavedConnection();
  if (cachedConnection?.channel?.id || cachedConnection?.channel?.url || cachedConnection?.channel?.title) {
    return cachedConnection;
  }

  const snapshot = await getDoc(doc(db, "users", user.uid));
  const profile = snapshot.exists() ? snapshot.data() : {};
  const connection = profile.youtubeConnection || null;
  if (connection?.channel) return connection;
  if (profile.youtubeChannelUrl || profile.youtubeChannelTitle) {
    return {
      channel: {
        url: profile.youtubeChannelUrl || "",
        title: profile.youtubeChannelTitle || ""
      },
      analyticsSummary: {}
    };
  }
  return null;
}

function createProvider() {
  const provider = new GoogleAuthProvider();
  scopes.forEach((scope) => provider.addScope(scope));
  provider.setCustomParameters({include_granted_scopes: "true"});
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
    setUnlinkButton({visible: hasLinkedChannel, disabled: true});
    const result = await connectGoogleProvider(currentUser);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Google did not return a YouTube access token.");
    }

    saveCachedAccessToken(credential.accessToken);
    const channel = await fetchChannel(credential.accessToken);
    const analyticsSummary = await fetchAnalyticsSummary(credential.accessToken);
    const connection = {channel, analyticsSummary};
    await saveYouTubeConnection(connection);
    saveCachedConnection(connection);
    hasLinkedChannel = true;
    setButton(channel.title || "YouTube connected");
    setUnlinkButton({visible: true, disabled: false});
    window.dispatchEvent(new CustomEvent("viewcast:youtube-connected", {
      detail: connection
    }));
  } catch (error) {
    console.error("Could not connect YouTube.", error);
    setButton("Connect YouTube");
    setUnlinkButton({visible: hasLinkedChannel, disabled: false});
    connectButton.title = error.message || "Could not connect YouTube.";
  }
}

async function unlinkYouTube() {
  if (!currentUser) return;

  try {
    setUnlinkButton({visible: hasLinkedChannel, disabled: true});
    setButton("Unlinking...", true);
    try {
      await updateDoc(doc(db, "users", currentUser.uid), {
        youtubeConnection: deleteField(),
        youtubeChannelUrl: deleteField(),
        youtubeChannelTitle: deleteField(),
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      if (error.code !== "not-found") throw error;
    }
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(channelStorageKey);
    localStorage.removeItem("viewcastChannelUrl");
    localStorage.removeItem(tokenStorageKey);
    hasLinkedChannel = false;
    setButton("Connect YouTube");
    setUnlinkButton({visible: false, disabled: true});
    window.dispatchEvent(new CustomEvent("viewcast:youtube-unlinked"));
  } catch (error) {
    console.error("Could not unlink YouTube.", error);
    setButton("Connect YouTube");
    setUnlinkButton({visible: hasLinkedChannel, disabled: false});
    unlinkButton.title = error.message || "Could not unlink YouTube.";
  }
}

if (connectButton && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;

    // Check for redirection prompt
    const params = new URLSearchParams(window.location.search);
    if (params.get("link") === "required") {
      const prompt = document.getElementById("connectionPrompt");
      if (prompt) {
        prompt.textContent = "Please link your YouTube channel before analyzing videos.";
        prompt.style.color = "var(--rose)";
        prompt.style.fontWeight = "bold";
      }
    }

    if (!user) {
      hasLinkedChannel = false;
      setButton("Sign in to connect", true);
      setUnlinkButton({visible: false, disabled: true});
      return;
    }

    setButton("Checking channel...", true);
    setUnlinkButton({visible: false, disabled: true});

    try {
      const savedConnection = await getSavedConnection(user);
      hasLinkedChannel = Boolean(savedConnection);
      setButton(savedConnection?.channel?.title || "Connect YouTube");
      setUnlinkButton({visible: hasLinkedChannel, disabled: false});
    } catch (error) {
      console.error("Could not load YouTube connection.", error);
      hasLinkedChannel = Boolean(readSavedConnection());
      setButton("Connect YouTube");
      setUnlinkButton({visible: hasLinkedChannel, disabled: false});
    }
  });

  connectButton.addEventListener("click", connectYouTube);
  unlinkButton?.addEventListener("click", unlinkYouTube);
}
