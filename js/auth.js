import {getApps, initializeApp} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {getAuth, onAuthStateChanged} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {getFirestore} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {firebaseConfig, firebaseConfigured} from "./firebase-config.js";
import {ensureAppCheck} from "./firebase-app-check.js";
import {configureAuthPersistence, initializeLoginForm} from "./modules/auth-login-form.js?v=1";
import {applyPendingProfile, updateUserInterface} from "./modules/auth-profile.js?v=1";
import {
  loginUrl,
  loginUrlForCurrentPage,
  safeReturnUrl,
  warnIfUnauthorizedHost
} from "./modules/auth-routing.js?v=1";
import {createStatusSetter, setControlsDisabled} from "./services/ui-state.js?v=1";

const isLoginPage = document.body.dataset.publicPage === "login";
const showMessage = createStatusSetter(document.getElementById("authMessage"), {
  defaultType: "error",
  className: (type) => `auth-message ${type}`,
  showWhenSet: true
});
let authActionInProgress = false;

function disableAuthForm() {
  setControlsDisabled(document.getElementById("authForm")?.querySelectorAll("button, input"), true);
}

function handleMissingConfiguration() {
  if (isLoginPage) {
    showMessage("Firebase is not configured yet. Add your web app values in js/firebase-config.js.", "setup");
    disableAuthForm();
    return;
  }
  const setupUrl = new URL(loginUrl.href);
  setupUrl.searchParams.set("setup", "required");
  window.location.replace(setupUrl.href);
}

async function initializeAuthentication() {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  // Protected callable functions require App Check. Initialize attestation
  // before Auth or Firestore can win the Firebase service startup race.
  ensureAppCheck(app);
  const auth = getAuth(app);
  const db = getFirestore(app);
  await configureAuthPersistence(auth);

  if (isLoginPage) {
    initializeLoginForm(auth, showMessage, (active) => { authActionInProgress = active; });
    warnIfUnauthorizedHost({isLoginPage, firebaseConfigured, showMessage});
    if (new URLSearchParams(window.location.search).get("deleted") === "1") {
      showMessage("Your ViewCast account was permanently deleted.", "success");
    }
  }

  onAuthStateChanged(auth, async (user) => {
    if (isLoginPage) {
      if (user && !authActionInProgress) window.location.replace(safeReturnUrl());
      return;
    }
    if (!user) {
      window.location.replace(loginUrlForCurrentPage());
      return;
    }
    updateUserInterface(user, auth);
    document.body.classList.add("auth-ready");
    const currentUser = await applyPendingProfile(auth, db, user);
    updateUserInterface(currentUser, auth);
  });
}

if (!firebaseConfigured) {
  handleMissingConfiguration();
} else {
  try {
    await initializeAuthentication();
  } catch (error) {
    console.error("Firebase Authentication failed to initialize.", error);
    if (isLoginPage) {
      showMessage("Firebase could not initialize. Check the project configuration and authorized domains.", "error");
      disableAuthForm();
    } else {
      document.body.classList.add("auth-ready");
    }
  }
}
