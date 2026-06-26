import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  arrayRemove,
  arrayUnion,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];

const connectButton = document.getElementById("connectYouTube");
const unlinkButton = document.getElementById("unlinkYouTube");
const channelSelector = document.getElementById("channelSelector");
const channelSelectorWrap = document.getElementById("channelSelectorWrap");

const allConnectionsKey = "viewcastYouTubeAllConnections";
const activeConnectionKey = "viewcastYouTubeConnection";
const channelStorageKey = "viewcastYouTubeChannel";
const tokenStorageKey = "viewcastYouTubeAccessToken";

let currentUser = null;
let auth = null;
let db = null;
let linkedConnections = [];

function setButton(label, disabled = false) {
  if (!connectButton) return;
  const icon = connectButton.querySelector("svg");
  connectButton.textContent = "";
  if (icon) connectButton.append(icon);
  connectButton.append(document.createTextNode(label));
  connectButton.disabled = disabled;
}

function updateUI() {
  const active = readActiveConnection();
  const connections = readAllConnections();

  if (connections.length > 0) {
    channelSelectorWrap.hidden = false;
    channelSelector.innerHTML = connections.map(conn =>
      `<option value="${conn.channel.id}" ${active?.channel?.id === conn.channel.id ? 'selected' : ''}>${conn.channel.title}</option>`
    ).join("");

    setUnlinkButton({visible: true, disabled: false});
    setButton("Link New Channel");
  } else {
    channelSelectorWrap.hidden = true;
    setUnlinkButton({visible: false, disabled: true});
    setButton("Connect YouTube");
  }
}

function setUnlinkButton({visible = false, disabled = false} = {}) {
  if (!unlinkButton) return;
  unlinkButton.hidden = !visible;
  unlinkButton.disabled = disabled;
}

function readAllConnections() {
  try {
    return JSON.parse(localStorage.getItem(allConnectionsKey) || "[]");
  } catch (e) {
    return [];
  }
}

function readActiveConnection() {
  try {
    return JSON.parse(localStorage.getItem(activeConnectionKey) || "null");
  } catch (e) {
    return null;
  }
}

function saveConnections(connections, activeId = null) {
  localStorage.setItem(allConnectionsKey, JSON.stringify(connections));

  let active = connections.find(c => c.channel.id === activeId) || connections[0] || null;
  if (active) {
    localStorage.setItem(activeConnectionKey, JSON.stringify(active));
    localStorage.setItem(channelStorageKey, JSON.stringify(active.channel));
  } else {
    localStorage.removeItem(activeConnectionKey);
    localStorage.removeItem(channelStorageKey);
  }
  updateUI();
}

function saveCachedAccessToken(accessToken) {
  if (!accessToken || !currentUser) return;
  localStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
}

async function syncConnectionsFromFirestore(user) {
  try {
    const snapshot = await getDoc(doc(db, "users", user.uid));
    const data = snapshot.exists() ? snapshot.data() : {};
    let connections = data.youtubeConnections || [];

    // Legacy support for single connection
    if (data.youtubeConnection && !connections.some(c => c.channel.id === data.youtubeConnection.channel.id)) {
      connections.push(data.youtubeConnection);
    }

    // Merge with local connections if Firestore is empty (prevent accidental wipe)
    if (connections.length === 0) {
      const local = readAllConnections();
      if (local.length > 0) connections = local;
    }

    saveConnections(connections, readActiveConnection()?.channel?.id);
  } catch (e) {
    console.error("Sync failed:", e);
    updateUI();
  }
}

function createProvider() {
  const provider = new GoogleAuthProvider();
  scopes.forEach((scope) => provider.addScope(scope));
  provider.setCustomParameters({include_granted_scopes: "true", prompt: "select_account"});
  return provider;
}

async function connectGoogleProvider(user) {
  const provider = createProvider();
  return linkWithPopup(user, provider).catch(error => {
    if (error.code === "auth/provider-already-linked") {
      return reauthenticateWithPopup(user, provider);
    }
    throw error;
  });
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, { headers: {Authorization: `Bearer ${accessToken}`} });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "YouTube API request failed.");
  return payload;
}

async function fetchChannel(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("mine", "true");
  const payload = await fetchJson(url, accessToken);
  const channel = payload.items?.[0];
  if (!channel) throw new Error("No YouTube channel found.");
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
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", "views,estimatedMinutesWatched,averageViewDuration,subscribersGained");
  try {
    const payload = await fetchJson(url, accessToken);
    const [views, minutes, avd, subs] = payload.rows?.[0] || [];
    return { views: views || 0, estimatedMinutesWatched: minutes || 0, averageViewDuration: avd || 0, subscribersGained: subs || 0 };
  } catch (e) { return null; }
}

async function connectYouTube() {
  if (!currentUser) return;
  try {
    setButton("Connecting...", true);
    const result = await connectGoogleProvider(currentUser);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) throw new Error("No access token returned.");

    saveCachedAccessToken(credential.accessToken);
    const channel = await fetchChannel(credential.accessToken);
    const analytics = await fetchAnalyticsSummary(credential.accessToken);
    const newConn = { channel, analyticsSummary: analytics, connectedAt: Date.now() };

    const connections = readAllConnections();
    const existingIdx = connections.findIndex(c => c.channel.id === channel.id);
    if (existingIdx > -1) connections[existingIdx] = newConn;
    else connections.push(newConn);

    await setDoc(doc(db, "users", currentUser.uid), {
      youtubeConnections: connections,
      updatedAt: serverTimestamp()
    }, { merge: true });

    saveConnections(connections, channel.id);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-connected", { detail: newConn }));
  } catch (error) {
    console.error("Connect failed:", error);
    setButton("Link New Channel");
    // Show error to user
    const prompt = document.getElementById("connectionPrompt");
    if (prompt) {
      prompt.textContent = "Failed to link channel: " + (error.message || "Unknown error");
      prompt.style.color = "var(--rose)";
    }
  }
}

async function unlinkYouTube() {
  const active = readActiveConnection();
  if (!currentUser || !active) return;
  try {
    setUnlinkButton({visible: true, disabled: true});
    const connections = readAllConnections().filter(c => c.channel.id !== active.channel.id);
    await updateDoc(doc(db, "users", currentUser.uid), {
      youtubeConnections: connections,
      updatedAt: serverTimestamp()
    });
    saveConnections(connections);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-unlinked"));
  } catch (error) {
    console.error(error);
    setUnlinkButton({visible: true, disabled: false});
  }
}

if (connectButton && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
      saveConnections([]);
      setButton("Sign in to connect", true);
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get("link") === "required") {
      const prompt = document.getElementById("connectionPrompt");
      if (prompt) {
        prompt.textContent = "Please link a YouTube channel before analyzing videos.";
        prompt.style.color = "var(--rose)";
        prompt.style.fontWeight = "bold";
      }
    }

    try {
      await syncConnectionsFromFirestore(user);
    } catch (e) {
      updateUI();
    }
  });

  connectButton.addEventListener("click", connectYouTube);
  unlinkButton?.addEventListener("click", unlinkYouTube);

  channelSelector?.addEventListener("change", () => {
    const connections = readAllConnections();
    saveConnections(connections, channelSelector.value);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-connected", {
      detail: readActiveConnection()
    }));
  });
}
