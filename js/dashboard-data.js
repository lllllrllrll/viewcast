import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const emptyValue = "\u00a0";

function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: number >= 1000 ? 1 : 0
  }).format(number);
}

function wholeNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en").format(Math.round(number));
}

function watchHours(minutes) {
  const number = numberValue(minutes);
  if (number === null) return "";
  return compactNumber(number / 60);
}

function duration(seconds) {
  const number = numberValue(seconds);
  if (number === null) return "";
  const totalSeconds = Math.max(0, Math.round(number));
  const mins = Math.floor(totalSeconds / 60);
  const secs = String(totalSeconds % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function savedConnectionFromProfile(profile = {}) {
  const connection = profile.youtubeConnection || {};
  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};

  if (!channel.id && !channel.title && !profile.youtubeChannelUrl) return null;

  return {
    channel: {
      ...channel,
      title: channel.title || profile.youtubeChannelTitle || "",
      url: channel.url || profile.youtubeChannelUrl || ""
    },
    analyticsSummary
  };
}

function fieldValues(connection) {
  if (!connection) return {};

  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};
  return {
    "channel-title": channel.title || "",
    "total-views": compactNumber(channel.viewCount),
    "subscriber-count": compactNumber(channel.subscriberCount),
    "video-count": wholeNumber(channel.videoCount),
    "period-views": compactNumber(analyticsSummary.views),
    "watch-hours": watchHours(analyticsSummary.estimatedMinutesWatched),
    "average-view-duration": duration(analyticsSummary.averageViewDuration),
    "subscribers-gained": wholeNumber(analyticsSummary.subscribersGained)
  };
}

function applyYouTubeData(connection) {
  const values = fieldValues(connection);

  document.querySelectorAll("[data-youtube-field]").forEach((element) => {
    const value = values[element.dataset.youtubeField] || "";
    element.textContent = value || emptyValue;
  });

  document.querySelectorAll("[data-youtube-summary]").forEach((element) => {
    element.dataset.youtubeDefault ||= element.textContent;
  });

  if (!connection) {
    document.querySelectorAll("[data-youtube-summary]").forEach((element) => {
      element.textContent = element.dataset.youtubeDefault || "";
    });
    return;
  }

  const {channel, analyticsSummary} = connection;
  const title = channel.title || "your linked channel";
  const summaryParts = [
    analyticsSummary.views !== undefined ? `${wholeNumber(analyticsSummary.views)} views` : "",
    analyticsSummary.estimatedMinutesWatched !== undefined ? `${watchHours(analyticsSummary.estimatedMinutesWatched)} watch hours` : "",
    analyticsSummary.subscribersGained !== undefined ? `${wholeNumber(analyticsSummary.subscribersGained)} subscribers gained` : ""
  ].filter(Boolean);

  const summary = summaryParts.length
    ? `Showing saved YouTube data for ${title}. Last 28 days: ${summaryParts.join(", ")}.`
    : `Showing saved YouTube channel data for ${title}.`;
  document.querySelectorAll("[data-youtube-summary]").forEach((element) => {
    element.textContent = summary;
  });
}

async function loadYouTubeData(user, db) {
  const snapshot = await getDoc(doc(db, "users", user.uid));
  const profile = snapshot.exists() ? snapshot.data() : {};
  applyYouTubeData(savedConnectionFromProfile(profile));
}

if (firebaseConfigured && document.querySelector("[data-youtube-field], [data-youtube-summary]")) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    loadYouTubeData(user, db).catch((error) => {
      console.error("Could not load linked YouTube data.", error);
    });
  });

  window.addEventListener("viewcast:youtube-connected", (event) => {
    applyYouTubeData(event.detail);
  });

  window.addEventListener("viewcast:youtube-unlinked", () => {
    applyYouTubeData(null);
  });
}
