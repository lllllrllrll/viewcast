import {getApps, initializeApp} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getAuth, onAuthStateChanged} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {doc, getDoc, getFirestore, serverTimestamp, setDoc, updateDoc} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {firebaseConfig, firebaseConfigured, googleOAuthClientId} from "./firebase-config.js";
import {createChannelContextController} from "./modules/youtube-channel-context.js?v=1";
import {revokeStoredYouTubeAuthorization} from "./youtube-auth.js?v=4";
import {
  createYouTubeConnections,
  MAX_LINKED_CHANNELS
} from "./services/youtube-connections.js?v=1";
import {
  fetchAnalyticsSummary,
  fetchOwnedChannel,
  requestYouTubeAccessToken
} from "./services/youtube-link-api.js?v=1";
import {createStatusSetter, setControlsDisabled} from "./services/ui-state.js?v=1";

const connectButton = document.getElementById("connectYouTube");
const unlinkButton = document.getElementById("unlinkYouTube");
const channelSelector = document.getElementById("channelSelector");
const channelSelectorWrap = document.getElementById("channelSelectorWrap");
const connectionPrompt = document.getElementById("connectionPrompt");
const setConnectionPrompt = createStatusSetter(connectionPrompt, {className: "connection-prompt-error"});
let currentUser = null;
let db = null;

function requiresChannelUpgrade(connections = connectionStore.readAll()) {
  return connections.length >= 1;
}

function promptForChannelUpgrade() {
  const message = "The Basic plan includes one linked channel. Upgrade to Pro or Premium to link another channel.";
  if (typeof window.showPlanModal === "function") window.showPlanModal(message);
  else setConnectionPrompt(message);
}

function setButton(label, disabled = false) {
  if (!connectButton) return;
  const normalized = String(label || "").trim();
  connectButton.hidden = !normalized;
  if (!normalized) return setControlsDisabled(connectButton, true);
  const icon = connectButton.querySelector("svg");
  connectButton.textContent = "";
  if (icon) connectButton.append(icon);
  connectButton.append(document.createTextNode(normalized));
  setControlsDisabled(connectButton, disabled);
}

function setUnlinkButton(visible, disabled = false) {
  if (!unlinkButton) return;
  unlinkButton.hidden = !visible;
  setControlsDisabled(unlinkButton, disabled);
}

function updateUI() {
  const active = connectionStore.readActive();
  const connections = connectionStore.readAll();
  if (!connections.length) {
    channelSelectorWrap.hidden = true;
    setUnlinkButton(false, true);
    setButton("Connect YouTube");
    return;
  }
  channelSelectorWrap.hidden = false;
  channelSelector.replaceChildren(...connections.map((connection) => {
    const option = document.createElement("option");
    option.value = String(connection.channel?.id || "");
    option.textContent = String(connection.channel?.title || "Untitled channel");
    option.selected = active?.channel?.id === connection.channel?.id;
    return option;
  }));
  setUnlinkButton(true);
  if (connections.length >= MAX_LINKED_CHANNELS) setButton("5 Channels Linked", true);
  else if (requiresChannelUpgrade(connections)) setButton("Reconnect YouTube");
  else setButton("Link New Channel");
}

const connectionStore = createYouTubeConnections({
  getCurrentUser: () => currentUser,
  onUpdate: updateUI
});
const contextController = createChannelContextController({
  getCurrentUser: () => currentUser,
  getDb: () => db
});

async function syncConnectionsFromFirestore(user) {
  try {
    const snapshot = await getDoc(doc(db, "users", user.uid));
    const data = snapshot.exists() ? snapshot.data() : {};
    let connections = data.youtubeConnections || [];
    if (data.youtubeConnection && !connections.some((item) => item.channel.id === data.youtubeConnection.channel.id)) {
      connections.push(data.youtubeConnection);
    }
    if (!connections.length) connections = connectionStore.readAll();
    connectionStore.save(connections, connectionStore.readActive()?.channel?.id);
  } catch (error) {
    console.error("YouTube connection sync failed.", error);
    updateUI();
  }
}

