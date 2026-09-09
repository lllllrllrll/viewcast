import {bestThumbnail} from "../insights-format.js?v=1";
import {importantWords, readableTrendQuery, titleTopicPhrases} from "../insights-model.js?v=9";
import {compactAdviceSummary} from "../insights-gemini.js?v=8";
import {normalizeGeminiInsights} from "../insights-gemini-page.js?v=5";
import {renderTrendSections} from "../../components/insights-trend-renderer.js?v=3";

function setMetric(index, value, trend = "", trendClass = "") {
  const card = document.querySelectorAll(".metric-card")[index];
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  if (valueEl) valueEl.textContent = value === "" || value === null || value === undefined ? " " : value;
  if (trendEl) {
    trendEl.textContent = trend || " ";
    trendEl.className = ["trend", trendClass].filter(Boolean).join(" ");
  }
}

function setTrendMetric(values = [], detail = "", trendClass = "good") {
  const card = document.querySelector(".insights-trends-card");
  if (!card) return;
  const valueEl = card.querySelector(".metric-value");
  const trendEl = card.querySelector(".trend");
  const trends = values.filter(Boolean).slice(0, 3);

  if (valueEl) {
    valueEl.textContent = "";
    const list = document.createElement("ol");
    list.className = "youtube-trend-list";
    trends.forEach((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      list.append(item);
    });
    valueEl.append(list);
  }
  if (trendEl) {
    trendEl.textContent = detail || "Niche trends";
    trendEl.className = ["trend", trendClass].filter(Boolean).join(" ");
  }
}

function updateActivityItems(selector, items, relatedVideoGroups = []) {
  document.querySelectorAll(selector).forEach((item, index) => {
    const hasInsight = Boolean(items[index]);
    item.hidden = !hasInsight;
    const insight = items[index] || {title: " ", body: " ", label: " "};
    const timeEl = item.querySelector("time");
    const bodyEl = item.querySelector("span");
    const contentEl = item.querySelector("div");
    const existingToggle = item.querySelector(".read-more-button");
    const existingExamples = item.querySelector(".trend-video-examples");
    if (existingToggle) existingToggle.remove();
    if (existingExamples) existingExamples.remove();

    item.querySelector("b").textContent = insight.title;
    bodyEl.textContent = insight.body;
    timeEl.textContent = insight.label;
    timeEl.className = ["comparison-badge", insight.tone].filter(Boolean).join(" ");

    item.classList.remove("is-expanded");
    item.classList.add("is-collapsible");
    if (contentEl) {
      const relatedVideos = relatedVideoGroups[index] || [];
      if (relatedVideos.length) {
        const examples = document.createElement("div");
        examples.className = "trend-video-examples";
        const heading = document.createElement("small");
        heading.textContent = "Videos from other creators";
        examples.append(heading);

        relatedVideos.slice(0, 3).forEach((video) => {
          const link = document.createElement("a");
          link.className = "trend-video-example";
          link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";

          const thumbnail = bestThumbnail(video.snippet?.thumbnails);
          if (thumbnail) {
            const image = document.createElement("img");
            image.src = thumbnail;
            image.alt = "";
            image.loading = "lazy";
            link.append(image);
          }

          const title = document.createElement("span");
          title.textContent = video.snippet?.title || "Watch on YouTube";
          link.append(title);
          examples.append(link);
        });
        contentEl.append(examples);
      }

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "read-more-button";
      toggle.textContent = "Read more";
      toggle.setAttribute("aria-expanded", "false");
      contentEl.append(toggle);
    }

    requestAnimationFrame(() => updateReadMoreVisibility(item));
  });
}

function updateReadMoreVisibility(item) {
  const bodyEl = item.querySelector("span");
  const toggle = item.querySelector(".read-more-button");
  if (!bodyEl || !toggle || item.classList.contains("is-expanded")) return;

  const isOverflowing = bodyEl.scrollHeight > bodyEl.clientHeight + 1;
  item.classList.toggle("is-collapsible", isOverflowing);
  toggle.hidden = !isOverflowing;
}

function updateTrendingKeywords(summary) {
  const entries = (summary.trendVideos || []).map((video) => {
    const sourceTitle = String(video.snippet?.title || "").trim();
    const phrase = titleTopicPhrases(sourceTitle)[0] || importantWords(sourceTitle).slice(0, 4).join(" ");
    return {keyword: readableTrendQuery(phrase), sourceTitle};
  }).filter((entry, index, values) => {
    const normalized = entry.keyword.toLowerCase();
    return importantWords(entry.keyword).length >= 2 && values.findIndex(
      (candidate) => candidate.keyword.toLowerCase() === normalized
    ) === index;
  }).slice(0, 3);
  const items = entries.map(({keyword, sourceTitle}) => {
    return {
      title: keyword,
      body: `Taken directly from words in the current YouTube result: ${sourceTitle}.`,
      label: "Verified trend",
      tone: "good"
    };
  });
  if (!items.length) {
    items.push({
      title: "No verified trending keyword yet",
      body: "Refresh insights after more current same-topic videos are available.",
      label: "Waiting",
      tone: "warn"
    });
  }
  updateActivityItems(".search-terms-panel .activity-item", items);
}

export function renderChannelInsights(summary, setChatSeedMessage) {
  const geminiInsights = summary.geminiInsights
    ? normalizeGeminiInsights(summary.geminiInsights, summary)
    : null;
  const cards = geminiInsights?.cards || {};
  setMetric(
    0,
    cards.bestUploadTime?.value || summary.bestUploadTime,
    cards.bestUploadTime?.detail || "Best performers",
    cards.bestUploadTime?.tone || "good"
  );
  setMetric(
    1,
    cards.nextVideoLength?.value || summary.nextVideoLength,
    cards.nextVideoLength?.detail || summary.videoUploadTime,
    cards.nextVideoLength?.tone || "good"
  );
  setMetric(
    2,
    cards.nextShortLength?.value || summary.nextShortLength,
    cards.nextShortLength?.detail || summary.shortUploadTime,
    cards.nextShortLength?.tone || "warn"
  );
  setTrendMetric(
    [cards.topTopicSignal?.value || summary.currentTrend || summary.topSignal],
    cards.topTopicSignal?.detail || "Based on current same-topic videos",
    cards.topTopicSignal?.tone || "good"
  );
  updateTrendingKeywords(summary);
  renderTrendSections(summary, geminiInsights, updateActivityItems);
  setChatSeedMessage(geminiInsights?.chatIntro || compactAdviceSummary(summary));
}
