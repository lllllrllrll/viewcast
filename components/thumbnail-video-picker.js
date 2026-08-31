import {selectThumbnailFile} from "../js/thumbnail-analyzer.js?v=13";
import {initializeApp, getApps} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getAuth, onAuthStateChanged} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {firebaseConfig, firebaseConfigured} from "../js/firebase-config.js";
import {getRenewedYouTubeAccessToken} from "../js/youtube-auth.js?v=4";
import {fetchChannelVideos} from "../js/insights-youtube.js?v=5";
import {readCachedYouTubeVideos, saveCachedYouTubeVideos} from "../js/services/youtube-video-cache.js?v=1";
import {activeYouTubeChannelId} from "../js/services/youtube-session.js?v=1";

const grid = document.querySelector("#thumbnailVideoGrid");
const status = document.querySelector("#thumbnailVideosStatus");
let currentUser = null;

function savedVideos() {
  return readCachedYouTubeVideos(currentUser?.uid, activeYouTubeChannelId())
    .filter((video) => video.ownerAnalytics?.source === "youtube-studio");
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
    selectThumbnailFile(file, video.snippet?.title || "", video.ownerAnalytics || null);
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
    : "No Studio-enriched uploads were found for the linked channel.";
  status.dataset.type = count ? "success" : "";
}

async function refreshVideos() {
  if (!currentUser) return;
  const channelId = activeYouTubeChannelId();
  if (!channelId) {
    renderVideos([]);
    status.textContent = "Link your YouTube channel to choose from its uploads.";
    return;
  }

  const cached = savedVideos();
  if (cached.length) renderVideos(cached);
  status.textContent = cached.length ? "Refreshing uploads from YouTube Studio…" : "Loading uploads from YouTube Studio…";
  status.dataset.type = "loading";
  try {
    const token = await getRenewedYouTubeAccessToken(currentUser.uid, channelId);
    const videos = await fetchChannelVideos(token);
    saveCachedYouTubeVideos(currentUser.uid, channelId, videos);
    renderVideos(videos.filter((video) => video.ownerAnalytics?.source === "youtube-studio"));
  } catch (error) {
    console.error("Could not load YouTube Studio uploads for thumbnail analysis.", error);
    if (cached.length) {
      renderVideos(cached);
      status.textContent = "Showing saved Studio uploads. Current analytics could not be refreshed.";
      status.dataset.type = "error";
    } else {
      renderVideos([]);
      status.textContent = error.message || "Could not load uploads from YouTube Studio.";
      status.dataset.type = "error";
    }
  }
}

if (firebaseConfigured && grid && status) {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  onAuthStateChanged(getAuth(app), (user) => {
    currentUser = user || null;
    if (!currentUser) {
      renderVideos([]);
      status.textContent = "Sign in to load your private YouTube Studio uploads.";
      return;
    }
    refreshVideos();
  });
}

window.addEventListener("viewcast:studio-refreshed", refreshVideos);
