import {
  getApps,
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  deleteUser,
  EmailAuthProvider,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  deleteDoc,
  doc,
  getFirestore
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

(function () {
  const defaults = {
    darkMode: "off",
    emailNotifications: "enabled",
    plan: "basic"
  };

  const planLimits = {
    basic: {
      label: "Basic",
      videos: 5,
      channels: 1,
      aiAnalyses: 5
    },
    pro: {
      label: "Pro",
      videos: Infinity,
      channels: 1,
      aiAnalyses: Infinity
    },
    premium: {
      label: "Premium",
      videos: Infinity,
      channels: 10,
      aiAnalyses: Infinity
    }
  };

  const status = document.getElementById("settingsStatus");
  const upgradeButton = document.getElementById("upgradePlan");
  const planModal = document.getElementById("planModal");
  const closeModal = document.getElementById("closeModal");
  const toggles = document.querySelectorAll("[data-setting]");
  const currentPlanLabels = document.querySelectorAll("[data-current-plan]");
  const planCards = document.querySelectorAll("[data-plan-card]");
  const planButtons = document.querySelectorAll("[data-plan-choice]");
  const usageLabels = {
    videos: document.querySelector("[data-usage-label='videos']"),
    channels: document.querySelector("[data-usage-label='channels']"),
    aiAnalyses: document.querySelector("[data-usage-label='aiAnalyses']")
  };
  const usageBars = {
    videos: document.querySelector("[data-usage-bar='videos']"),
    channels: document.querySelector("[data-usage-bar='channels']"),
    aiAnalyses: document.querySelector("[data-usage-bar='aiAnalyses']")
  };
  const deleteModal = document.getElementById("deleteAccountModal");
  const deleteForm = document.getElementById("deleteAccountForm");
  const deletePasswordField = document.getElementById("deletePasswordField");
  const deletePassword = document.getElementById("deleteAccountPassword");
  const deleteStatus = document.getElementById("deleteAccountStatus");
  const confirmDeleteButton = document.getElementById("confirmDeleteAccount");
  let shouldOpenDeleteAccount = new URLSearchParams(window.location.search).get("delete") === "1";
  let accountUser = null;
  let usesPasswordProvider = false;

  function readSetting(key) {
    return localStorage.getItem(`viewcast:${key}`) || defaults[key];
  }

  function writeSetting(key, value) {
    localStorage.setItem(`viewcast:${key}`, value);
    if (key === "darkMode") {
      localStorage.setItem("viewcastDarkMode", value);
      document.body.classList.toggle("settings-dark", value === "on");
    }
  }

  function currentUsageDay() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function readVideosAnalyzed() {
    try {
      const usage = JSON.parse(localStorage.getItem("viewcastVideosAnalyzed") || "null");
      return usage?.day === currentUsageDay() ? Number(usage.count) || 0 : 0;
    } catch (error) {
      localStorage.removeItem("viewcastVideosAnalyzed");
      return 0;
    }
  }

  function readAiAnalysesUsed() {
    try {
      const usage = JSON.parse(localStorage.getItem("viewcastAiAnalysesUsed") || "null");
      return usage?.day === currentUsageDay() ? Number(usage.count) || 0 : 0;
    } catch (error) {
      localStorage.removeItem("viewcastAiAnalysesUsed");
      return 0;
    }
  }

  function readChannelsConnected() {
    try {
      const connection = JSON.parse(localStorage.getItem("viewcastYouTubeConnection") || "null");
      if (connection?.channel?.id || connection?.channel?.url || connection?.channel?.title) return 1;
      const channel = JSON.parse(localStorage.getItem("viewcastYouTubeChannel") || "null");
      return channel?.id || channel?.url || channel?.title ? 1 : 0;
    } catch (error) {
      return 0;
    }
  }

  function usageText(value, limit) {
    if (limit === Infinity) return `${value} / Unlimited`;
    return `${value} / ${limit}`;
  }

  function usagePercent(value, limit) {
    if (limit === Infinity) return 0;
    return Math.max(0, Math.min(100, Math.round((value / Math.max(1, limit)) * 100)));
  }

  function updateUsageBar(type, value, limit) {
    if (usageLabels[type]) usageLabels[type].textContent = usageText(value, limit);
    if (usageBars[type]) usageBars[type].style.setProperty("--value", `${usagePercent(value, limit)}%`);
  }

  function updatePlanDisplay() {
    const planKey = planLimits[readSetting("plan")] ? readSetting("plan") : defaults.plan;
    const plan = planLimits[planKey];
    const videosAnalyzed = readVideosAnalyzed();
    const channelsConnected = readChannelsConnected();
    const aiAnalysesUsed = readAiAnalysesUsed();

    currentPlanLabels.forEach((element) => {
      element.textContent = plan.label;
    });
    planCards.forEach((card) => {
      const isCurrent = card.dataset.planCard === planKey;
      card.classList.toggle("current", isCurrent);
      const badge = card.querySelector(".plan-badge");
      if (badge) {
        badge.textContent = isCurrent ? "Current" : card.dataset.planCard === "pro" ? "Popular" : "";
        badge.hidden = !badge.textContent;
      }
      const button = card.querySelector("[data-plan-choice]");
      if (button) {
        button.disabled = isCurrent;
        button.textContent = isCurrent
          ? "Active Plan"
          : button.dataset.planChoice === "basic"
            ? "Switch to Basic"
            : button.dataset.planChoice === "pro"
              ? "Upgrade to Pro"
              : "Choose Premium";
        if (isCurrent) {
          button.style.background = "var(--line)";
          button.style.color = "var(--muted)";
        } else {
          button.style.background = "";
          button.style.color = "";
        }
      }
    });

    updateUsageBar("videos", videosAnalyzed, plan.videos);
    updateUsageBar("channels", channelsConnected, plan.channels);
    updateUsageBar("aiAnalyses", aiAnalysesUsed, plan.aiAnalyses);
  }

  function showStatus(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function setDeleteStatus(message, type = "") {
    if (!deleteStatus) return;
    deleteStatus.textContent = message;
    deleteStatus.dataset.type = type;
  }

  function closeDeleteModal() {
    if (!deleteModal) return;
    deleteModal.hidden = true;
    deleteForm?.reset();
    setDeleteStatus("");
    document.body.classList.remove("verification-locked");
  }

  function openDeleteModal() {
    if (!deleteModal || !accountUser) return;
    deletePasswordField.hidden = !usesPasswordProvider;
    deletePassword.required = usesPasswordProvider;
    deleteModal.hidden = false;
    document.body.classList.add("verification-locked");
    if (usesPasswordProvider) deletePassword.focus();
  }

  function clearLocalAccountData() {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("viewcast"))
      .forEach((key) => localStorage.removeItem(key));
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("viewcast"))
      .forEach((key) => sessionStorage.removeItem(key));
  }

  async function reauthenticateForDeletion(user) {
    if (usesPasswordProvider) {
      const credential = EmailAuthProvider.credential(user.email, deletePassword.value);
      await reauthenticateWithCredential(user, credential);
      return;
    }
    if (user.providerData.some((provider) => provider.providerId === "google.com")) {
      await reauthenticateWithPopup(user, new GoogleAuthProvider());
      return;
    }
    const error = new Error("Unsupported sign-in provider.");
    error.code = "auth/operation-not-supported-in-this-environment";
    throw error;
  }

  function deleteErrorMessage(error) {
    const messages = {
      "auth/invalid-credential": "The current password is incorrect.",
      "auth/missing-password": "Enter your current password.",
      "auth/popup-closed-by-user": "The sign-in confirmation was closed.",
      "auth/requires-recent-login": "Please sign out, sign back in, and try again.",
      "auth/too-many-requests": "Too many attempts. Please wait and try again.",
      "permission-denied": "ViewCast could not delete your stored profile. Please try again."
    };
    return messages[error?.code] || "Your account could not be deleted. Please try again.";
  }

  function updateToggle(group, value) {
    group.querySelectorAll("button").forEach((button) => {
      const isActive = button.dataset.value === value;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }

  toggles.forEach((group) => {
    const setting = group.dataset.setting;
    updateToggle(group, readSetting(setting));

    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      writeSetting(setting, button.dataset.value);
      updateToggle(group, button.dataset.value);
      showStatus("Preference updated.");
    });
  });

  updatePlanDisplay();

  planButtons.forEach((button) => {
    button.addEventListener("click", () => {
      writeSetting("plan", button.dataset.planChoice);
      updatePlanDisplay();
      showStatus("Plan updated.");
      if (planModal) planModal.hidden = true;
    });
  });

  window.addEventListener("storage", (event) => {
    if (
      event.key === "viewcastVideosAnalyzed"
      || event.key === "viewcastAiAnalysesUsed"
      || event.key === "viewcastYouTubeConnection"
      || event.key === "viewcastYouTubeChannel"
      || event.key === "viewcast:plan"
    ) {
      updatePlanDisplay();
    }
  });

  window.addEventListener("viewcast:ai-usage-updated", updatePlanDisplay);

  upgradeButton?.addEventListener("click", () => {
    if (typeof window.showPlanModal === "function") {
      window.showPlanModal();
    }
  });

  document.getElementById("openDeleteAccount")?.addEventListener("click", openDeleteModal);
  document.getElementById("closeDeleteAccount")?.addEventListener("click", closeDeleteModal);
  document.getElementById("cancelDeleteAccount")?.addEventListener("click", closeDeleteModal);
  deleteModal?.addEventListener("click", (event) => {
    if (event.target === deleteModal) closeDeleteModal();
  });

  deleteForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!accountUser) {
      setDeleteStatus("Your signed-in account could not be loaded.", "error");
      return;
    }
    if (usesPasswordProvider && !deletePassword.value) {
      setDeleteStatus("Enter your current password to delete your account.", "error");
      deletePassword.focus();
      return;
    }
    confirmDeleteButton.disabled = true;
    setDeleteStatus("Confirming your identity…", "info");
    try {
      const user = accountUser;
      await reauthenticateForDeletion(user);
      setDeleteStatus("Deleting your saved ViewCast data…", "info");
      await deleteDoc(doc(getFirestore(), "users", user.uid));
      setDeleteStatus("Deleting your account…", "info");
      await deleteUser(user);
      clearLocalAccountData();
      window.location.replace("../login.html?deleted=1");
    } catch (error) {
      console.error("Account deletion failed.", error);
      setDeleteStatus(deleteErrorMessage(error), "error");
      confirmDeleteButton.disabled = false;
    }
  });

  if (firebaseConfigured) {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    const auth = getAuth(app);
    onAuthStateChanged(auth, (user) => {
      accountUser = user;
      usesPasswordProvider = Boolean(
        user?.providerData.some((provider) => provider.providerId === "password")
      );
      if (user && shouldOpenDeleteAccount) {
        shouldOpenDeleteAccount = false;
        openDeleteModal();
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("delete");
        window.history.replaceState({}, "", cleanUrl);
      }
    });
  }

  // Check for auto-upgrade prompt
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("upgrade") === "limit") {
    if (typeof window.showPlanModal === "function") {
      window.showPlanModal("You've reached the daily analysis limit for the Basic plan. Upgrade to continue.");
    }
  }
})();
