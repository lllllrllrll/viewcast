import {createStatusSetter, setControlsDisabled} from "../services/ui-state.js?v=1";

const featureAvailability = {emailNotifications: false};
const defaults = {
  darkMode: "off",
  emailNotifications: "enabled",
  plan: "basic"
};
const planLimits = {
  basic: {label: "Basic", videos: Infinity, channels: 1, aiAnalyses: Infinity},
  pro: {label: "Pro", videos: Infinity, channels: 5, aiAnalyses: Infinity},
  premium: {label: "Premium", videos: Infinity, channels: 5, aiAnalyses: Infinity}
};

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

function readChannelsConnected() {
  try {
    const savedConnections = localStorage.getItem("viewcastYouTubeAllConnections");
    const connections = JSON.parse(savedConnections || "[]");
    if (savedConnections && Array.isArray(connections)) return Math.min(5, connections.length);
    const connection = JSON.parse(localStorage.getItem("viewcastYouTubeConnection") || "null");
    if (connection?.channel?.id || connection?.channel?.url || connection?.channel?.title) return 1;
    const channel = JSON.parse(localStorage.getItem("viewcastYouTubeChannel") || "null");
    return channel?.id || channel?.url || channel?.title ? 1 : 0;
  } catch {
    return 0;
  }
}

function usageText(value, limit) {
  return limit === Infinity ? "Unlimited" : `${value} / ${limit}`;
}

function usagePercent(value, limit) {
  if (limit === Infinity) return 0;
  return Math.max(0, Math.min(100, Math.round((value / Math.max(1, limit)) * 100)));
}

function updateToggle(group, value) {
  group.querySelectorAll("button").forEach((button) => {
    const isActive = button.dataset.value === value;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

export function initializeSettingsPreferences() {
  const status = document.getElementById("settingsStatus");
  const upgradeButton = document.getElementById("upgradePlan");
  const toggles = document.querySelectorAll("[data-setting]");
  const currentPlanLabels = document.querySelectorAll("[data-current-plan]");
  const planCards = document.querySelectorAll("[data-plan-card]");
  const usageLabels = Object.fromEntries(["videos", "channels", "aiAnalyses"].map((type) => [
    type, document.querySelector(`[data-usage-label='${type}']`)
  ]));
  const usageBars = Object.fromEntries(["videos", "channels", "aiAnalyses"].map((type) => [
    type, document.querySelector(`[data-usage-bar='${type}']`)
  ]));
  const showStatus = createStatusSetter(status, {hideWhenEmpty: true});

  function updateUsageBar(type, value, limit) {
    if (usageLabels[type]) usageLabels[type].textContent = usageText(value, limit);
    if (usageBars[type]) usageBars[type].dataset.value = String(usagePercent(value, limit));
  }

  function updatePlanDisplay() {
    const planKey = planLimits[readSetting("plan")] ? readSetting("plan") : defaults.plan;
    const plan = planLimits[planKey];
    currentPlanLabels.forEach((element) => { element.textContent = plan.label; });
    planCards.forEach((card) => {
      const isCurrent = card.dataset.planCard === planKey;
      card.classList.toggle("current", isCurrent);
      const badge = card.querySelector(".plan-badge");
      if (badge) {
        badge.textContent = isCurrent ? "Current" : card.dataset.planCard === "pro" ? "Popular" : "";
        badge.hidden = !badge.textContent;
      }
      const button = card.querySelector("[data-plan-choice]");
      if (!button) return;
      setControlsDisabled(button, isCurrent);
      button.textContent = isCurrent
        ? "Active Plan"
        : button.dataset.planChoice === "basic"
          ? "Switch to Basic"
          : button.dataset.planChoice === "pro" ? "Upgrade to Pro" : "Choose Premium";
      button.classList.toggle("is-current-plan", isCurrent);
    });
    updateUsageBar("videos", 0, plan.videos);
    updateUsageBar("channels", readChannelsConnected(), plan.channels);
    updateUsageBar("aiAnalyses", 0, plan.aiAnalyses);
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
    if ([
      "viewcastYouTubeAllConnections",
      "viewcastYouTubeConnection",
      "viewcastYouTubeChannel",
      "viewcast:plan"
    ].includes(event.key)) updatePlanDisplay();
  });
  window.addEventListener("viewcast:ai-usage-updated", updatePlanDisplay);
  upgradeButton?.addEventListener("click", () => window.showPlanModal?.());
}
