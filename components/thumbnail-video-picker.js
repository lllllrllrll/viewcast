import {selectThumbnailFile} from "../js/thumbnail-analyzer.js?v=10";

const videosStoragePrefix = "viewcastYouTubeVideos:";
const grid = document.querySelector("#thumbnailVideoGrid");
const status = document.querySelector("#thumbnailVideosStatus");

function activeChannelId() {
  try {
    return JSON.parse(localStorage.getItem("viewcastYouTubeConnection") || "null")?.channel?.id || "";
  } catch {
    return "";
  }
}

function savedVideos() {
  const channelId = activeChannelId();
  const entries = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index) || "";
    if (!key.startsWith(videosStoragePrefix)) continue;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (!Array.isArray(saved?.videos)) continue;
      entries.push({
        videos: saved.videos,
        preferred: Boolean(channelId && key.endsWith(`:${channelId}`))
      });
    } catch {
      // Ignore an outdated or malformed cache entry.
    }
  }
  entries.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  const seen = new Set();
  return entries.flatMap((entry) => entry.videos).filter((video) => {
    if (!video?.id || seen.has(video.id)) return false;
    seen.add(video.id);
    return true;
  });
}

function thumbnailUrl(video) {
  const thumbnails = video.snippet?.thumbnails || {};
  return thumbnails.maxres?.url || thumbnails.standard?.url ||
    thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || "";
}

function safeFileName(title) {
  const value = String(title || "youtube-thumbnail")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${value || "youtube-thumbnail"}.jpg`;
}

async function chooseVideo(video, button) {
  const source = thumbnailUrl(video);
  if (!source) return;
  button.disabled = true;
  status.textContent = "Loading the selected thumbnail…";
  status.dataset.type = "loading";
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Thumbnail request failed (${response.status}).`);
    const blob = await response.blob();
    const file = new File([blob], safeFileName(video.snippet?.title), {
      type: blob.type || "image/jpeg",
      lastModified: Date.now()
    });
    selectThumbnailFile(file, video.snippet?.title || "");
    document.querySelector("[data-thumbnail-tab='analysis']")?.click();
    document.querySelector("#analyzeThumbnail")?.focus();
  } catch (error) {
    console.error("Could not load the selected YouTube thumbnail.", error);
    status.textContent = "Could not load that thumbnail. Try another video or upload the image manually.";
    status.dataset.type = "error";
    button.disabled = false;
  }
}

function renderVideos(videos) {
  grid.replaceChildren();
  videos.slice(0, 60).forEach((video) => {
    const source = thumbnailUrl(video);
    if (!source) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumbnail-video-card";
    button.setAttribute("aria-label", `Analyze thumbnail for ${video.snippet?.title || "video"}`);
    const image = document.createElement("img");
    image.src = source;
    image.alt = "";
    image.loading = "lazy";
    const title = document.createElement("span");
    title.textContent = video.snippet?.title || "Untitled video";
    button.append(image, title);
    button.addEventListener("click", () => chooseVideo(video, button));
    grid.append(button);
  });
  const count = grid.childElementCount;
  status.textContent = count
    ? `Choose from ${count} saved channel upload${count === 1 ? "" : "s"}.`
    : "No saved uploads were found. Load your channel uploads in Video Analyzer or AI Insights first.";
  status.dataset.type = count ? "success" : "";
}

renderVideos(savedVideos());
