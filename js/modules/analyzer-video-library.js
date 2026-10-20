import {studioVideoCardsHtml, syncVideoLibrarySelection} from "../../components/youtube-video-library.js?v=1";

export function parseVideoId(value = "") {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }
    if (!["youtube.com", "m.youtube.com", "music.youtube.com"].includes(hostname)) {
      return "";
    }
    const watchId = url.searchParams.get("v");
    if (watchId) return /^[a-zA-Z0-9_-]{11}$/.test(watchId) ? watchId : "";
    return url.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/)?.[2] || "";
  } catch {
    return "";
  }
}

export function selectLibraryVideo(library, videoId) {
  const selected = videoId || "";
  syncVideoLibrarySelection(library, selected);
  return selected;
}

export function renderAnalyzerVideoLibrary({videos, library, input, selectedVideoId}) {
  const uploads = Array.isArray(videos) ? videos.filter((video) => {
    const state = video.snippet?.liveBroadcastContent;
    return !video.liveStreamingDetails && state !== "live" && state !== "upcoming";
  }) : [];
  if (!library) return {videos: uploads, selectedVideoId};
  if (!uploads.length) {
    library.innerHTML = '<div class="video-library-empty">No uploads are loaded yet. Refresh videos to pull from your linked channel.</div>';
    return {videos: uploads, selectedVideoId: ""};
  }
  library.innerHTML = studioVideoCardsHtml(uploads);
  const selected = uploads.some((video) => video.id === selectedVideoId)
    ? selectedVideoId : uploads[0]?.id || "";
  if (selected && input && !parseVideoId(input.value)) {
    input.value = `https://www.youtube.com/watch?v=${selected}`;
  }
  selectLibraryVideo(library, selected);
  return {videos: uploads, selectedVideoId: selected};
}
