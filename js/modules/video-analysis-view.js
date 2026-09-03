import {compactNumber, durationFromSeconds} from "../insights-format.js?v=1";
import {renderTimeline} from "./video-analysis-renderer.js?v=1";

const dashboard = document.getElementById("analyzerDashboard");
const loading = document.getElementById("analyzerLoading");

function setMetric(index, value, trend = "") {
  const card = document.querySelectorAll(".metric-card")[index];
  if (!card) return;
  const display = value === "" || value === null || value === undefined ? " " : value;
  const valueElement = card.querySelector(".metric-value");
  const trendElement = card.querySelector(".trend");
  if (valueElement) valueElement.textContent = display;
  if (trendElement) trendElement.textContent = trend || " ";
}

export function setAnalyzerLoading(isLoading) {
  if (loading) loading.hidden = !isLoading;
}

export function setAnalyzerResultsVisible(isVisible) {
  dashboard?.classList.toggle("analyzer-results-hidden", !isVisible);
}

export function clearAnalyzerResults() {
  setAnalyzerLoading(false);
  setAnalyzerResultsVisible(false);
  document.querySelectorAll(".metric-card").forEach((card) => {
    const value = card.querySelector(".metric-value");
    const trend = card.querySelector(".trend");
    if (value) value.textContent = " ";
    if (trend) trend.textContent = " ";
  });
  document.querySelectorAll(".activity-item").forEach((item) => {
    ["b", "span", "time"].forEach((selector) => {
      const element = item.querySelector(selector);
      if (element) element.textContent = " ";
    });
  });
  if (typeof window.drawLineChart === "function") window.drawLineChart("retentionChart", [], [], []);
  const emptyState = document.getElementById("retentionEmptyState");
  if (emptyState) emptyState.hidden = true;
  document.getElementById("retentionChart")?.removeAttribute("aria-hidden");
  renderTimeline([], 0);
}

export function updateAnalyzerMetrics(analytics, geminiAnalysis = null) {
  const labels = geminiAnalysis?.metricLabels || {};
  const studioLabel = analytics?.periodLabel ? `Studio ${analytics.periodLabel}` : "Studio unavailable";
  setMetric(0, analytics ? compactNumber(analytics.views) : "—", labels.views || studioLabel);
  setMetric(1, analytics ? compactNumber(analytics.likes) : "—", labels.likes || studioLabel);
  setMetric(2, analytics ? compactNumber(analytics.comments) : "—", labels.comments || studioLabel);
  setMetric(3, analytics ? durationFromSeconds(analytics.averageViewDuration) : "—", labels.averageViewDuration || studioLabel);
}
