import {
  getApps,
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  EmailAuthProvider,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";
import {createStatusSetter, setControlsDisabled} from "./services/ui-state.js?v=1";

(function () {
  const featureAvailability = {
    emailNotifications: false
  };
  const defaults = {
    darkMode: "off",
    emailNotifications: "enabled",
    plan: "basic"
  };

  const planLimits = {
    basic: {
      label: "Basic",
      videos: Infinity,
      channels: 1,
      aiAnalyses: Infinity
    },
    pro: {
      label: "Pro",
      videos: Infinity,
      channels: 5,
      aiAnalyses: Infinity
    },
    premium: {
      label: "Premium",
      videos: Infinity,
      channels: 5,
      aiAnalyses: Infinity
    }
  };

  const status = document.getElementById("settingsStatus");
  const upgradeButton = document.getElementById("upgradePlan");
  const closeModal = document.getElementById("closeModal");
  const toggles = document.querySelectorAll("[data-setting]");
  const currentPlanLabels = document.querySelectorAll("[data-current-plan]");
  const planCards = document.querySelectorAll("[data-plan-card]");
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
    if (key === "plan") return defaults.plan;
    return localStorage.getItem(`viewcast:${key}`) || defaults[key];
  }

  function writeSetting(key, value) {
    localStorage.setItem(`viewcast:${key}`, value);
    if (key === "darkMode") {
      localStorage.setItem("viewcastDarkMode", value);
      document.body.classList.toggle("settings-dark", value === "on");
    }
  }

  function readVideosAnalyzed() {
    return 0;
  }

  function readAiAnalysesUsed() {
    return 0;
  }

  function readChannelsConnected() {
    try {
      const savedConnections = localStorage.getItem("viewcastYouTubeAllConnections");
      const connections = JSON.parse(savedConnections || "[]");
      if (savedConnections && Array.isArray(connections)) return Math.min(5, connections.length);
      const connection = JSON.parse(localStorage.getItem("viewcastYouTubeConnection") || "null");
      if (connection?.channel?.id || connection?.channel?.url || connection?.channel?.title) return 1;
      const channel = JSON.parse(localStorage.getItem("viewcastYouTubeChannel") || "null");
      return channel?.id || channel?.url || channel?.title ? 1 : 0;
    } catch (error) {
      return 0;
    }
  }

  function usageText(value, limit) {
    if (limit === Infinity) return "Unlimited";
    return `${value} / ${limit}`;
  }

  function usagePercent(value, limit) {
    if (limit === Infinity) return 0;
    return Math.max(0, Math.min(100, Math.round((value / Math.max(1, limit)) * 100)));
  }

  function updateUsageBar(type, value, limit) {
    if (usageLabels[type]) usageLabels[type].textContent = usageText(value, limit);
    if (usageBars[type]) usageBars[type].dataset.value = String(usagePercent(value, limit));
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
        setControlsDisabled(button, isCurrent);
        button.textContent = isCurrent
          ? "Active Plan"
          : button.dataset.planChoice === "basic"
            ? "Switch to Basic"
            : button.dataset.planChoice === "pro"
              ? "Upgrade to Pro"
              : "Choose Premium";
        button.classList.toggle("is-current-plan", isCurrent);
      }
    });

    updateUsageBar("videos", videosAnalyzed, plan.videos);
    updateUsageBar("channels", channelsConnected, plan.channels);
    updateUsageBar("aiAnalyses", aiAnalysesUsed, plan.aiAnalyses);
  }

  const showStatus = createStatusSetter(status, {hideWhenEmpty: true});
  const setDeleteStatus = createStatusSetter(deleteStatus, {reflectType: true});

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

    if (setting === "emailNotifications" && !featureAvailability.emailNotifications) {
      group.querySelectorAll("button").forEach((button) => {
        setControlsDisabled(button, true);
        button.title = "Email notifications are coming soon";
      });
      group.setAttribute("aria-disabled", "true");
      return;
    }

    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      writeSetting(setting, button.dataset.value);
      updateToggle(group, button.dataset.value);
      showStatus("Preference updated.");
    });
  });

  updatePlanDisplay();

  window.addEventListener("storage", (event) => {
    if (
      event.key === "viewcastYouTubeAllConnections"
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
    setControlsDisabled(confirmDeleteButton, true);
    setDeleteStatus("Confirming your identity…", "info");
    try {
      const user = accountUser;
      await reauthenticateForDeletion(user);
      setDeleteStatus("Deleting your account…", "info");
      const app = getApps().length
        ? getApps()[0]
        : initializeApp(firebaseConfig);
      const deleteAccount = httpsCallable(getFunctions(app), "deleteAccount");
      await deleteAccount();
      clearLocalAccountData();
      window.location.replace("../login.html?deleted=1");
    } catch (error) {
      console.error("Account deletion failed.", error);
      setDeleteStatus(deleteErrorMessage(error), "error");
      setControlsDisabled(confirmDeleteButton, false);
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

})();
