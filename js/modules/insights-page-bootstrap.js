import {initializeApp, getApps} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getAuth, onAuthStateChanged} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {getFirestore} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {firebaseConfig, firebaseConfigured} from "../firebase-config.js";
import {startStudioAutoRefresh} from "../services/studio-auto-refresh.js?v=1";

function handleReadMoreClick(event) {
  const button = event.target instanceof Element ? event.target.closest(".read-more-button") : null;
  if (!button) return;
  const item = button.closest(".activity-item");
  if (!item) return;
  const isExpanded = item.classList.toggle("is-expanded");
  button.textContent = isExpanded ? "Show less" : "Read more";
  button.setAttribute("aria-expanded", String(isExpanded));
}

export function startInsightsPage({
  form,
  refreshInsightsButton,
  chatForm,
  chatInput,
  dashboard,
  tabs,
  videoLibrary,
  refreshVideosButton,
  onAuthChange,
  onGenerate,
  onRefreshInsights,
  onChatQuestion,
  onActivateTab,
  onTabKeydown,
  onSelectVideo,
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
  const db = getFirestore(app);
  onAuthStateChanged(auth, (user) => onAuthChange(user || null, db));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onGenerate();
  });
  refreshInsightsButton?.addEventListener("click", onRefreshInsights);
  chatForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    onChatQuestion(chatInput?.value.trim() || "");
  });
  document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
    button.addEventListener("click", () => onChatQuestion(button.dataset.chatPrompt || button.textContent.trim()));
  });
  dashboard?.addEventListener("click", handleReadMoreClick);
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => onActivateTab(tab.dataset.insightsTab));
    tab.addEventListener("keydown", onTabKeydown);
  });
  videoLibrary?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const card = target?.closest("[data-video-id]");
    if (card) onSelectVideo(card.dataset.videoId);
  });
  refreshVideosButton?.addEventListener("click", onRefreshVideos);
  startStudioAutoRefresh(onStudioRefresh);
}
