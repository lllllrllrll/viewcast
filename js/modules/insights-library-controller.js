import {studioVideoCardsHtml, syncVideoLibrarySelection} from "../../components/youtube-video-library.js?v=1";
import {fetchChannelVideos} from "../insights-youtube.js?v=5";

export function createInsightsLibraryController({
  library,
  getUser,
  clearCachedAccessToken,
  readCachedAccessToken,
  readCachedVideos,
  saveCachedVideos,
  requestAccessToken,
  setBusy,
  setStatus
}) {
  let videos = [];
  let selectedVideoId = "";

  function select(videoId) {
    selectedVideoId = videoId || "";
    syncVideoLibrarySelection(library, selectedVideoId);
  }

  function render(nextVideos = videos) {
    videos = Array.isArray(nextVideos) ? nextVideos : [];
    if (!library) return;
    if (!videos.length) {
      library.innerHTML = '<div class="video-library-empty">No uploads are loaded yet. Refresh videos to pull from your linked channel.</div>';
      return;
    }
    library.innerHTML = studioVideoCardsHtml(videos);
    select(selectedVideoId);
  }

  async function loadWithRetry(allowPrompt) {
    let accessToken = readCachedAccessToken();
    if (!accessToken && !allowPrompt) return readCachedVideos();
    accessToken = accessToken || await requestAccessToken();

    try {
      return await fetchChannelVideos(accessToken);
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error;
      clearCachedAccessToken();
      if (!allowPrompt) throw error;
      setStatus("YouTube access expired. Please approve once to refresh insights.");
      return fetchChannelVideos(await requestAccessToken());
    }
  }

  async function load({allowPrompt = false} = {}) {
    if (!getUser()) return [];
    const cachedVideos = readCachedVideos();
    if (cachedVideos.length) render(cachedVideos);

    if (!readCachedAccessToken() && !allowPrompt) {
      setStatus(cachedVideos.length
        ? "Showing saved uploads. Generate insights from saved data or refresh for current data."
        : "Refresh videos to load uploads from your linked channel.");
      return cachedVideos;
    }

    try {
      setBusy(true);
      setStatus("Loading uploads from YouTube...");
      const nextVideos = await loadWithRetry(allowPrompt);
      saveCachedVideos(nextVideos);
      render(nextVideos);
      setStatus(nextVideos.length
        ? "Uploads loaded. Generate insights for your channel."
        : "No uploads were found on your linked channel.");
      return nextVideos;
    } catch (error) {
      console.error("Could not load channel videos.", error);
      setStatus(error.message || "Could not load videos from YouTube.");
      if (allowPrompt) throw error;
      return cachedVideos;
    } finally {
      setBusy(false);
    }
  }

  return {
    getVideos: () => videos,
    load,
    render,
    reset() {
      selectedVideoId = "";
      render([]);
    },
    select
  };
}
