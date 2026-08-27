(function () {
  const connectionsKey = "viewcastYouTubeAllConnections";
  const activeConnectionKey = "viewcastYouTubeConnection";
  const activeChannelKey = "viewcastYouTubeChannel";
  let state = {connection: null, overviewData: null, user: null};

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { localStorage.removeItem(key); return fallback; }
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
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
      </section>
    `);
    bindControls();
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
    document.getElementById("dashboardChannel")?.addEventListener("change", (event) => {
      const connection = readJson(connectionsKey, []).find((item) => item?.channel?.id === event.target.value);
      if (!connection) return;
      localStorage.setItem(activeConnectionKey, JSON.stringify(connection));
      localStorage.setItem(activeChannelKey, JSON.stringify(connection.channel || {}));
      window.location.reload();
    });
    document.getElementById("downloadDashboardCsv")?.addEventListener("click", exportCsv);
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

  function exportCsv() {
    const map = analyticsMap();
    const rows = [["Video", "Format", "Views", "Average viewed %", "Watch hours", "Subscribers", "Likes", "Comments", "Shares"]];
    visibleVideos().forEach((video) => { const item = map.get(String(video.id)); if (item) rows.push([video.snippet?.title || "Untitled", videoFormat(video), item.views, item.retention, item.watchMinutes / 60, item.subscribers, item.likes, item.comments, item.shares]); });
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
    link.download = `viewcast-dashboard-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  function renderAll() { populateChannels(); }

  mountUi();
  window.addEventListener("viewcast:dashboard-data", (event) => { state = event.detail || state; renderAll(); });
  if (window.viewcastDashboardState) { state = window.viewcastDashboardState; renderAll(); }
})();
