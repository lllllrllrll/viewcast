(function () {
  const defaults = {
    darkMode: "off",
    emailNotifications: "enabled",
    refreshRate: "hourly"
  };

  const status = document.getElementById("settingsStatus");
  const saveButton = document.getElementById("saveSettings");
  const upgradeButton = document.getElementById("upgradePlan");
  const refreshRate = document.getElementById("refreshRate");
  const toggles = document.querySelectorAll("[data-setting]");

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
      showStatus("Preference updated. Save changes when you're done.");
    });
  });

  if (refreshRate) {
    refreshRate.value = readSetting("refreshRate");
    refreshRate.addEventListener("change", () => {
      writeSetting("refreshRate", refreshRate.value);
      showStatus("Refresh rate updated. Save changes when you're done.");
    });
  }

  saveButton?.addEventListener("click", () => {
    showStatus("Settings saved.");
  });

  upgradeButton?.addEventListener("click", () => {
    showStatus("Upgrade flow is ready for billing integration.");
  });
})();