async function connectYouTube() {
  if (!currentUser) return;
  try {
    setButton("Connecting...", true);
    const accessToken = await requestYouTubeAccessToken(googleOAuthClientId, currentUser);
    const {channel, ownerData} = await fetchOwnedChannel(accessToken);
    const connections = connectionStore.readAll();
    const existingIndex = connections.findIndex((item) => item.channel.id === channel.id);
    if (existingIndex === -1 && requiresChannelUpgrade(connections)) {
      promptForChannelUpgrade();
      return updateUI();
    }
    connectionStore.saveAccessToken(accessToken, channel.id);
    let analyticsSummary = {};
    let analyticsWarning = "";
    try {
      analyticsSummary = await fetchAnalyticsSummary(accessToken);
    } catch (error) {
      analyticsWarning = error?.message || "YouTube Analytics did not return a summary yet.";
      console.warn("YouTube linked, but its Analytics summary was unavailable.", error);
    }
    ownerData.monetaryAnalyticsAccess = analyticsSummary.estimatedRevenue != null;
    const connection = {channel, ownerData, analyticsSummary, connectedAt: Date.now()};
    if (existingIndex >= 0) connections[existingIndex] = connection;
    else connections.push(connection);
    // The YouTube connection and token are sufficient to populate this browser.
    // Cloud sync is best-effort so a new/misconfigured Firestore database cannot
    // discard an otherwise successful YouTube authorization.
    connectionStore.save(connections, channel.id);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-connected", {detail: connection}));
    try {
      await setDoc(doc(db, "users", currentUser.uid), {
        youtubeConnections: connections,
        updatedAt: serverTimestamp()
      }, {merge: true});
    } catch (error) {
      console.warn("Channel linked locally, but Firestore sync failed.", error);
      setConnectionPrompt("Channel linked on this device. Cloud sync is unavailable.");
      return;
    }
    if (analyticsWarning) {
      setConnectionPrompt(`Channel linked, but analytics could not load: ${analyticsWarning}`);
    } else {
      setConnectionPrompt("Channel linked. YouTube Analytics is loading.");
    }
  } catch (error) {
    console.error("YouTube connection failed.", error);
    updateUI();
    if (error.message !== "Connection canceled.") {
      setConnectionPrompt(`Failed to link channel: ${error.message || "Unknown error"}`);
    }
  }
}

async function unlinkYouTube() {
  const active = connectionStore.readActive();
  if (!currentUser || !active) return;
  try {
    setUnlinkButton(true, true);
    const connections = connectionStore.readAll().filter((item) => item.channel.id !== active.channel.id);
    await updateDoc(doc(db, "users", currentUser.uid), {
      youtubeConnections: connections,
      updatedAt: serverTimestamp()
    });
    await revokeStoredYouTubeAuthorization();
    connectionStore.clearAccessToken();
    connectionStore.save(connections);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-unlinked"));
  } catch (error) {
    console.error("YouTube unlink failed.", error);
    setUnlinkButton(true);
  }
}

if (connectButton && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;
    if (!user) {
      connectionStore.save([]);
      return setButton("Sign in to connect", true);
    }
    if (new URLSearchParams(window.location.search).get("link") === "required") {
      setConnectionPrompt("Please link a YouTube channel before analyzing videos.");
    }
    await Promise.all([syncConnectionsFromFirestore(user), contextController.load(user)]).catch(updateUI);
  });
  connectButton.addEventListener("click", connectYouTube);
  unlinkButton?.addEventListener("click", unlinkYouTube);
  channelSelector?.addEventListener("change", () => {
    connectionStore.clearAccessToken();
    connectionStore.save(connectionStore.readAll(), channelSelector.value);
    window.dispatchEvent(new CustomEvent("viewcast:youtube-connected", {detail: connectionStore.readActive()}));
  });
  window.addEventListener("storage", (event) => { if (event.key === "viewcast:plan") updateUI(); });
}
