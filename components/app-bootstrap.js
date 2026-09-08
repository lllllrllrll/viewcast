// Start authentication before any optional dashboard setup. If another piece of
// page initialization fails, the auth gate must still be able to reveal or
// redirect the page instead of leaving the app permanently hidden.
const authModuleUrl = new URL("../js/auth.js?v=21", document.currentScript.src);
window.authInitialization = import(authModuleUrl.href);

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
