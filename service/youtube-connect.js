import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import {
  googleOAuthClientId,
  youtubeOAuthConfigured,
  youtubeOAuthExchangeUrl
} from "./youtube-config.js";

const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
].join(" ");

const button = document.getElementById("connectYouTube");
let currentUser = null;
let codeClient = null;

function setButton(label, disabled = false) {
  if (!button) return;
  const icon = button.querySelector("svg");
  button.textContent = "";
  if (icon) button.append(icon);
  button.append(document.createTextNode(label));
  button.disabled = disabled;
}

function waitForGoogleIdentity() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        window.clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt > 8000) {
        window.clearInterval(timer);
        reject(new Error("Google Identity Services did not load."));
      }
    }, 100);
  });
}

async function exchangeCode(code) {
  const token = await currentUser.getIdToken();
  const response = await fetch(youtubeOAuthExchangeUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Requested-With": "XmlHttpRequest"
    },
    body: JSON.stringify({
      code,
      redirectUri: window.location.origin
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Could not connect YouTube.");
  }

  return payload;
}

async function setupYouTubeConnect() {
  if (!button) return;

  if (!youtubeOAuthConfigured) {
    setButton("Add Google Client ID", true);
    button.title = "Add your OAuth client ID in service/youtube-config.js.";
    return;
  }

  try {
    await waitForGoogleIdentity();
  } catch (error) {
    console.error(error);
    setButton("Google OAuth unavailable", true);
    return;
  }

  codeClient = window.google.accounts.oauth2.initCodeClient({
    client_id: googleOAuthClientId,
    scope: scopes,
    ux_mode: "popup",
    callback: async (response) => {
      if (response.error) {
        setButton("Connect YouTube");
        console.error("Google OAuth failed.", response);
        return;
      }

      try {
        setButton("Connecting...", true);
        const result = await exchangeCode(response.code);
        const channelTitle = result.channel?.title || "YouTube connected";
        localStorage.setItem("viewcastYouTubeChannel", JSON.stringify(result.channel || {}));
        setButton(channelTitle, false);
      } catch (error) {
        console.error(error);
        setButton("Connect YouTube");
        button.title = error.message;
      }
    }
  });

  setButton("Connect YouTube");
}

if (button && firebaseConfigured) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (!user) {
      setButton("Sign in to connect", true);
      return;
    }
    setupYouTubeConnect();
  });

  button.addEventListener("click", () => {
    if (!currentUser || !codeClient) return;
    codeClient.requestCode();
  });
}
