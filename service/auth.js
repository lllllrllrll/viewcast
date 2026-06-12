import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
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
import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const loginUrl = new URL("../login.html", import.meta.url);
const dashboardUrl = new URL("../index.html", import.meta.url);
const isLoginPage = document.body.dataset.publicPage === "login";
let authActionInProgress = false;

const errorMessages = {
  "auth/email-already-in-use": "An account already exists for this email.",
  "auth/invalid-credential": "The email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/missing-password": "Enter your password.",
  "auth/network-request-failed": "Could not reach Firebase. Check your connection and try again.",
  "auth/operation-not-allowed": "Email/password accounts are not enabled in Firebase Authentication.",
  "auth/too-many-requests": "Too many attempts. Please wait and try again.",
  "auth/unauthorized-domain": `This site domain (${window.location.hostname}) is not authorized in Firebase.`,
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

function setupLoginForm() {
  const form = document.getElementById("authForm");
  const resetButton = document.getElementById("resetPassword");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
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
    document.getElementById("authMessage").hidden = true;
    authActionInProgress = true;

    try {
      if (mode === "signup") {
        setSubmitStatus("Creating account...");
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        sessionStorage.setItem("viewcastDisplayName", displayName);
        setSubmitStatus("Saving profile...");
        try {
          await updateProfile(credential.user, { displayName });
        } catch (profileError) {
          console.warn("Profile save will be retried on the homepage.", profileError);
        }
        setSubmitStatus("Saving account...");
        await saveUserProfile(credential.user, displayName, { isNewAccount: true });
      } else {
        setSubmitStatus("Signing in...");
        const credential = await signInWithEmailAndPassword(auth, email, password);
        await saveUserProfile(credential.user, displayNameFor(credential.user));
      }
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

if (!firebaseConfigured) {
  if (isLoginPage) {
    showMessage(
      "Firebase is not configured yet. Add your web app values in service/firebase-config.js.",
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
    const app = initializeApp(firebaseConfig);
    var auth = getAuth(app);
    var db = getFirestore(app);
    await setPersistence(auth, browserLocalPersistence);

    if (isLoginPage) setupLoginForm();

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

      if (pendingDisplayName && !currentUser.displayName) {
        try {
          await updateProfile(currentUser, { displayName: pendingDisplayName });
          await currentUser.reload();
          currentUser = auth.currentUser || currentUser;
        } catch (error) {
          console.warn("Could not save the pending Firebase display name.", error);
        }
      }

      try {
        await saveUserProfile(currentUser, displayNameFor(currentUser));
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
