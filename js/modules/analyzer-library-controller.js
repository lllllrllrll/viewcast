import {fetchChannelVideos} from "../insights-youtube.js?v=5";
import {renderAnalyzerVideoLibrary, selectLibraryVideo} from "./analyzer-video-library.js?v=1";

export function createAnalyzerLibraryController({
  library,
  input,
  getUser,
  clearCachedAccessToken,
  readCachedAccessToken,
  readCachedVideos,
  saveCachedVideos,
  getAccessToken,
  requestAccessToken,
  setBusy,
  setStatus
}) {
  let videos = [];
  let selectedVideoId = "";

  function render(nextVideos = videos) {
    const result = renderAnalyzerVideoLibrary({
      videos: nextVideos,
      library,
      input,
      selectedVideoId
    });
    videos = result.videos;
    selectedVideoId = result.selectedVideoId;
  }

  function select(videoId) {
    selectedVideoId = selectLibraryVideo(library, videoId);
  }

  function reset() {
    videos = [];
    selectedVideoId = "";
    render([]);
  }

  async function load({allowPrompt = false} = {}) {
    if (!getUser()) return;

    const cachedVideos = readCachedVideos();
    if (cachedVideos.length) render(cachedVideos);

    const cachedToken = readCachedAccessToken();
    try {
      setBusy(true);
      setStatus("Loading uploads from YouTube...");
      let accessToken = cachedToken || await getAccessToken();
      let nextVideos;

      try {
        nextVideos = await fetchChannelVideos(accessToken);
      } catch (error) {
        if (error.status !== 401) throw error;
        clearCachedAccessToken();
        if (!allowPrompt) throw error;
        setStatus("YouTube access expired. Please approve once to refresh videos.");
        accessToken = await requestAccessToken();
        nextVideos = await fetchChannelVideos(accessToken);
      }

      saveCachedVideos(nextVideos);
      render(nextVideos);
      setStatus(nextVideos.length
        ? "Select one of your uploads to load its analytics."
        : "No uploads were found on your linked channel.");
    } catch (error) {
      console.error("Could not load channel videos.", error);
      setStatus(error.message || "Could not load videos from YouTube.");
    } finally {
      setBusy(false);
    }
  }

  return {
    getSelectedVideoId: () => selectedVideoId,
    getVideos: () => videos,
    load,
    render,
    reset,
    select
  };
}
