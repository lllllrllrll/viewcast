import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {createBusySetter, createStatusSetter} from "../services/ui-state.js?v=1";
import {rememberPendingProfile} from "./auth-profile.js?v=1";
import {safeReturnUrl} from "./auth-routing.js?v=1";

const errorMessages = {
  "auth/email-already-in-use": "An account already exists for this email.",
  "auth/invalid-credential": "The email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/missing-password": "Enter your password.",
  "auth/network-request-failed": "Could not reach Firebase. Check your connection and try again.",
  "auth/operation-not-allowed": "Email/password accounts are not enabled in Firebase Authentication.",
  "auth/too-many-requests": "Too many attempts. Please wait and try again.",
  "auth/unauthorized-domain": `This site domain (${window.location.hostname || "file preview"}) is not authorized in Firebase.`,
  "auth/user-disabled": "This account has been disabled.",
  "auth/weak-password": "Use a password with at least six characters."
};

async function requireVerifiedEmail(auth, user, showMessage) {
  if (user.emailVerified) return true;

  try {
    await sendEmailVerification(user);
  } catch (error) {
    console.warn("Could not send the verification email.", error);
  }

  await signOut(auth);
  showMessage(
    "Verify your email using the message Firebase sent you, then sign in again.",
    "success"
  );
  return false;
}

export function friendlyAuthError(error) {
  if (error?.code === "permission-denied") return "Your account was created, but Firestore blocked the profile save.";
  if (error?.code === "failed-precondition") return "Create the Cloud Firestore database, then try again.";
  return errorMessages[error?.code] || "Authentication failed. Please try again.";
}

export async function configureAuthPersistence(auth) {
  try {
    await setPersistence(auth, browserLocalPersistence);
    return;
  } catch (error) {
    console.warn("Persistent sign-in storage is unavailable; using this browser session instead.", error);
  }
  try {
    await setPersistence(auth, browserSessionPersistence);
  } catch (error) {
    console.warn("Session sign-in storage is also unavailable.", error);
  }
}

export function initializeLoginForm(auth, showMessage, onActionChange) {
  const form = document.getElementById("authForm");
  const submit = document.getElementById("authSubmit");
  const resetButton = document.getElementById("resetPassword");
  if (!form) return;
  const setBusy = createBusySetter(
    [...form.querySelectorAll("button, input")].map((control) => ({element: control, updateLabel: control === submit})),
    {busyLabel: "Please wait...", idleLabel: () => submit?.dataset.label || "Sign in"}
  );
  const setSubmitStatus = createStatusSetter(submit);

  submit.addEventListener("click", () => {
    if (!form.checkValidity()) showMessage("Complete the highlighted fields, then try again.");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return showMessage("Complete the highlighted fields, then try again.");
    const data = new FormData(form);
    const email = String(data.get("email")).trim();
    const password = String(data.get("password"));
    const mode = String(data.get("mode"));
    const displayName = String(data.get("displayName") || "").trim();
    if (mode === "signup" && displayName.length < 2) return showMessage("Enter a display name with at least two characters.");
    if (mode === "signup" && password !== String(data.get("confirmPassword") || "")) return showMessage("Passwords do not match.");
    setBusy(true);
    onActionChange(true);
    try {
      if (mode === "signup") {
        setSubmitStatus("Creating account...");
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        rememberPendingProfile(credential.user, displayName, {isNewAccount: true});
        await updateProfile(credential.user, {displayName});
        if (!(await requireVerifiedEmail(auth, credential.user, showMessage))) {
          onActionChange(false);
          setBusy(false);
          return;
        }
      } else {
        setSubmitStatus("Signing in...");
        const credential = await signInWithEmailAndPassword(auth, email, password);
        if (!(await requireVerifiedEmail(auth, credential.user, showMessage))) {
          onActionChange(false);
          setBusy(false);
          return;
        }
      }
      window.location.replace(safeReturnUrl());
    } catch (error) {
      onActionChange(false);
      console.error("Firebase authentication request failed.", error);
      showMessage(friendlyAuthError(error));
      setBusy(false);
    }
  });
  resetButton?.addEventListener("click", async () => {
    const email = document.getElementById("email").value.trim();
    if (!email) return showMessage("Enter your email first, then request a reset link.");
    try {
      await sendPasswordResetEmail(auth, email);
      showMessage("Password reset email sent.", "success");
    } catch (error) {
      showMessage(friendlyAuthError(error));
    }
  });
}
