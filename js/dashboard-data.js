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
const connectionStorageKey = "viewcastYouTubeConnection";
const channelStorageKey = "viewcastYouTubeChannel";

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

function normalizeConnection(value) {
  if (!value) return null;
  if (value.channel) {
    return {
      channel: value.channel || {},
      analyticsSummary: value.analyticsSummary || {}
    };
  }
  if (value.id || value.title || value.url) {
    return {
      channel: value,
      analyticsSummary: {}
    };
  }
  return null;
}

function readCachedConnection() {
  try {
    const savedConnection = normalizeConnection(
      JSON.parse(localStorage.getItem(connectionStorageKey) || "null")
    );
    if (savedConnection) return savedConnection;

    return normalizeConnection(
      JSON.parse(localStorage.getItem(channelStorageKey) || "null")
    );
  } catch (error) {
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(channelStorageKey);
    return null;
  }
}

function saveCachedConnection(connection) {
  if (!connection) {
    localStorage.removeItem(connectionStorageKey);
    localStorage.removeItem(channelStorageKey);
    return;
  }

  localStorage.setItem(connectionStorageKey, JSON.stringify(connection));
  localStorage.setItem(channelStorageKey, JSON.stringify(connection.channel || {}));
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

function insightItems(connection) {
  if (!connection) {
    return [
      {
        title: "Connect YouTube",
        body: "Link your channel from My Channel so ViewCast can generate recommendations from real analytics.",
        label: "Setup"
      },
      {
        title: "No channel data yet",
        body: "AI Insights stays blank until verified YouTube data is available.",
        label: "Waiting"
      },
      {
        title: "Avoid fake metrics",
        body: "Recommendations are generated only from saved YouTube channel and analytics values.",
        label: "Data"
      }
    ];
  }

  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};
  const views = numberValue(analyticsSummary.views);
  const watchMinutes = numberValue(analyticsSummary.estimatedMinutesWatched);
  const avgDuration = numberValue(analyticsSummary.averageViewDuration);
  const subscribersGained = numberValue(analyticsSummary.subscribersGained);
  const totalSubscribers = numberValue(channel.subscriberCount);
  const totalViews = numberValue(channel.viewCount);
  const videos = numberValue(channel.videoCount);
  const items = [];

  if (views !== null && watchMinutes !== null) {
    const minutesPerView = views > 0 ? watchMinutes / views : 0;
    if (minutesPerView >= 3) {
      items.push({
        title: "Double down on long-form retention",
        body: "Your recent viewers are averaging about " + (Math.round(minutesPerView * 10) / 10) + " minutes watched per view. Build follow-up videos around the formats that hold attention longest.",
        label: "Retention"
      });
    } else if (views > 0) {
      items.push({
        title: "Tighten the opening minute",
        body: "Recent watch time is about " + (Math.round(minutesPerView * 10) / 10) + " minutes per view. Test faster hooks, earlier payoff, and clearer video promises.",
        label: "Hook"
      });
    }
  }

  if (avgDuration !== null) {
    items.push({
      title: avgDuration >= 180 ? "Package deeper follow-ups" : "Improve pacing before the midpoint",
      body: avgDuration >= 180
        ? "Average view duration is " + duration(avgDuration) + ", which can support deeper sequels, series, and pinned playlists."
        : "Average view duration is " + duration(avgDuration) + ". Use chapters, pattern breaks, and earlier examples to keep viewers moving.",
      label: "AVD"
    });
  }

  if (subscribersGained !== null && views !== null) {
    const subRate = views > 0 ? (subscribersGained / views) * 100 : 0;
    items.push({
      title: subRate >= 0.5 ? "Turn high-intent viewers into a series" : "Strengthen subscriber calls-to-action",
      body: subRate >= 0.5
        ? "Subscriber conversion is about " + (Math.round(subRate * 100) / 100) + "% of recent views. Create a clear next episode or recurring format."
        : "Subscriber conversion is about " + (Math.round(subRate * 100) / 100) + "% of recent views. Add a specific reason to subscribe near your strongest moment.",
      label: "Growth"
    });
  }

  if (totalViews !== null && videos !== null && videos > 0) {
    items.push({
      title: "Audit outlier videos",
      body: "Your channel averages about " + compactNumber(totalViews / videos) + " views per video. Compare top performers against recent uploads for topic and title patterns.",
      label: "Audit"
    });
  }

  if (totalSubscribers !== null) {
    items.push({
      title: "Build for returning viewers",
      body: compactNumber(totalSubscribers) + " subscribers gives you a base to test community posts, premieres, and repeatable content pillars.",
      label: "Audience"
    });
  }

  if (!items.length) {
    items.push({
      title: "Reconnect YouTube analytics",
      body: "Channel metadata is available, but the 28-day analytics summary is missing. Reconnect YouTube from My Channel to refresh it.",
      label: "Refresh"
    });
  }

  return items.slice(0, 3);
}

function renderInsights(connection) {
  document.querySelectorAll("[data-ai-insights]").forEach((container) => {
    const items = insightItems(connection);
    container.innerHTML = items.map((item) => `
      <div class="activity-item">
        <i class="dot"></i>
        <div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.body)}</span></div>
        <time>${escapeHtml(item.label)}</time>
      </div>
    `).join("");
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    renderInsights(null);
    return;
  }

  const channel = connection.channel || {};
  const analyticsSummary = connection.analyticsSummary || {};
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
  renderInsights(connection);
}

async function loadYouTubeData(user, db) {
  applyYouTubeData(readCachedConnection());

  const snapshot = await getDoc(doc(db, "users", user.uid));
  const profile = snapshot.exists() ? snapshot.data() : {};
  const connection = savedConnectionFromProfile(profile);
  if (connection) saveCachedConnection(connection);
  applyYouTubeData(connection || readCachedConnection());
}

if (firebaseConfigured && document.querySelector("[data-youtube-field], [data-youtube-summary]")) {
  applyYouTubeData(readCachedConnection());
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
    saveCachedConnection(event.detail);
    applyYouTubeData(event.detail);
  });

  window.addEventListener("viewcast:youtube-unlinked", () => {
    saveCachedConnection(null);
    applyYouTubeData(null);
  });
}
