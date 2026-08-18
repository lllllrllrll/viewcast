import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured, googleOAuthClientId } from "./firebase-config.js";
import { revokeYouTubeAccessToken } from "./privacy.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
];

const connectButton = document.getElementById("connectYouTube");
const unlinkButton = document.getElementById("unlinkYouTube");
const channelSelector = document.getElementById("channelSelector");
const channelSelectorWrap = document.getElementById("channelSelectorWrap");
const channelContextForm = document.getElementById("channelContextForm");
const channelTopicInput = document.getElementById("channelTopic");
const channelContextInput = document.getElementById("channelContext");
const channelContextStatus = document.getElementById("channelContextStatus");
const saveChannelContextButton = document.getElementById("saveChannelContext");

const allConnectionsKey = "viewcastYouTubeAllConnections";
const activeConnectionKey = "viewcastYouTubeConnection";
const channelStorageKey = "viewcastYouTubeChannel";
const tokenStorageKey = "viewcastYouTubeAccessToken";
const channelContextStorageKeyPrefix = "viewcastChannelContext:";
const MAX_LINKED_CHANNELS = 5;
const BASIC_LINKED_CHANNELS = 1;

let currentUser = null;
let auth = null;
let db = null;
let linkedConnections = [];
let googleIdentityScriptPromise = null;

function currentPlan() {
  return "basic";
}

function requiresChannelUpgrade(connections = readAllConnections()) {
  return currentPlan() === "basic" && connections.length >= BASIC_LINKED_CHANNELS;
}

function promptForChannelUpgrade() {
  const message = "The Basic plan includes one linked channel. Upgrade to Pro or Premium to link another channel.";
  if (typeof window.showPlanModal === "function") {
    window.showPlanModal(message);
    return;
  }

  const prompt = document.getElementById("connectionPrompt");
  if (prompt) {
    prompt.textContent = message;
    prompt.style.color = "var(--rose)";
    prompt.style.fontWeight = "bold";
  }
}

function setButton(label, disabled = false) {
  if (!connectButton) return;
  const normalizedLabel = String(label || "").trim();
  connectButton.hidden = !normalizedLabel;
  if (!normalizedLabel) {
    connectButton.disabled = true;
    return;
  }

  const icon = connectButton.querySelector("svg");
  connectButton.textContent = "";
  if (icon) connectButton.append(icon);
  connectButton.append(document.createTextNode(normalizedLabel));
  connectButton.disabled = disabled;
}

function updateUI() {
  const active = readActiveConnection();
  const connections = readAllConnections();

  if (connections.length > 0) {
    channelSelectorWrap.hidden = false;
    channelSelector.replaceChildren(...connections.map((connection) => {
      const option = document.createElement("option");
      option.value = String(connection.channel?.id || "");
      option.textContent = String(connection.channel?.title || "Untitled channel");
      option.selected = active?.channel?.id === connection.channel?.id;
      return option;
    }));

    setUnlinkButton({visible: true, disabled: false});
    if (connections.length >= MAX_LINKED_CHANNELS) {
      setButton("5 Channels Linked", true);
    } else if (requiresChannelUpgrade(connections)) {
      setButton("Upgrade to Link Another Channel");
    } else {
      setButton("Link New Channel");
    }
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
    let connections = JSON.parse(localStorage.getItem(allConnectionsKey) || "[]");

    // Migration: If all connections is empty but we have an active one, wrap it
    if (connections.length === 0) {
      const active = JSON.parse(localStorage.getItem(activeConnectionKey) || "null");
      if (active && active.channel) {
        connections = [active];
        localStorage.setItem(allConnectionsKey, JSON.stringify(connections));
      }
    }

    return connections;
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
  connections = connections.slice(0, MAX_LINKED_CHANNELS);
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

function saveCachedAccessToken(accessToken, channelId) {
  if (!accessToken || !currentUser) return;
  localStorage.removeItem(tokenStorageKey);
  sessionStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    channelId,
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
}

function channelContextStorageKey(user = currentUser) {
  return user ? `${channelContextStorageKeyPrefix}${user.uid}` : "";
}

function cacheChannelContext(user, value) {
  const key = channelContextStorageKey(user);
  if (!key) return;
  sessionStorage.setItem(key, JSON.stringify(value));
}

function renderChannelContext(value = {}) {
  if (channelTopicInput) channelTopicInput.value = value.channelTopic || "";
  if (channelContextInput) channelContextInput.value = value.channelContext || "";
}

async function loadChannelContext(user) {
  const key = channelContextStorageKey(user);
  let localValue = {};
  const hasLocalValue = Boolean(sessionStorage.getItem(key));
  try {
    localValue = JSON.parse(sessionStorage.getItem(key) || "{}");
    renderChannelContext(localValue);
  } catch {
    sessionStorage.removeItem(key);
  }

  try {
    const snapshot = await getDoc(doc(db, "users", user.uid));
    const data = snapshot.exists() ? snapshot.data() : {};
    const value = {
      channelTopic: String(hasLocalValue ? (localValue.channelTopic || "") : (data.channelTopic || "")).slice(0, 120),
      channelContext: String(hasLocalValue ? (localValue.channelContext || "") : (data.channelContext || "")).slice(0, 1000)
    };
    cacheChannelContext(user, value);
    renderChannelContext(value);
  } catch (error) {
    renderChannelContext(localValue);
    console.warn("Could not load saved channel context.", error);
  }
}

function clearCachedInsightsForUser(user) {
  const prefix = `viewcastAiInsights:${user.uid}:`;
  Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => localStorage.removeItem(key));
}

async function saveChannelContext(event) {
  event.preventDefault();
  if (!currentUser || !db) return;
  const value = {
    channelTopic: channelTopicInput?.value.trim().slice(0, 120) || "",
    channelContext: channelContextInput?.value.trim().slice(0, 1000) || ""
  };
  cacheChannelContext(currentUser, value);
  clearCachedInsightsForUser(currentUser);
  renderChannelContext(value);
  saveChannelContextButton.disabled = true;
  channelContextStatus.textContent = "Saving...";
  try {
    await setDoc(doc(db, "users", currentUser.uid), {
      ...value,
      updatedAt: serverTimestamp()
    }, {merge: true});
    channelContextStatus.textContent = "Saved. New AI insights will use this context.";
  } catch (error) {
    console.error("Could not save channel context.", error);
    channelContextStatus.textContent = "Saved on this device. Cloud sync is unavailable.";
  } finally {
    saveChannelContextButton.disabled = false;
  }
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

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Identity Services could not load."));
    document.head.append(script);
  });

  return googleIdentityScriptPromise;
}

