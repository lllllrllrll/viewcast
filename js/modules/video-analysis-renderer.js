import {durationFromSeconds, escapeHtml, secondsFromIso} from "../insights-format.js?v=1";

let dismissHandler = null;

function secondsFromTimestamp(value = "") {
  const parts = String(value).trim().split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function drawRetention(points, video, retentionError = null) {
  const emptyState = document.getElementById("retentionEmptyState");
  const chart = document.getElementById("retentionChart");
  const drawChart = window.drawLineChart;
  if (!points.length || typeof drawChart !== "function") {
    if (typeof drawChart === "function") drawChart("retentionChart", [], [], []);
    const message = emptyState?.querySelector("span");
    if (message) message.textContent = retentionError
      ? `YouTube Analytics could not load retention: ${retentionError.message}`
      : "YouTube returned no audience-retention segments for this upload.";
    if (emptyState) emptyState.hidden = false;
    if (chart) chart.setAttribute("aria-hidden", "true");
    return;
  }
  if (emptyState) emptyState.hidden = true;
  chart?.removeAttribute("aria-hidden");
  const totalSeconds = secondsFromIso(video?.contentDetails?.duration) || 0;
  const step = Math.max(1, Math.floor(points.length / 12));
  const sampled = points.filter((_, index) => index % step === 0).slice(0, 12);
  const actual = sampled.map(({ratio}) => Math.max(0, Math.min(200, Math.round(ratio * 100))));
  const labels = sampled.map(({position}) => totalSeconds
    ? durationFromSeconds(position * totalSeconds)
    : `${Math.round(position * 100)}%`);
  drawChart("retentionChart", actual, actual, labels, {ySuffix: "%"});
}

export function renderSearchTerms(searchTerms) {
  const panel = document.querySelector(".search-terms-panel");
  const activity = panel?.querySelector(".activity");
  if (!activity) return;
  panel.hidden = !searchTerms.length;
  activity.innerHTML = searchTerms.slice(0, 3).map((row) => `
    <div class="activity-item">
      <i class="dot"></i><div><b>${escapeHtml(row.term)}</b>
      <span>${escapeHtml(`${Math.round(row.views).toLocaleString()} views from search`)}</span></div>
      <time>${escapeHtml(row.periodLabel || " ")}</time>
    </div>`).join("");
}

export function renderTimeline(points, durationSeconds = 0, recommendedEdits = []) {
  const markers = document.getElementById("timelineMarkers");
  const list = document.getElementById("timelinePoints");
  const duration = document.getElementById("timelineDuration");
  const ticks = document.getElementById("timelineTicks");
  const popover = document.getElementById("timelinePopover");
  const popoverTime = document.getElementById("timelinePopoverTime");
  const popoverTitle = document.getElementById("timelinePopoverTitle");
  const popoverSuggestion = document.getElementById("timelinePopoverSuggestion");
  const popoverEdit = document.getElementById("timelinePopoverEdit");
  const popoverClose = document.getElementById("timelinePopoverClose");
  if (!markers || !list) return;
  if (dismissHandler) document.removeEventListener("click", dismissHandler);
  const normalized = (points || []).slice(0, 8).map((point) => ({...point}));
  recommendedEdits.slice(0, 5).forEach((edit, index) => {
    const timestamp = edit.segment.match(/\d{1,2}:\d{2}(?::\d{2})?/)?.[0];
    let target = timestamp ? normalized.find((point) => point.timestamp === timestamp) : normalized[index];
    if (!target) {
      target = {timestamp: timestamp || durationFromSeconds(index * 30), title: edit.issue,
        suggestion: edit.recommendation, severity: index < 2 ? "high" : "medium"};
      normalized.push(target);
    }
    target.edit = edit;
  });
  normalized.sort((a, b) => secondsFromTimestamp(a.timestamp) - secondsFromTimestamp(b.timestamp));
  let pinnedIndex = -1;
  const inferredDuration = Math.max(durationSeconds, ...normalized.map(({timestamp}) => secondsFromTimestamp(timestamp)), 1);
  if (duration) duration.textContent = durationSeconds ? `Video length ${durationFromSeconds(durationSeconds)}` : "";
  if (ticks) {
    const count = durationSeconds >= 120 ? 5 : 3;
    ticks.innerHTML = Array.from({length: count}, (_, index) => {
      const ratio = index / (count - 1);
      return `<span class="timeline-position-${Math.round(ratio * 100)}">${escapeHtml(durationFromSeconds(Math.round(inferredDuration * ratio)))}</span>`;
    }).join("");
  }
  if (popover) popover.hidden = true;
  markers.innerHTML = normalized.map((point, index) => {
    const position = Math.round(Math.min(100, Math.max(2, secondsFromTimestamp(point.timestamp) / inferredDuration * 100)));
    return `<button class="timeline-marker ${escapeHtml(point.severity)} timeline-position-${position}" type="button" data-timeline-index="${index}" aria-label="${escapeHtml(`${point.timestamp}: ${point.title}`)}" aria-expanded="false"></button>`;
  }).join("");
  list.innerHTML = normalized.length ? normalized.map((point) => `
    <article class="timeline-point"><time>${escapeHtml(point.timestamp)}</time><div>
      <b>${escapeHtml(point.title)}</b><span>${escapeHtml(point.suggestion)}</span>
      ${point.edit ? `<div class="timeline-recommended-edit"><div><strong>Recommended edit</strong><em>${escapeHtml(point.edit.impact)}</em></div><p>${escapeHtml(point.edit.recommendation)}</p><small>${escapeHtml(point.edit.segment)}</small></div>` : ""}
    </div></article>`).join("") : `
    <div class="video-library-empty analyzer-empty-action"><strong>No timestamped suggestions yet</strong>
      <span>Gemini could not return timestamped suggestions for this YouTube upload. Press Analyze to retry.</span>
    </div>`;

  const closePoint = () => {
    pinnedIndex = -1;
    if (popover) popover.hidden = true;
    if (popoverEdit) popoverEdit.hidden = true;
    markers.querySelectorAll(".timeline-marker").forEach((marker) => {
      marker.classList.remove("is-active");
      marker.setAttribute("aria-expanded", "false");
    });
  };
  const showPoint = (index, {pin = false} = {}) => {
    const point = normalized[index];
    if (!point || !popover) return;
    if (pin) pinnedIndex = index;
    if (popoverTime) popoverTime.textContent = `${point.timestamp} · ${point.severity} priority`;
    if (popoverTitle) popoverTitle.textContent = point.title;
    if (popoverSuggestion) popoverSuggestion.textContent = point.suggestion;
    if (popoverEdit) {
      popoverEdit.textContent = point.edit ? `Recommended edit: ${point.edit.recommendation}` : "";
      popoverEdit.hidden = !point.edit;
    }
    popover.hidden = false;
    markers.querySelectorAll(".timeline-marker").forEach((marker) => {
      const active = Number(marker.dataset.timelineIndex) === index;
      marker.classList.toggle("is-active", active);
      marker.setAttribute("aria-expanded", String(active));
    });
  };
  markers.querySelectorAll(".timeline-marker").forEach((marker) => {
    const index = Number(marker.dataset.timelineIndex);
    marker.addEventListener("mouseenter", () => showPoint(index));
    marker.addEventListener("focus", () => showPoint(index));
    marker.addEventListener("mouseleave", () => pinnedIndex >= 0 ? showPoint(pinnedIndex) : closePoint());
    marker.addEventListener("blur", () => pinnedIndex >= 0 ? showPoint(pinnedIndex) : closePoint());
    marker.addEventListener("click", () => pinnedIndex === index ? closePoint() : showPoint(index, {pin: true}));
    marker.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { closePoint(); marker.blur(); }
    });
  });
  if (popoverClose) popoverClose.onclick = closePoint;
  dismissHandler = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (pinnedIndex >= 0 && !target?.closest(".timeline-marker") && !target?.closest("#timelinePopover")) closePoint();
  };
  document.addEventListener("click", dismissHandler);
}
