import {
  getApps,
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {
  firebaseAuthorizedDomains,
  firebaseConfig,
  firebaseConfigured
} from "./firebase-config.js";
import { secureSignOut } from "./privacy.js";
import {createBusySetter, createStatusSetter, setControlsDisabled} from "./services/ui-state.js?v=1";

const loginUrl = new URL("../login.html", import.meta.url);
const dashboardUrl = new URL("../index.html", import.meta.url);
const isLoginPage = document.body.dataset.publicPage === "login";
const pendingProfileKey = "viewcastPendingProfile";
let authActionInProgress = false;

const errorMessages = {
  "auth/email-already-in-use": "An account already exists for this email.",
  "auth/invalid-credential": "The email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/missing-password": "Enter your password.",
  "auth/network-request-failed": "Could not reach Firebase. Check your connection and try again.",
  "auth/operation-not-allowed": "Email/password accounts are not enabled in Firebase Authentication.",
  "auth/too-many-requests": "Too many attempts. Please wait and try again.",
  "auth/unauthorized-domain": `This site domain (${window.location.hostname || "file preview"}) is not authorized in Firebase. Add it in Firebase Authentication > Settings > Authorized domains, or use localhost.`,
  "auth/user-disabled": "This account has been disabled.",
  "auth/weak-password": "Use a password with at least six characters."
};

const showMessage = createStatusSetter(document.getElementById("authMessage"), {
  defaultType: "error",
  className: (type) => `auth-message ${type}`,
  showWhenSet: true
});

function showStep(message) {
  showMessage(message, "status");
}

function currentHostname() {
  return window.location.hostname;
}

function isKnownAuthorizedHost() {
  const hostname = currentHostname();
  return firebaseAuthorizedDomains.includes(hostname);
}

function warnIfUnauthorizedHost() {
  if (!isLoginPage || !firebaseConfigured || isKnownAuthorizedHost()) return;

  const hostname = currentHostname() || "this file preview";
  showMessage(
    `Heads up: ${hostname} is not listed as a Firebase authorized domain yet. If account creation fails, add this exact host in Firebase Authentication settings or test from localhost.`,
    "setup"
  );
}

function safeReturnUrl() {
  const returnTo = new URLSearchParams(window.location.search).get("returnTo");
  if (!returnTo) return dashboardUrl.href;

  try {
    const target = new URL(returnTo, window.location.origin);
    if (target.origin !== window.location.origin) return dashboardUrl.href;
    if (target.pathname === loginUrl.pathname) return dashboardUrl.href;
    return target.href;
  } catch (error) {
    return dashboardUrl.href;
  }
}

function destinationForUser() {
  return safeReturnUrl();
}

function loginUrlForCurrentPage() {
  const url = new URL(loginUrl.href);
  url.searchParams.set("returnTo", `${window.location.pathname}${window.location.search}`);
  return url.href;
}

const authForm = document.getElementById("authForm");
const authSubmit = document.getElementById("authSubmit");
const setFormBusy = createBusySetter(
  [...(authForm?.querySelectorAll("button, input") || [])].map((control) => ({
    element: control,
    updateLabel: control === authSubmit
  })),
  {busyLabel: "Please wait...", idleLabel: () => authSubmit?.dataset.label || "Sign in"}
);

const setSubmitStatus = createStatusSetter(authSubmit);

function friendlyError(error) {
  if (error?.code === "permission-denied") {
    return "Your account was created, but Firestore blocked the profile save. Publish the user profile security rules.";
  }
  if (error?.code === "failed-precondition") {
    return "Create the Cloud Firestore database in the Firebase console, then try again.";
  }
  return errorMessages[error?.code] || "Authentication failed. Please try again.";
}

function rememberPendingProfile(user, displayName, options = {}) {
  if (!user) return;

  sessionStorage.setItem("viewcastDisplayName", displayName || displayNameFor(user));
  sessionStorage.setItem(
    pendingProfileKey,
    JSON.stringify({
      uid: user.uid,
      email: user.email || "",
      displayName: displayName || displayNameFor(user),
      isNewAccount: Boolean(options.isNewAccount)
    })
  );
}

function clearPendingProfile() {
  sessionStorage.removeItem(pendingProfileKey);
}

function readPendingProfile(user) {
  try {
    const pendingProfile = JSON.parse(sessionStorage.getItem(pendingProfileKey) || "null");
    if (pendingProfile?.uid === user.uid) return pendingProfile;
  } catch (error) {
    console.warn("Could not read the pending Firebase profile.", error);
  }
  return null;
}

function displayNameFor(user) {
  return (
    user.displayName ||
    sessionStorage.getItem("viewcastDisplayName") ||
    user.email?.split("@")[0] ||
    "User"
  );
}

function addAccountControl(user) {
  const footer = document.querySelector(".sidebar-footer");
  if (!footer || document.getElementById("accountControl")) return;

  const plan = "Basic";

  const wrapper = document.createElement("div");
  wrapper.className = "account-control";
  wrapper.id = "accountControl";
  wrapper.innerHTML = `
    <div class="account-avatar" aria-hidden="true"></div>
    <div class="account-details">
      <strong></strong>
      <div class="plan-indicator"></div>
      <span></span>
    </div>
    <button class="account-signout" type="button" title="Sign out" aria-label="Sign out">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10 17l5-5-5-5"></path>
        <path d="M15 12H3"></path>
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
      </svg>
      <span>Log out</span>
    </button>
  `;

  wrapper.querySelector(".account-avatar").textContent =
    displayNameFor(user).charAt(0).toUpperCase();
  wrapper.querySelector(".account-details strong").textContent = displayNameFor(user);
  wrapper.querySelector(".plan-indicator").textContent = plan;
  wrapper.querySelector(".account-details span").textContent = user.email || "Signed in";
  footer.insertAdjacentElement("beforebegin", wrapper);
  wrapper.querySelector(".account-signout").addEventListener("click", async () => {
    await secureSignOut(auth, signOut);
    window.location.replace(loginUrl.href);
  });
}

function updateUserInterface(user) {
  const displayName = displayNameFor(user);
  document.querySelectorAll("[data-user-name]").forEach((element) => {
    element.textContent = displayName;
  });
  document.querySelectorAll("[data-user-email]").forEach((element) => {
    element.textContent = user.email || "";
  });
  document.querySelectorAll("[data-account-label]").forEach((element) => {
    element.textContent = "Sign Out";
  });
  document.querySelectorAll(".welcome-login").forEach((link) => {
    link.href = "#";
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      await secureSignOut(auth, signOut);
      window.location.replace(loginUrl.href);
    });
  });
  addAccountControl(user);
  if (user.displayName) sessionStorage.removeItem("viewcastDisplayName");
}

