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
import {startStudioAutoRefresh} from "./services/studio-auto-refresh.js?v=1";
import {getRenewedYouTubeAccessToken} from "./youtube-auth.js?v=4";
import {
  readCachedYouTubeAccessToken
} from "./services/youtube-session.js?v=1";
import {compactNumber, numberValue} from "./insights-format.js?v=1";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import {createStatusSetter, setAriaBusy} from "./services/ui-state.js?v=1";
import {
  allConnectionsKey, connectionFieldValues as fieldValues, currency,
  hasUsableOverviewData, readActiveConnection, readCachedOverview,
  saveCachedConnection, saveCachedOverview
} from "./services/dashboard-cache.js?v=1";
import {
  fetchAnalyticsRows, fetchOverviewWithRenewal, renewedStudioToken
} from "./services/dashboard-youtube-reports.js?v=1";
import {
  renderHealth, renderInsights, renderSubscribersTrend, renderTrafficSources,
  renderUploadFrequency, renderViewsTrend, setElementText, setTrend, summarizeDaily
} from "./modules/dashboard-overview-renderer.js?v=1";
import {
  renderGrowthIntelligence, renderVideoTable, setIntelligence
} from "./modules/dashboard-video-intelligence.js?v=1";
import {renderFirstDayRanking, trackVideoMetadata} from "./modules/dashboard-launch-history.js?v=1";

const emptyValue = "\u00a0";
const setYouTubeSummaryStatus = createStatusSetter(document.querySelectorAll("[data-youtube-summary]"));
let selectedViewsDays = 30;
let viewsRangeRequestId = 0;

function renderOverviewData(connection, overviewData = null, user = null) {
  const analyticsSummary = connection?.analyticsSummary || {};
  const channel = connection?.channel || {};
  const dailySummary = summarizeDaily(overviewData?.daily || []);
  const studioTotalViews = numberValue(overviewData?.lifetimeViews);
  const publicTotalViews = numberValue(channel.viewCount);
  const totalViews = studioTotalViews ?? publicTotalViews;
  const subscribers = numberValue(channel.subscriberCount);
  const videos = numberValue(channel.videoCount);
  const avgDuration = dailySummary.durationCount ? dailySummary.durationTotal / dailySummary.durationCount : numberValue(analyticsSummary.averageViewDuration);
  const estimatedRevenue = numberValue(overviewData?.estimatedRevenue) ?? numberValue(analyticsSummary.estimatedRevenue);

  setElementText("[data-youtube-field=\"estimated-revenue\"]", currency(estimatedRevenue) || "Not available");
  setElementText(
    "[data-revenue-status]",
    estimatedRevenue !== null
      ? "Estimated revenue for the latest 28-day report."
      : overviewData?.revenueStatus === "permission-required"
        ? "Unavailable. Reconnect YouTube after monetary analytics access is approved."
        : "Available only for eligible monetized channels with monetary analytics access."
  );
  setElementText("[data-youtube-field=\"total-views\"]", totalViews !== null ? compactNumber(totalViews) : "—");
  setTrend("total-views", studioTotalViews !== null ? "Studio lifetime" : publicTotalViews !== null ? "Public total" : "Unavailable");
  setTrend("subscriber-count", subscribers !== null ? "Total" : "");
  setTrend("video-count", videos !== null ? "Uploads" : "", "warn");
  setTrend("average-view-duration", avgDuration !== null ? "28D" : "", "good");

  renderViewsTrend(overviewData);
  renderTrafficSources(overviewData);
  renderHealth(connection, overviewData);
  renderVideoTable(overviewData);
  renderFirstDayRanking(overviewData, connection, user);
  renderGrowthIntelligence(connection, overviewData);
  trackVideoMetadata(overviewData, connection, user);
  renderSubscribersTrend(connection, overviewData);
  renderUploadFrequency(overviewData);
}

function applyYouTubeData(connection, overviewData = null, user = null) {
  const values = fieldValues(connection);
  document.querySelectorAll("[data-youtube-field]").forEach((element) => { element.textContent = values[element.dataset.youtubeField] || emptyValue; });
  if (!connection) {
    renderInsights(null);
    renderOverviewData(null, null, user);
    window.viewcastDashboardState = {connection: null, overviewData: null, user: user || null};
    window.dispatchEvent(new CustomEvent("viewcast:dashboard-data", {detail: window.viewcastDashboardState}));
    return;
  }
  const summary = `Showing saved YouTube data for ${connection.channel.title}.`;
  document.querySelectorAll("[data-youtube-summary]").forEach((element) => { element.textContent = summary; });
  renderInsights(connection);
  renderOverviewData(connection, overviewData, user);
  window.viewcastDashboardState = {connection, overviewData, user: user || null};
  window.dispatchEvent(new CustomEvent("viewcast:dashboard-data", {detail: window.viewcastDashboardState}));
}

function rejectAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error(message)), milliseconds);
  });
}

