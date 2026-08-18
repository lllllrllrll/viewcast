(function () {
  const connectionsKey = "viewcastYouTubeAllConnections";
  const activeConnectionKey = "viewcastYouTubeConnection";
  const activeChannelKey = "viewcastYouTubeChannel";
  const goalsKey = "viewcastDashboardGoals";
  const hiddenWidgetsKey = "viewcastDashboardHiddenWidgets";
  let state = {connection: null, overviewData: null, user: null};

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { localStorage.removeItem(key); return fallback; }
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function format(value, digits = 0) {
    return new Intl.NumberFormat("en", {maximumFractionDigits: digits}).format(number(value));
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function videoFormat(video) {
    const match = String(video?.contentDetails?.duration || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    const seconds = match ? number(match[1]) * 3600 + number(match[2]) * 60 + number(match[3]) : 0;
    if (seconds && seconds <= 60) return "Short";
    if (seconds >= 1200) return "Long-form";
    return "Video";
  }

  function analyticsMap(data = state.overviewData) {
    return new Map((data?.videoAnalytics || []).map((row) => [String(row[0]), {
      views: number(row[1]), watchMinutes: number(row[2]), averageViewDuration: number(row[3]),
      retention: number(row[4]), subscribers: number(row[5]), likes: number(row[6]),
      comments: number(row[7]), shares: number(row[8])
    }]));
  }

  function mountUi() {
    const grid = document.querySelector(".dashboard-grid");
    if (!grid || document.getElementById("dashboardControlBar")) return;
    grid.insertAdjacentHTML("beforebegin", `
      <section class="dashboard-control-bar" id="dashboardControlBar" aria-label="Dashboard controls">
        <label>Range<select id="dashboardRange"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label>
        <label>Channel<select id="dashboardChannel"><option value="">No channel connected</option></select></label>
        <label>Format<select id="dashboardFormat"><option value="all">All formats</option><option>Short</option><option>Video</option><option>Long-form</option></select></label>
        <label>Comparison baseline<select id="dashboardBenchmark"><option value="5">Average of 5 other recent uploads</option><option value="10" selected>Average of 10 other recent uploads</option><option value="20">Average of 20 other recent uploads</option></select></label>
        <button class="account-cancel-button" id="customizeDashboard" type="button">Customize</button>
        <span class="dashboard-quality-summary" id="dashboardQualitySummary">Waiting for channel data</span>
      </section>
      <section class="dashboard-customizer" id="dashboardCustomizer" hidden>
        <div><strong>Visible widgets</strong><button class="close-button" id="closeDashboardCustomizer" type="button" aria-label="Close customization">&times;</button></div>
        <div class="dashboard-widget-options" id="dashboardWidgetOptions"></div>
      </section>
    `);
    grid.insertAdjacentHTML("beforeend", `
      <article class="panel full" data-dashboard-widget="Video Comparison">
        <div class="panel-head"><div><h3>Video Comparison</h3><p>Compare two uploads against the selected custom benchmark.</p></div></div>
        <div class="comparison-controls"><select id="compareVideoA" aria-label="First comparison video"></select><span>vs.</span><select id="compareVideoB" aria-label="Second comparison video"></select></div>
        <div class="comparison-results" id="comparisonResults"><p class="signal-empty">Connect YouTube Analytics to compare videos.</p></div>
      </article>
      <article class="panel large" data-dashboard-widget="Goals">
        <div class="panel-head"><div><h3>Goals</h3><p>Track progress toward channel views, subscribers, watch hours, and revenue targets.</p></div><button class="account-cancel-button" id="editGoals" type="button">Edit goals</button></div>
        <form class="goal-form" id="goalForm" hidden><label>Views<input name="views" type="number" min="0"></label><label>Subscribers<input name="subscribers" type="number" min="0"></label><label>Watch hours<input name="watchHours" type="number" min="0"></label><label>Revenue ($)<input name="revenue" type="number" min="0" step="0.01"></label><button class="primary-button" type="submit">Save goals</button></form>
        <div class="goal-progress-list" id="goalProgress"></div>
      </article>
      <article class="panel side" data-dashboard-widget="Recommended Next Action">
        <div class="panel-head"><div><h3>Recommended Next Action</h3><p>One focused action based on the weakest current signal.</p></div></div>
        <div class="next-action-card" id="nextActionCard">Connect YouTube Analytics to generate a recommendation.</div>
      </article>
      <article class="panel large" data-dashboard-widget="Automated Alerts">
        <div class="panel-head"><div><h3>Automated Alerts</h3><p>Launch, retention, conversion, and traffic anomalies.</p></div></div>
        <div class="dashboard-alert-list" id="dashboardAlerts"><p class="signal-empty">No alerts yet.</p></div>
      </article>
      <article class="panel side" data-dashboard-widget="Data Quality">
        <div class="panel-head"><div><h3>Data Quality</h3><p>Permissions, freshness, and report coverage.</p></div></div>
        <div class="coverage-list" id="dataQualityDetails"></div>
      </article>
      <article class="panel full" data-dashboard-widget="Title & Thumbnail Timeline">
        <div class="panel-head"><div><h3>Title &amp; Thumbnail Timeline</h3><p>Detected metadata changes from dashboard sync snapshots.</p></div></div>
        <div class="metadata-timeline" id="metadataTimeline"><p class="signal-empty">No changes detected yet.</p></div>
      </article>
    `);
    assignWidgetNames();
    bindControls();
    renderCustomizer();
  }

  function assignWidgetNames() {
    document.querySelectorAll(".dashboard-grid > article.panel").forEach((panel) => {
      if (!panel.dataset.dashboardWidget) panel.dataset.dashboardWidget = panel.querySelector("h3")?.textContent?.trim() || "Widget";
    });
  }

  function bindControls() {
    document.getElementById("dashboardRange")?.addEventListener("change", (event) => {
      const label = `${event.target.value}D`;
      [...document.querySelectorAll(".segmented button")].find((button) => button.textContent.trim() === label)?.click();
    });
    document.getElementById("dashboardFormat")?.addEventListener("change", (event) => {
      window.viewcastDashboardFormat = event.target.value;
      window.dispatchEvent(new CustomEvent("viewcast:dashboard-filter"));
      renderAll();
    });
    document.getElementById("dashboardBenchmark")?.addEventListener("change", renderAll);
    document.getElementById("dashboardChannel")?.addEventListener("change", (event) => {
      const connection = readJson(connectionsKey, []).find((item) => item?.channel?.id === event.target.value);
      if (!connection) return;
      localStorage.setItem(activeConnectionKey, JSON.stringify(connection));
      localStorage.setItem(activeChannelKey, JSON.stringify(connection.channel || {}));
      window.location.reload();
    });
    document.getElementById("downloadDashboardCsv")?.addEventListener("click", exportCsv);
    document.getElementById("compareVideoA")?.addEventListener("change", renderComparison);
    document.getElementById("compareVideoB")?.addEventListener("change", renderComparison);
    document.getElementById("editGoals")?.addEventListener("click", () => { document.getElementById("goalForm").hidden = false; });
    document.getElementById("goalForm")?.addEventListener("submit", saveGoals);
    document.getElementById("customizeDashboard")?.addEventListener("click", () => { document.getElementById("dashboardCustomizer").hidden = false; });
    document.getElementById("closeDashboardCustomizer")?.addEventListener("click", () => { document.getElementById("dashboardCustomizer").hidden = true; });
  }

  function populateChannels() {
    const select = document.getElementById("dashboardChannel");
    if (!select) return;
    const connections = readJson(connectionsKey, []);
    select.replaceChildren(...(connections.length ? connections : [{channel: {id: "", title: "No channel connected"}}]).map((item) => {
      const option = document.createElement("option"); option.value = item.channel?.id || ""; option.textContent = item.channel?.title || "Untitled channel";
      option.selected = item.channel?.id === state.connection?.channel?.id; return option;
    }));
  }

  function visibleVideos() {
    const filter = document.getElementById("dashboardFormat")?.value || "all";
    return (state.overviewData?.videos || []).filter((video) => filter === "all" || videoFormat(video) === filter);
  }

  function populateComparison() {
    const videos = visibleVideos();
    ["compareVideoA", "compareVideoB"].forEach((id, selectIndex) => {
      const select = document.getElementById(id); if (!select) return;
      const previous = select.value;
      select.replaceChildren(...videos.map((video, index) => {
        const option = document.createElement("option"); option.value = video.id; option.textContent = video.snippet?.title || "Untitled";
        option.selected = previous ? previous === video.id : index === Math.min(selectIndex, Math.max(0, videos.length - 1)); return option;
      }));
    });
  }

  function renderComparison() {
    const container = document.getElementById("comparisonResults"); if (!container) return;
    const map = analyticsMap();
    const videos = [...visibleVideos()].sort((a, b) => new Date(b.snippet?.publishedAt || 0) - new Date(a.snippet?.publishedAt || 0));
    const ids = [document.getElementById("compareVideoA")?.value, document.getElementById("compareVideoB")?.value].filter(Boolean);
    const benchmarkCount = number(document.getElementById("dashboardBenchmark")?.value || 10);
    const benchmarkRows = videos.filter((video) => !ids.includes(String(video.id))).map((video) => map.get(String(video.id))).filter(Boolean).slice(0, benchmarkCount);
    const typicalViews = benchmarkRows.length ? benchmarkRows.reduce((sum, item) => sum + item.views, 0) / benchmarkRows.length : 0;
    if (!ids.length || !map.size) { container.innerHTML = '<p class="signal-empty">No comparable video analytics are available.</p>'; return; }
    const baselineSummary = benchmarkRows.length
      ? `<p class="comparison-benchmark-summary"><b>Benchmark:</b> ${format(typicalViews)} average views across ${benchmarkRows.length} other recent upload${benchmarkRows.length === 1 ? "" : "s"}.</p>`
      : '<p class="comparison-benchmark-summary"><b>Benchmark unavailable:</b> Connect more uploads or choose a broader format filter.</p>';
    container.innerHTML = baselineSummary + ids.map((id) => {
      const video = videos.find((item) => String(item.id) === String(id)); const item = map.get(String(id));
      if (!video || !item) return "";
      const engagement = item.views ? ((item.likes + item.comments + item.shares) / item.views) * 1000 : 0;
      const delta = typicalViews ? ((item.views / typicalViews) - 1) * 100 : null;
      return `<section><a href="pages/analyzer.html?video=${encodeURIComponent(id)}">${escapeHtml(video.snippet?.title || "Untitled")}</a><div><b>${format(item.views)}</b><span>views</span></div><div><b>${format(item.retention, 1)}%</b><span>viewed</span></div><div><b>${format(engagement, 1)}</b><span>engagement / 1K</span></div><div><b class="${delta === null ? "" : delta >= 0 ? "positive" : "negative"}">${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${format(delta, 0)}%`}</b><span>vs. benchmark</span></div></section>`;
    }).join("");
  }

  function exportCsv() {
    const map = analyticsMap();
    const rows = [["Video", "Format", "Views", "Average viewed %", "Watch hours", "Subscribers", "Likes", "Comments", "Shares"]];
    visibleVideos().forEach((video) => { const item = map.get(String(video.id)); if (item) rows.push([video.snippet?.title || "Untitled", videoFormat(video), item.views, item.retention, item.watchMinutes / 60, item.subscribers, item.likes, item.comments, item.shares]); });
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
    link.download = `viewcast-dashboard-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  function saveGoals(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const goals = Object.fromEntries([...form].map(([key, value]) => [key, number(value)]));
    localStorage.setItem(goalsKey, JSON.stringify(goals)); event.currentTarget.hidden = true; renderGoals();
  }

  function renderGoals() {
    const goals = readJson(goalsKey, {views: 0, subscribers: 0, watchHours: 0, revenue: 0});
    const form = document.getElementById("goalForm"); if (form) Object.entries(goals).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value || ""; });
    const data = state.overviewData; const daily = data?.daily || [];
    const current = {views: number(state.connection?.channel?.viewCount), subscribers: number(state.connection?.channel?.subscriberCount), watchHours: daily.reduce((sum, row) => sum + number(row[2]), 0) / 60, revenue: number(data?.estimatedRevenue)};
    const labels = {views: "Views", subscribers: "Subscribers", watchHours: "28-day watch hours", revenue: "28-day revenue"};
    const container = document.getElementById("goalProgress"); if (!container) return;
    const active = Object.entries(goals).filter(([, target]) => target > 0);
    container.innerHTML = active.length ? active.map(([key, target]) => { const progress = Math.min(100, current[key] / target * 100); return `<div><div><b>${labels[key]}</b><span>${format(current[key], key === "revenue" ? 2 : 0)} / ${format(target, key === "revenue" ? 2 : 0)}</span></div><div class="bar"><i style="--value:${progress}%"></i></div></div>`; }).join("") : '<p class="signal-empty">Set goals to track progress here.</p>';
  }

  function renderRecommendationsAndAlerts() {
    const metrics = [...analyticsMap().values()]; const alerts = []; let action = "Keep collecting analytics to generate a focused recommendation.";
    if (metrics.length) {
      const views = metrics.reduce((sum, item) => sum + item.views, 0); const retention = views ? metrics.reduce((sum, item) => sum + item.retention * item.views, 0) / views : 0;
      const subscribers = metrics.reduce((sum, item) => sum + item.subscribers, 0); const subRate = views ? subscribers / views * 1000 : 0;
      if (retention < 35) { alerts.push(["Retention risk", `Average viewed is ${format(retention, 1)}%. Review openings and mid-video drop-offs.`]); action = "Improve the first 30 seconds of the lowest-retention video."; }
      if (subRate < 2) { alerts.push(["Low subscriber conversion", `${format(subRate, 1)} subscribers per 1,000 views.`]); if (retention >= 35) action = "Add a specific subscriber promise near the strongest retention moment."; }
      if (retention >= 35 && subRate >= 2) action = "Turn the highest-retention format into a repeatable series and test a follow-up upload.";
      const daily = (state.overviewData?.daily || []).map((row) => number(row[1]));
      if (daily.length >= 7) { const recent = daily.slice(-3).reduce((a, b) => a + b, 0) / 3; const baseline = daily.slice(0, -3).reduce((a, b) => a + b, 0) / Math.max(1, daily.length - 3); if (baseline && Math.abs(recent / baseline - 1) >= .3) alerts.push([recent > baseline ? "Traffic spike" : "Traffic drop", `${format(Math.abs(recent / baseline - 1) * 100)}% ${recent > baseline ? "above" : "below"} the earlier daily average.`]); }
    }
    document.getElementById("nextActionCard").textContent = action;
    document.getElementById("dashboardAlerts").innerHTML = alerts.length ? alerts.map(([title, body]) => `<div><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div>`).join("") : '<p class="signal-empty">No significant anomalies detected.</p>';
  }

  function renderDataQuality() {
    const data = state.overviewData; const checks = [
      ["YouTube connection", state.connection ? "Connected" : "Missing"], ["Public video data", data?.videos?.length ? "Available" : "Missing"],
      ["Owner analytics", data?.videoAnalytics?.length ? "Available" : "Missing or delayed"], ["Revenue report", data?.videoRevenue?.length ? "Available" : "Unavailable"],
      ["Last sync", data?.latestVideoScannedAt ? new Date(data.latestVideoScannedAt).toLocaleString() : "Not synced"]
    ];
    document.getElementById("dataQualityDetails").innerHTML = checks.map(([label, value]) => `<div><span>${label}</span><b>${value}</b></div>`).join("");
    document.getElementById("dashboardQualitySummary").textContent = checks.filter(([, value]) => /Missing|Unavailable|Not synced/.test(value)).length ? "Some reports need attention" : "All available reports loaded";
  }

  function renderTimeline() {
    const key = `viewcastVideoMetadataEvents:${state.user?.uid || "guest"}:${state.connection?.channel?.id || "none"}`;
    const events = readJson(key, []).slice(0, 12); const container = document.getElementById("metadataTimeline"); if (!container) return;
    container.innerHTML = events.length ? events.map((event) => `<div><time>${new Date(event.detectedAt).toLocaleString()}</time><b>${escapeHtml(event.title || "Video")}</b><span>${escapeHtml(event.type)} changed</span></div>`).join("") : '<p class="signal-empty">No title or thumbnail changes detected yet.</p>';
  }

  function renderCustomizer() {
    const hidden = new Set(readJson(hiddenWidgetsKey, [])); const options = document.getElementById("dashboardWidgetOptions"); if (!options) return;
    const panels = [...document.querySelectorAll("[data-dashboard-widget]")];
    panels.forEach((panel) => { panel.hidden = hidden.has(panel.dataset.dashboardWidget); });
    options.innerHTML = panels.map((panel, index) => `<label><input type="checkbox" data-widget-index="${index}" ${hidden.has(panel.dataset.dashboardWidget) ? "" : "checked"}>${escapeHtml(panel.dataset.dashboardWidget)}</label>`).join("");
    options.querySelectorAll("input").forEach((input) => input.addEventListener("change", () => { const panel = panels[number(input.dataset.widgetIndex)]; const next = new Set(readJson(hiddenWidgetsKey, [])); input.checked ? next.delete(panel.dataset.dashboardWidget) : next.add(panel.dataset.dashboardWidget); localStorage.setItem(hiddenWidgetsKey, JSON.stringify([...next])); panel.hidden = !input.checked; }));
  }

  function renderAll() { populateChannels(); populateComparison(); renderComparison(); renderGoals(); renderRecommendationsAndAlerts(); renderDataQuality(); renderTimeline(); }

  mountUi();
  window.addEventListener("viewcast:dashboard-data", (event) => { state = event.detail || state; renderAll(); });
  if (window.viewcastDashboardState) { state = window.viewcastDashboardState; renderAll(); }
})();
