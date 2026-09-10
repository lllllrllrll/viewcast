import {initializeApp, getApps} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getAuth, onAuthStateChanged} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {firebaseConfig, firebaseConfigured} from "../firebase-config.js";
import {startStudioAutoRefresh} from "../services/studio-auto-refresh.js?v=1";
import {activeYouTubeChannelId} from "../services/youtube-session.js?v=1";
import {parseVideoId} from "./analyzer-video-library.js?v=1";

export const pendingAnalyzerVideoKey = "viewcastPendingAnalyzerVideo";

export function initialAnalyzerVideoId() {
  const params = new URLSearchParams(window.location.search);
  const rawVideo = params.get("video") || params.get("v") ||
    sessionStorage.getItem(pendingAnalyzerVideoKey) || "";
  return parseVideoId(rawVideo);
}

export function startAnalyzerPage({
  form,
  videoLibrary,
  refreshVideosButton,
  initialVideoId,
  onAuthChange,
  onAnalyze,
  onRefreshVideos,
  onStudioRefresh,
  setStatus
}) {
  if (!form) return;
  if (!firebaseConfigured) {
    setStatus("Firebase is not configured yet.");
    return;
  }

  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);

  onAuthStateChanged(auth, (user) => onAuthChange(user || null, initialVideoId));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onAnalyze();
  });
  videoLibrary?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest("[data-video-id]");
    if (card) onAnalyze(card.dataset.videoId);
  });
  refreshVideosButton?.addEventListener("click", () => onRefreshVideos());
  startStudioAutoRefresh(async () => {
    if (!activeYouTubeChannelId()) return;
    await onStudioRefresh();
  });
}
