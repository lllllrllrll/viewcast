import {
  bestThumbnail, dateLabel, durationFromIso, escapeHtml, wholeNumber
} from "../js/insights-format.js?v=1";

export function studioVideoCardsHtml(videos = []) {
  return videos.map((video) => {
    const snippet = video.snippet || {};
    const analytics = video.ownerAnalytics || {};
    const title = snippet.title || "Untitled video";
    const thumbnail = bestThumbnail(snippet.thumbnails);
    const duration = durationFromIso(video.contentDetails?.duration);
    const views = wholeNumber(analytics.views);
    const meta = [
      dateLabel(snippet.publishedAt),
      views ? `${views} Studio views (${analytics.periodLabel || "90D"})` : "Studio: no views in period"
    ].filter(Boolean).join(" - ");
    return '<button class="video-library-card" type="button" data-video-id="' + escapeHtml(video.id) + '" aria-pressed="false">'
      + '<div class="video-library-thumb">'
      + (thumbnail ? '<img src="' + escapeHtml(thumbnail) + '" alt="' + escapeHtml(title) + ' thumbnail">' : "")
      + (duration ? '<span class="video-library-duration">' + escapeHtml(duration) + "</span>" : "")
      + '</div><div class="video-library-body"><b>' + escapeHtml(title) + "</b><span>"
      + escapeHtml(meta || "Upload") + "</span></div></button>";
  }).join("");
}

export function syncVideoLibrarySelection(container, videoId = "") {
  container?.querySelectorAll(".video-library-card").forEach((card) => {
    const active = card.dataset.videoId === videoId;
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", String(active));
  });
}
