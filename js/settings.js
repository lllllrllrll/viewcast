(function () {
  const defaults = {
    darkMode: "off",
    emailNotifications: "enabled",
    refreshRate: "hourly",
    plan: "basic"
  };

  const planLimits = {
    basic: {
      label: "Basic",
      videos: 5,
      channels: 1
    },
    pro: {
      label: "Pro",
      videos: Infinity,
      channels: 1
    },
    premium: {
      label: "Premium",
      videos: Infinity,
      channels: 10
    }
  };

  const status = document.getElementById("settingsStatus");
  const upgradeButton = document.getElementById("upgradePlan");
  const planModal = document.getElementById("planModal");
  const closeModal = document.getElementById("closeModal");
  const refreshRate = document.getElementById("refreshRate");
  const toggles = document.querySelectorAll("[data-setting]");
  const currentPlanLabels = document.querySelectorAll("[data-current-plan]");
  const planCards = document.querySelectorAll("[data-plan-card]");
  const planButtons = document.querySelectorAll("[data-plan-choice]");
  const usageLabels = {
    videos: document.querySelector("[data-usage-label='videos']"),
    channels: document.querySelector("[data-usage-label='channels']")
  };
  const usageBars = {
    videos: document.querySelector("[data-usage-bar='videos']"),
    channels: document.querySelector("[data-usage-bar='channels']")
  };

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

  function currentUsageMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function readVideosAnalyzed() {
    try {
      const usage = JSON.parse(localStorage.getItem("viewcastVideosAnalyzed") || "null");
      return usage?.month === currentUsageMonth() ? Number(usage.count) || 0 : 0;
    } catch (error) {
      localStorage.removeItem("viewcastVideosAnalyzed");
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
        } else if (button.dataset.planChoice === "premium") {
          button.style.background = "#2c3e50";
          button.style.color = "";
        } else {
          button.style.background = "";
          button.style.color = "";
        }
      }
    });

    updateUsageBar("videos", videosAnalyzed, plan.videos);
    updateUsageBar("channels", channelsConnected, plan.channels);
  }

  function showStatus(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
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

  if (refreshRate) {
    refreshRate.value = readSetting("refreshRate");
    refreshRate.addEventListener("change", () => {
      writeSetting("refreshRate", refreshRate.value);
      showStatus("Refresh rate updated.");
    });
  }

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
      || event.key === "viewcastYouTubeConnection"
      || event.key === "viewcastYouTubeChannel"
      || event.key === "viewcast:plan"
    ) {
      updatePlanDisplay();
    }
  });

  upgradeButton?.addEventListener("click", () => {
    planModal.hidden = false;
  });

  closeModal?.addEventListener("click", () => {
    planModal.hidden = true;
  });

  planModal?.addEventListener("click", (e) => {
    if (e.target === planModal) planModal.hidden = true;
  });
})();
