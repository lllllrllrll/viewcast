function themeColor(variable, fallback) {
  return getComputedStyle(document.body).getPropertyValue(variable).trim() || fallback;
}

const colors = {
  get ink() { return themeColor("--ink", "#1c2430"); },
  get surface() { return themeColor("--surface", "#ffffff"); },
  get muted() { return themeColor("--muted", "#667085"); },
  get line() { return themeColor("--line", "#d8e0ea"); },
  get teal() { return themeColor("--teal", "#0f8b8d"); },
  get blue() { return themeColor("--blue", "#3267d6"); },
  get amber() { return themeColor("--amber", "#c47f13"); },
  get rose() { return themeColor("--rose", "#d04d67"); },
  get green() { return themeColor("--green", "#2f9b6c"); }
};

// Start authentication before any optional dashboard setup. If another piece of
// page initialization fails, the auth gate must still be able to reveal or
// redirect the page instead of leaving the app permanently hidden.
const authModuleUrl = new URL("../js/auth.js?v=20", document.currentScript.src);
const authInitialization = import(authModuleUrl.href);

window.setTimeout(() => {
  if (document.body.classList.contains("auth-ready")) return;
  console.warn("Authentication is taking longer than expected; revealing the page shell.");
  document.body.classList.add("auth-ready", "auth-delayed");
}, 8000);

try {
  document.body.classList.toggle(
    "settings-dark",
    localStorage.getItem("viewcastDarkMode") === "on"
  );
} catch (error) {
  console.warn("Could not load the saved color theme.", error);
}