async function saveUserProfile(user, displayName, options = {}) {
  const profile = {
    uid: user.uid,
    email: user.email || "",
    displayName: displayName || displayNameFor(user),
    updatedAt: serverTimestamp(),
    lastSignInAt: serverTimestamp()
  };

  if (options.isNewAccount) {
    profile.createdAt = serverTimestamp();
  }

  await setDoc(doc(db, "users", user.uid), profile, { merge: true });
}

async function syncUserProfile(user, displayName, options = {}) {
  rememberPendingProfile(user, displayName, options);
  await saveUserProfile(user, displayName, options);
  clearPendingProfile();
}

function setupLoginForm() {
  const form = document.getElementById("authForm");
  const resetButton = document.getElementById("resetPassword");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!form.reportValidity()) {
      showMessage("Complete the highlighted fields, then try again.");
      return;
    }

    const data = new FormData(form);
    const email = String(data.get("email")).trim();
    const password = String(data.get("password"));
    const mode = String(data.get("mode"));
    const displayName = String(data.get("displayName") || "").trim();
    const confirmPassword = String(data.get("confirmPassword") || "");

    if (mode === "signup" && displayName.length < 2) {
      showMessage("Enter a display name with at least two characters.");
      return;
    }

    if (mode === "signup" && password !== confirmPassword) {
      showMessage("Passwords do not match.");
      return;
    }

    setFormBusy(true);
    showStep(mode === "signup" ? "Starting account creation..." : "Signing in...");
    authActionInProgress = true;

    try {
      if (mode === "signup") {
        setSubmitStatus("Creating account...");
        showStep("Creating your Firebase account...");
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        rememberPendingProfile(credential.user, displayName, { isNewAccount: true });
        // The dashboard retries the pending display-name and Firestore profile
        // updates. Do not make a successful account creation wait on either
        // secondary network request before navigating.
        void updateProfile(credential.user, { displayName }).catch((profileError) => {
          console.warn("Profile save will be retried on the dashboard.", profileError);
        });
      } else {
        setSubmitStatus("Signing in...");
        showStep("Signing in with Firebase...");
        const credential = await signInWithEmailAndPassword(auth, email, password);
        setSubmitStatus("Opening dashboard...");
        showStep("Opening your dashboard...");
        window.location.replace(destinationForUser(credential.user));
        return;
      }
      setSubmitStatus("Opening dashboard...");
      showStep("Account created successfully. Opening your dashboard...");
      window.location.replace(destinationForUser(auth.currentUser));
    } catch (error) {
      authActionInProgress = false;
      console.error("Firebase authentication request failed.", error);
      showMessage(friendlyError(error));
      setFormBusy(false);
    }
  });

  resetButton.addEventListener("click", async () => {
    const email = document.getElementById("email").value.trim();
    if (!email) {
      showMessage("Enter your email first, then request a reset link.");
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      showMessage("Password reset email sent.", "success");
    } catch (error) {
      showMessage(friendlyError(error));
    }
  });
}

