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
import {
  exchangeYouTubeCode,
  revokeStoredYouTubeAuthorization
} from "./youtube-auth.js?v=3";
import {fetchStudioReport} from "./services/youtube-studio-analytics.js?v=2";
import {fetchYouTubeJson} from "./insights-youtube.js?v=5";

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
    prompt.classList.add("connection-prompt-error");
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
  sessionStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken,
    uid: currentUser.uid,
    channelId,
    expiresAt: Date.now() + 50 * 60 * 1000
  }));
  localStorage.removeItem(tokenStorageKey);
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
    const codeClient = window.google.accounts.oauth2.initCodeClient({
      client_id: googleOAuthClientId,
      scope: scopes.join(" "),
      access_type: "offline",
      include_granted_scopes: true,
      // Linking is always an explicit account choice. Silently reusing Google's
      // default identity can connect an empty personal channel instead of the
      // creator/Brand channel the user intended to authorize.
      prompt: "consent select_account",
      callback: async (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        try {
          const result = await exchangeYouTubeCode(
            response.code,
            window.location.origin,
            currentUser.uid
          );
          resolve(result.accessToken);
        } catch (error) {
          reject(error);
        }
      },
      error_callback: (error) => {
        if (error.type === "popup_closed") {
          reject(new Error("Connection canceled."));
          return;
        }
        reject(new Error(error.message || error.type || "Google authorization failed."));
      }
    });

    codeClient.requestCode();
  });
}

async function fetchChannel(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set(
    "part",
    "snippet,statistics,brandingSettings,status,contentDetails"
  );
  url.searchParams.set("mine", "true");
  const payload = await fetchYouTubeJson(url, accessToken);
  const channel = payload.items?.[0];
  if (!channel) throw new Error("No YouTube channel found.");
  return {
    channel: {
      id: channel.id,
      title: channel.snippet?.title || "",
      url: `https://www.youtube.com/channel/${channel.id}`,
      thumbnail: channel.snippet?.thumbnails?.default?.url || "",
      subscriberCount: channel.statistics?.subscriberCount || "",
      viewCount: channel.statistics?.viewCount || "",
      videoCount: channel.statistics?.videoCount || ""
    },
    ownerData: {
      customUrl: String(channel.snippet?.customUrl || "").slice(0, 200),
      country: String(channel.snippet?.country || "").slice(0, 8),
      description: String(channel.snippet?.description || "").slice(0, 2000),
      keywords: String(channel.brandingSettings?.channel?.keywords || "").slice(0, 1000),
      privacyStatus: String(channel.status?.privacyStatus || "").slice(0, 32),
      longUploadsStatus: String(channel.status?.longUploadsStatus || "").slice(0, 32),
      isLinked: Boolean(channel.status?.isLinked),
      madeForKids: Boolean(channel.status?.madeForKids),
      selfDeclaredMadeForKids: Boolean(channel.status?.selfDeclaredMadeForKids),
      uploadsPlaylistId: String(
        channel.contentDetails?.relatedPlaylists?.uploads || ""
      ).slice(0, 128),
      analyticsAccess: true,
      monetaryAnalyticsAccess: false
    }
  };
}

async function fetchAnalyticsSummary(accessToken) {
  const payload = await fetchStudioReport(accessToken, {
    days: 28,
    metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained"
  }).catch((error) => {
    throw new Error(
      "Private YouTube Analytics access was not granted. Relink the channel and approve Analytics access. " +
      error.message
    );
  });
  const row = payload.rows?.[0] || [];
  const optionalPayload = await fetchStudioReport(accessToken, {
    days: 28,
    metrics: "views,subscribersLost,likes,comments,shares,videosAddedToPlaylists,videosRemovedFromPlaylists"
  }).catch((error) => {
    console.warn("Optional channel engagement metrics are unavailable.", error);
    return {rows: []};
  });
  const optional = optionalPayload.rows?.[0] || [];
  const summary = {
    views: Number(row[0]) || 0,
    estimatedMinutesWatched: Number(row[1]) || 0,
    averageViewDuration: Number(row[2]) || 0,
    averageViewPercentage: Number(row[3]) || 0,
    subscribersGained: Number(row[4]) || 0,
    subscribersLost: Number(optional[1]) || 0,
    likes: Number(optional[2]) || 0,
    comments: Number(optional[3]) || 0,
    shares: Number(optional[4]) || 0,
    videosAddedToPlaylists: Number(optional[5]) || 0,
    videosRemovedFromPlaylists: Number(optional[6]) || 0,
    estimatedRevenue: null
  };
  try {
    const revenuePayload = await fetchStudioReport(accessToken, {
      days: 28,
      metrics: "estimatedRevenue"
    });
    summary.estimatedRevenue = revenuePayload.rows?.[0]?.[0] ?? null;
  } catch (error) {
    console.warn("Revenue data is unavailable for this channel.", error);
  }
  return summary;
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

    const {channel, ownerData} = await fetchChannel(accessToken);
    const connections = readAllConnections();
    const existingIdx = connections.findIndex(c => c.channel.id === channel.id);
    if (existingIdx === -1 && requiresChannelUpgrade(connections)) {
      promptForChannelUpgrade();
      updateUI();
      return;
    }

    saveCachedAccessToken(accessToken, channel.id);
    const analytics = await fetchAnalyticsSummary(accessToken);
    ownerData.monetaryAnalyticsAccess = analytics.estimatedRevenue !== null;
    const newConn = {
      channel,
      ownerData,
      analyticsSummary: analytics,
      connectedAt: Date.now()
    };

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
      prompt.classList.add("connection-prompt-error");
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
    await revokeStoredYouTubeAuthorization();
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
        prompt.classList.add("connection-prompt-error");
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
    localStorage.removeItem(tokenStorageKey);
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