async function storedConnections(db, user, fallbackConnection) {
  try {
    const snapshot = await Promise.race([
      getDoc(doc(db, "users", user.uid)),
      rejectAfter(4000, "Firestore connection lookup timed out.")
    ]);
    const data = snapshot.exists() ? snapshot.data() : {};
    const connections = Array.isArray(data.youtubeConnections)
      ? [...data.youtubeConnections]
      : [];
    if (data.youtubeConnection &&
        !connections.some((connection) => connection.channel?.id === data.youtubeConnection.channel?.id)) {
      connections.push(data.youtubeConnection);
    }
    // A newly created Firebase project has no user document yet. Preserve the
    // successfully linked local channel instead of replacing it with an empty
    // cloud result on the first dashboard load.
    return connections.length ? connections : fallbackConnection ? [fallbackConnection] : [];
  } catch (error) {
    console.warn("Using the locally saved channel while Firestore reconnects.", error);
    return fallbackConnection ? [fallbackConnection] : [];
  }
}

async function loadYouTubeData(user, db, days = 30) {
  const shouldLoadChannelHistory = Boolean(document.getElementById("subsChart"));
  if (shouldLoadChannelHistory) days = Math.max(days, 180);
  const activeConnection = readActiveConnection();
  const cachedOverview = readCachedOverview(user, activeConnection?.channel?.id);
  applyYouTubeData(activeConnection, cachedOverview, user);

  const connections = await storedConnections(db, user, activeConnection);

  localStorage.setItem(allConnectionsKey, JSON.stringify(connections));
  const currentActive = connections.find(c => c.channel.id === activeConnection?.channel?.id) || connections[0];
  if (currentActive) saveCachedConnection(currentActive);

  if (!currentActive?.channel?.id) return;
  let accessToken = readCachedYouTubeAccessToken(user.uid, currentActive.channel.id);
  if (!accessToken) {
    try {
      accessToken = await getRenewedYouTubeAccessToken(user.uid, currentActive.channel.id);
    } catch (error) {
      console.warn("Could not restore the linked YouTube Studio authorization.", error);
      if (!hasUsableOverviewData(cachedOverview)) {
        setIntelligence("freshness", "Studio authorization needs attention");
        setYouTubeSummaryStatus(error?.message || "The linked YouTube Studio authorization could not be restored.");
      }
      return;
    }
  }
  if (!accessToken) {
    if (!hasUsableOverviewData(cachedOverview)) setIntelligence("freshness", "Studio authorization unavailable");
    return;
  }

  try {
    const liveOverview = await fetchOverviewWithRenewal(
      user,
      currentActive.channel.id,
      accessToken,
      days
    );
    saveCachedOverview(user, currentActive.channel.id, liveOverview);
    if (days !== 30 || selectedViewsDays === 30) {
      applyYouTubeData(currentActive, liveOverview, user);
    }
  } catch (error) {
    console.warn("Could not refresh the private YouTube Studio dashboard.", error);
    if (!cachedOverview) {
      setIntelligence("freshness", "Studio sync failed");
      setYouTubeSummaryStatus(error?.message || "Private YouTube Studio analytics could not be loaded.");
    }
  }
}

async function loadViewsTrendRange(user, days) {
  const requestId = ++viewsRangeRequestId;
  selectedViewsDays = days;
  const connection = readActiveConnection();
  if (!connection?.channel?.id) {
    renderViewsTrend(null);
    return;
  }
  let accessToken = readCachedYouTubeAccessToken(user.uid, connection.channel.id) || await getRenewedYouTubeAccessToken(
    user.uid,
    connection.channel.id
  ).catch(() => "");
  if (!accessToken || requestId !== viewsRangeRequestId) return;
  const reportOptions = {
    metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained",
    dimensions: "day",
    sort: "day",
    days
  };
  let rows;
  try {
    rows = await fetchAnalyticsRows(accessToken, reportOptions);
  } catch (error) {
    if (error?.status !== 401 && error?.status !== 403) throw error;
    accessToken = await renewedStudioToken(user, connection.channel.id);
    rows = await fetchAnalyticsRows(accessToken, reportOptions);
  }
  if (requestId !== viewsRangeRequestId) return;
  renderViewsTrend({daily: rows});
}

if (firebaseConfigured && document.querySelector("[data-youtube-field], [data-youtube-summary]")) {
  applyYouTubeData(readActiveConnection());
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    loadYouTubeData(user, db).catch(console.error);

    document.querySelectorAll("[data-views-days]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (button.classList.contains("active")) return;
        const days = Number(button.dataset.viewsDays);
        if (!days) return;
        button.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        setAriaBusy(button, true);
        try {
          await loadViewsTrendRange(user, days);
        } catch (error) {
          console.error("Could not load the selected views range.", error);
        } finally {
          setAriaBusy(button, false);
        }
      });
    });
  });

  startStudioAutoRefresh(() => {
    const user = auth.currentUser;
    return user ? loadYouTubeData(user, db) : null;
  });

  window.addEventListener("viewcast:youtube-connected", (event) => {
    saveCachedConnection(event.detail);
    const auth = getAuth();
    applyYouTubeData(event.detail, null, auth.currentUser);
    if (auth.currentUser) loadYouTubeData(auth.currentUser, getFirestore());
  });

  window.addEventListener("viewcast:youtube-unlinked", () => {
    applyYouTubeData(null, null, getAuth().currentUser);
  });

  window.addEventListener("viewcast:dashboard-filter", () => {
    const current = window.viewcastDashboardState;
    if (current) renderOverviewData(current.connection, current.overviewData, current.user);
  });
}
