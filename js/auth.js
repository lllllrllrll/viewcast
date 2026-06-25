import {
  getApps,
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  browserLocalPersistence,
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

function showMessage(message, type = "error") {
  const element = document.getElementById("authMessage");
  if (!element) return;
  element.textContent = message;
  element.className = `auth-message ${type}`;
  element.hidden = false;
}

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

function setFormBusy(isBusy) {
  const form = document.getElementById("authForm");
  if (!form) return;
  form.querySelectorAll("button, input").forEach((control) => {
    control.disabled = isBusy;
  });
  const submit = document.getElementById("authSubmit");
  if (submit) submit.textContent = isBusy ? "Please wait..." : submit.dataset.label;
}

function setSubmitStatus(message) {
  const submit = document.getElementById("authSubmit");
  if (submit) submit.textContent = message;
}

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

  const wrapper = document.createElement("div");
  wrapper.className = "account-control";
  wrapper.id = "accountControl";
  wrapper.innerHTML = `
    <div class="account-avatar" aria-hidden="true"></div>
    <div class="account-details">
      <strong></strong>
      <div class="plan-indicator">Basic</div>
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
  wrapper.querySelector(".account-details span").textContent = user.email || "Signed in";
  footer.insertAdjacentElement("beforebegin", wrapper);
  wrapper.querySelector(".account-signout").addEventListener("click", async () => {
    await signOut(auth);
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
    element.textContent = `${displayName}'s account`;
  });
  document.querySelectorAll(".welcome-login").forEach((link) => {
    link.href = "#accountControl";
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
        setSubmitStatus("Saving profile...");
        showStep("Saving your display name...");
        try {
          await updateProfile(credential.user, { displayName });
        } catch (profileError) {
          console.warn("Profile save will be retried on the homepage.", profileError);
        }
        setSubmitStatus("Saving account...");
        showStep("Saving your profile to Firestore...");
        try {
          await syncUserProfile(credential.user, displayName, { isNewAccount: true });
        } catch (profileError) {
          console.warn("Firestore profile save will be retried on the homepage.", profileError);
          showStep("Account created. Opening your dashboard while the profile save retries...");
        }
      } else {
        setSubmitStatus("Signing in...");
        showStep("Signing in with Firebase...");
        const credential = await signInWithEmailAndPassword(auth, email, password);
        try {
          await syncUserProfile(credential.user, displayNameFor(credential.user));
        } catch (profileError) {
          console.warn("Firestore sign-in sync will be retried on the homepage.", profileError);
        }
      }
      setSubmitStatus("Opening dashboard...");
      showStep("Opening your dashboard...");
      window.location.replace(dashboardUrl.href);
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

if (!firebaseConfigured) {
  if (isLoginPage) {
    showMessage(
      "Firebase is not configured yet. Add your web app values in js/firebase-config.js.",
      "setup"
    );
    document.getElementById("authForm")?.querySelectorAll("button, input").forEach((control) => {
      control.disabled = true;
    });
  } else {
    window.location.replace(`${loginUrl.href}?setup=required`);
  }
} else {
  try {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    var auth = getAuth(app);
    var db = getFirestore(app);
    await setPersistence(auth, browserLocalPersistence);

    if (isLoginPage) {
      setupValidationFeedback();
      setupLoginForm();
      warnIfUnauthorizedHost();
    }

    onAuthStateChanged(auth, async (user) => {
      if (isLoginPage) {
        if (user && !authActionInProgress) window.location.replace(dashboardUrl.href);
        return;
      }

      if (!user) {
        window.location.replace(loginUrl.href);
        return;
      }

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
      document.body.classList.add("auth-ready");
    });
  } catch (error) {
    console.error("Firebase Authentication failed to initialize.", error);
    if (isLoginPage) {
      showMessage(
        "Firebase could not initialize. Check the project configuration and authorized domains.",
        "error"
      );
      document.getElementById("authForm")?.querySelectorAll("button, input").forEach((control) => {
        control.disabled = true;
      });
    } else {
      document.body.classList.add("auth-ready");
    }
  }
}