function setupValidationFeedback() {
  const form = document.getElementById("authForm");
  const submit = document.getElementById("authSubmit");
  if (!form || !submit) return;

  submit.addEventListener("click", () => {
    if (!form.checkValidity()) {
      showMessage("Complete the highlighted fields, then try again.");
    }
  });
}

async function configureAuthPersistence(auth) {
  try {
    await setPersistence(auth, browserLocalPersistence);
    return;
  } catch (localError) {
    console.warn("Persistent sign-in storage is unavailable; using this browser session instead.", localError);
  }

  try {
    await setPersistence(auth, browserSessionPersistence);
  } catch (sessionError) {
    // Persistence failure must not prevent the auth observer from restoring an
    // already initialized user or stop the rest of the application booting.
    console.warn("Session sign-in storage is also unavailable.", sessionError);
  }
}

if (!firebaseConfigured) {
  if (isLoginPage) {
    showMessage(
      "Firebase is not configured yet. Add your web app values in js/firebase-config.js.",
      "setup"
    );
    setControlsDisabled(document.getElementById("authForm")?.querySelectorAll("button, input"), true);
  } else {
    const setupUrl = new URL(loginUrl.href);
    setupUrl.searchParams.set("setup", "required");
    window.location.replace(setupUrl.href);
  }
} else {
  try {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    var auth = getAuth(app);
    var db = getFirestore(app);
    await configureAuthPersistence(auth);

    if (isLoginPage) {
      setupValidationFeedback();
      setupLoginForm();
      warnIfUnauthorizedHost();
      if (new URLSearchParams(window.location.search).get("deleted") === "1") {
        showMessage("Your ViewCast account was permanently deleted.", "success");
      }
    }

    onAuthStateChanged(auth, async (user) => {
      if (isLoginPage) {
        if (user && !authActionInProgress) window.location.replace(destinationForUser(user));
        return;
      }

      if (!user) {
        window.location.replace(loginUrlForCurrentPage());
        return;
      }

      // Authentication has succeeded, so render immediately. Profile refreshes
      // and Firestore synchronization are network enhancements and must never
      // hold the entire interface behind an invisible auth gate.
      updateUserInterface(user);
      document.body.classList.add("auth-ready");

      try {
        await user.reload();
      } catch (error) {
        console.warn("Could not refresh the Firebase user profile.", error);
      }

      let currentUser = auth.currentUser || user;

      const pendingDisplayName = sessionStorage.getItem("viewcastDisplayName");
      const pendingProfile = readPendingProfile(currentUser);
      const profileDisplayName = pendingProfile?.displayName || pendingDisplayName;

      if (profileDisplayName && !currentUser.displayName) {
        try {
          await updateProfile(currentUser, { displayName: profileDisplayName });
          await currentUser.reload();
          currentUser = auth.currentUser || currentUser;
        } catch (error) {
          console.warn("Could not save the pending Firebase display name.", error);
        }
      }

      try {
        await syncUserProfile(
          currentUser,
          profileDisplayName || displayNameFor(currentUser),
          { isNewAccount: Boolean(pendingProfile?.isNewAccount) }
        );
      } catch (error) {
        console.warn("Could not sync the Firebase user profile to Firestore.", error);
      }

      updateUserInterface(currentUser);
    });
  } catch (error) {
    console.error("Firebase Authentication failed to initialize.", error);
    if (isLoginPage) {
      showMessage(
        "Firebase could not initialize. Check the project configuration and authorized domains.",
        "error"
      );
      setControlsDisabled(document.getElementById("authForm")?.querySelectorAll("button, input"), true);
    } else {
      document.body.classList.add("auth-ready");
    }
  }
}