async function requestYouTubeAccessToken() {
  if (!googleOAuthClientId) {
    throw new Error("Missing Google OAuth client ID. Add your Web OAuth client ID in js/firebase-config.js.");
  }

  await loadGoogleIdentityServices();

  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: googleOAuthClientId,
      scope: scopes.join(" "),
      prompt: "consent select_account",
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: (error) => {
        if (error.type === "popup_closed") {
          reject(new Error("Connection canceled."));
          return;
        }
        reject(new Error(error.message || error.type || "Google authorization failed."));
      }
    });

    tokenClient.requestAccessToken();
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
    const summary = { views: views || 0, estimatedMinutesWatched: minutes || 0, averageViewDuration: avd || 0, subscribersGained: subs || 0 };
    const revenueUrl = new URL(url);
    revenueUrl.searchParams.set("metrics", "estimatedRevenue");
    try {
      const revenuePayload = await fetchJson(revenueUrl, accessToken);
      summary.estimatedRevenue = revenuePayload.rows?.[0]?.[0] ?? null;
    } catch (error) {
      console.warn("Revenue data is unavailable for this channel.", error);
    }
    return summary;
  } catch (e) { return null; }
}

async function connectYouTube() {
  if (!currentUser) return;
  if (requiresChannelUpgrade()) {
    promptForChannelUpgrade();
    return;
  }
  try {
    setButton("Connecting...", true);
    const accessToken = await requestYouTubeAccessToken();

    const channel = await fetchChannel(accessToken);
    const connections = readAllConnections();
    const existingIdx = connections.findIndex(c => c.channel.id === channel.id);
    if (existingIdx === -1 && requiresChannelUpgrade(connections)) {
      promptForChannelUpgrade();
      updateUI();
      return;
    }

    saveCachedAccessToken(accessToken, channel.id);
    const analytics = await fetchAnalyticsSummary(accessToken);
    const newConn = { channel, analyticsSummary: analytics, connectedAt: Date.now() };

    if (existingIdx > -1) connections[existingIdx] = newConn;
    else {
      if (connections.length >= MAX_LINKED_CHANNELS) {
        throw new Error("A maximum of 5 YouTube channels can be linked.");
      }
      connections.push(newConn);
    }

    await setDoc(doc(db, "users", currentUser.uid), {
      youtubeConnections: connections,
      updatedAt: serverTimestamp()
    }, { merge: true });

    saveConnections(connections, channel.id);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-connected", { detail: newConn }));
  } catch (error) {
    console.error("Connect failed:", error);
    updateUI();

    if (error.message === "Connection canceled.") return;

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
    let token = "";
    try {
      token = JSON.parse(sessionStorage.getItem(tokenStorageKey) || "null")?.accessToken || "";
    } catch {
      token = "";
    }
    const connections = readAllConnections().filter(c => c.channel.id !== active.channel.id);
    await updateDoc(doc(db, "users", currentUser.uid), {
      youtubeConnections: connections,
      updatedAt: serverTimestamp()
    });
    await revokeYouTubeAccessToken(token);
    sessionStorage.removeItem(tokenStorageKey);
    localStorage.removeItem(tokenStorageKey);
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
    currentUser = user || null;
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
      await Promise.all([
        syncConnectionsFromFirestore(user),
        loadChannelContext(user)
      ]);
    } catch (e) {
      updateUI();
    }
  });

  connectButton.addEventListener("click", connectYouTube);
  unlinkButton?.addEventListener("click", unlinkYouTube);
  channelContextForm?.addEventListener("submit", saveChannelContext);

  channelSelector?.addEventListener("change", () => {
    const connections = readAllConnections();
    sessionStorage.removeItem(tokenStorageKey);
    saveConnections(connections, channelSelector.value);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-connected", {
      detail: readActiveConnection()
    }));
  });

  window.addEventListener("storage", (event) => {
    if (event.key === "viewcast:plan") updateUI();
  });
}
