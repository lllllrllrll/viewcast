export function createInsightsPageView({
  setStatus, setLibraryStatus, setChatSeedMessage, clearSummary
}) {
  const dashboard = document.getElementById("analyzerDashboard");
  const loading = document.getElementById("analyzerLoading");
  const errorPanel = document.getElementById("insightErrorPanel");
  const errorDetail = errorPanel?.querySelector("p");
  const channelEmpty = document.getElementById("insightChannelEmpty");
  const refreshButton = document.getElementById("refreshInsightsPage");
  const headerActions = document.getElementById("insightsHeaderActions");
  const refreshEmpty = document.getElementById("insightRefreshEmpty");
  const refreshContent = document.getElementById("insightRefreshEmptyContent");
  const tabs = [...document.querySelectorAll("[data-insights-tab]")];
  const panels = [...document.querySelectorAll("[data-insights-panel]")];

  function setRefreshButtonPlacement(centered, target = refreshContent) {
    if (!refreshButton) return;
    const destination = centered ? target : headerActions;
    if (destination && refreshButton.parentElement !== destination) destination.append(refreshButton);
    if (refreshEmpty) refreshEmpty.hidden = !centered || destination !== refreshContent;
  }

  function setLoading(isLoading) {
    if (loading) loading.hidden = !isLoading;
    if (isLoading) setRefreshButtonPlacement(false);
  }

  function setResultsVisible(isVisible) {
    dashboard?.classList.toggle("analyzer-results-hidden", !isVisible);
    setRefreshButtonPlacement(!isVisible);
  }

  function showError(message = "AI Insights could not be generated right now. Check your connection and try again.") {
    setLoading(false);
    setResultsVisible(false);
    if (errorPanel) {
      errorPanel.hidden = false;
      if (errorDetail) errorDetail.textContent = message;
    }
    setRefreshButtonPlacement(true, errorPanel?.querySelector(".insight-error-content"));
    setStatus(message);
    setLibraryStatus(message);
  }

  function showMissingKey() {
    showError("An error has occurred. AI Insights could not be generated right now.");
  }

  function hideError() {
    if (errorPanel) errorPanel.hidden = true;
  }

  function activateTab(tabName, {focus = false} = {}) {
    const activeName = tabName === "trends" ? "trends" : "analysis";
    tabs.forEach((tab) => {
      const active = tab.dataset.insightsTab === activeName;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.insightsPanel !== activeName; });
  }

  function handleTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, tabs.indexOf(event.currentTarget));
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    activateTab(tabs[next]?.dataset.insightsTab, {focus: true});
  }

  function showChannelLinkPrompt(show) {
    if (channelEmpty) channelEmpty.hidden = !show;
    if (show) {
      setLoading(false);
      setResultsVisible(false);
      setRefreshButtonPlacement(false);
    }
  }

  function clear() {
    clearSummary();
    setLoading(false);
    setResultsVisible(false);
    hideError();
    document.querySelectorAll(".metric-card").forEach((card) => {
      const value = card.querySelector(".metric-value");
      const trend = card.querySelector(".trend");
      if (value) value.textContent = " ";
      if (trend) { trend.textContent = " "; trend.className = "trend"; }
    });
    document.querySelectorAll(".activity-item").forEach((item) => {
      item.classList.remove("is-collapsible", "is-expanded");
      item.querySelector(".read-more-button")?.remove();
      ["b", "span", "time"].forEach((selector) => {
        const element = item.querySelector(selector);
        if (element) element.textContent = " ";
      });
      const time = item.querySelector("time");
      if (time) time.className = "comparison-badge";
    });
    setChatSeedMessage();
  }

  return {activateTab, clear, handleTabKeydown, hideError, setLoading,
    setResultsVisible, showChannelLinkPrompt, showError, showMissingKey};
}
