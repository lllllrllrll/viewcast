(function () {
  const tabs = document.querySelectorAll("[data-auth-mode]");
  const submit = document.getElementById("authSubmit");
  const modeInput = document.getElementById("authMode");
  const displayName = document.getElementById("displayName");
  const confirmPassword = document.getElementById("confirmPassword");
  const password = document.getElementById("password");
  const resetButton = document.getElementById("resetPassword");
  const heading = document.getElementById("authHeading");
  const subheading = document.getElementById("authSubheading");
  const message = document.getElementById("authMessage");

  if (
    !tabs.length ||
    !submit ||
    !modeInput ||
    !displayName ||
    !confirmPassword ||
    !password ||
    !resetButton ||
    !heading ||
    !subheading
  ) {
    return;
  }

  function setMode(mode) {
    const isSignup = mode === "signup";

    tabs.forEach((tab) => {
      const isActive = tab.dataset.authMode === mode;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });

    modeInput.value = mode;
    submit.dataset.label = isSignup ? "Create account" : "Sign in";
    submit.textContent = submit.dataset.label;

    document.querySelectorAll(".auth-signup-fields").forEach((field) => {
      field.hidden = !isSignup;
    });

    displayName.required = isSignup;
    confirmPassword.required = isSignup;
    password.autocomplete = isSignup ? "new-password" : "current-password";
    resetButton.hidden = isSignup;
    heading.textContent = isSignup ? "Create your account" : "Welcome back";
    subheading.textContent = isSignup
      ? "Start tracking your channel with ViewCast."
      : "Sign in to continue to your creator dashboard.";

    if (message) message.hidden = true;
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.authMode));
  });

  const initialMode = new URLSearchParams(window.location.search).get("mode");
  setMode(initialMode === "signup" ? "signup" : "signin");
})();
