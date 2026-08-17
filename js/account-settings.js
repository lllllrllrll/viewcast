import {
  EmailAuthProvider,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  updatePassword,
  verifyBeforeUpdateEmail
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { firebaseConfig } from "./firebase-config.js";
import { secureSignOut } from "./privacy.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
let currentUser = null;
let usesPasswordProvider = false;
let verificationRequestInProgress = false;

function setCredentialStatus(message, type = "") {
  const status = document.getElementById("credentialStatus");
  if (!status) return;
  status.textContent = message;
  status.dataset.type = type;
}

function authErrorMessage(error) {
  const messages = {
    "auth/email-already-in-use": "That email address is already in use.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/invalid-credential": "The current password is incorrect.",
    "auth/invalid-continue-uri": "The verification return address is invalid.",
    "auth/missing-continue-uri": "Firebase is missing a verification return address.",
    "auth/requires-recent-login": "Please sign out, sign back in, and try again.",
    "auth/too-many-requests": "Too many verification emails were requested. Please wait and try again.",
    "auth/unauthorized-continue-uri": "This site is not authorized to send verification emails. Add its hostname in Firebase Authentication settings.",
    "auth/weak-password": "Choose a password with at least six characters.",
    "auth/popup-closed-by-user": "The sign-in confirmation was closed."
  };
  return messages[error?.code]
    || `Firebase could not complete the request${error?.code ? ` (${error.code})` : ""}. Please try again.`;
}

function renderEmailVerification(user) {
  const status = document.getElementById("emailVerificationStatus");
  const button = document.getElementById("sendVerificationEmail");
  const gateNotice = document.getElementById("verificationGateNotice");
  if (!status || !button || !gateNotice) return;
  const canVerify = Boolean(user?.email);

  if (user?.emailVerified) {
    status.textContent = "Verified";
    status.dataset.verified = "true";
    button.hidden = true;
    button.disabled = true;
    gateNotice.hidden = true;
    return;
  }

  status.textContent = canVerify ? "Not verified" : "No email address available";
  status.dataset.verified = "false";
  button.hidden = !canVerify;
  button.disabled = !canVerify || verificationRequestInProgress;
  button.textContent = verificationRequestInProgress ? "Sending…" : "Send verification email";
  gateNotice.hidden = false;
}

async function refreshEmailVerificationStatus() {
  if (!currentUser || verificationRequestInProgress) return;
  const wasVerified = currentUser.emailVerified;
  try {
    await currentUser.reload();
    currentUser = auth.currentUser || currentUser;
    renderEmailVerification(currentUser);
    if (!wasVerified && currentUser.emailVerified) {
      setCredentialStatus("Email verified successfully.", "success");
    }
  } catch (error) {
    console.warn("Could not refresh email verification status.", error);
  }
}

async function reauthenticateUser(password = "") {
  if (!currentUser) throw new Error("No signed-in user.");
  if (usesPasswordProvider) {
    if (!password) {
      const error = new Error("Current password required.");
      error.code = "auth/invalid-credential";
      throw error;
    }
    const credential = EmailAuthProvider.credential(currentUser.email, password);
    await reauthenticateWithCredential(currentUser, credential);
    return;
  }
  await reauthenticateWithPopup(currentUser, new GoogleAuthProvider());
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("../login.html");
    return;
  }

  currentUser = user;
  usesPasswordProvider = user.providerData.some((provider) => provider.providerId === "password");
  const usesGoogleProvider = user.providerData.some((provider) => provider.providerId === "google.com");
  const planKey = "basic";
  const plan = planKey.charAt(0).toUpperCase() + planKey.slice(1);
  document.getElementById("planLabel").textContent = plan;
  document.getElementById("accountId").textContent = user.uid;
  document.getElementById("memberSince").textContent = new Date(user.metadata.creationTime).toLocaleDateString();
  document.getElementById("lastSignIn").textContent = new Date(user.metadata.lastSignInTime).toLocaleString();

  document.querySelectorAll("[data-user-name]").forEach((element) => {
    element.textContent = user.displayName || user.email?.split("@")[0] || "ViewCast user";
  });
  document.querySelectorAll("[data-user-email]").forEach((element) => {
    element.textContent = user.email || "No email address";
  });
  document.getElementById("signInMethod").textContent = usesPasswordProvider
    ? "Email and password"
    : usesGoogleProvider ? "Google" : "Connected provider";
  document.querySelector(".current-password-field").hidden = !usesPasswordProvider;
  document.getElementById("togglePasswordForm").disabled = !usesPasswordProvider;
  document.getElementById("resetPasswordEmail").hidden = !usesPasswordProvider;
  document.getElementById("passwordDisplay").textContent = usesPasswordProvider
    ? "••••••••••••"
    : "Managed by your provider";
  renderEmailVerification(user);
});

document.getElementById("signOutBtn")?.addEventListener("click", async () => {
  try {
    await secureSignOut(auth, signOut);
    window.location.replace("../login.html");
  } catch (error) {
    setCredentialStatus(authErrorMessage(error), "error");
  }
});

document.getElementById("toggleEmailForm")?.addEventListener("click", () => {
  document.getElementById("changeEmailForm").hidden = false;
  document.getElementById("newEmail").focus();
  setCredentialStatus("");
});

document.getElementById("togglePasswordForm")?.addEventListener("click", () => {
  if (!usesPasswordProvider) {
    setCredentialStatus("Your password is managed by your sign-in provider.", "info");
    return;
  }
  document.getElementById("changePasswordForm").hidden = false;
  document.getElementById("passwordCurrentPassword").focus();
  setCredentialStatus("");
});

document.getElementById("resetPasswordEmail")?.addEventListener("click", async (event) => {
  if (!currentUser?.email || !usesPasswordProvider) return;
  const button = event.currentTarget;
  button.disabled = true;
  setCredentialStatus("Sending a password reset email…", "info");
  try {
    await sendPasswordResetEmail(auth, currentUser.email);
    setCredentialStatus(
      `Password reset instructions were sent to ${currentUser.email}. Check your inbox and spam folder.`,
      "success"
    );
  } catch (error) {
    setCredentialStatus(authErrorMessage(error), "error");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("sendVerificationEmail")?.addEventListener("click", async () => {
  if (!currentUser?.email || currentUser.emailVerified || verificationRequestInProgress) return;
  verificationRequestInProgress = true;
  renderEmailVerification(currentUser);
  setCredentialStatus("Sending your verification email…", "info");
  try {
    await sendEmailVerification(currentUser);
    setCredentialStatus(
      `Firebase accepted the request for ${currentUser.email}. Check your inbox and spam folder, then return here after opening the link.`,
      "success"
    );
  } catch (error) {
    setCredentialStatus(authErrorMessage(error), "error");
  } finally {
    verificationRequestInProgress = false;
    renderEmailVerification(currentUser);
  }
});

window.addEventListener("focus", refreshEmailVerificationStatus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshEmailVerificationStatus();
});

document.querySelectorAll("[data-close-credential-form]").forEach((button) => {
  button.addEventListener("click", () => {
    const form = document.getElementById(button.dataset.closeCredentialForm);
    form.reset();
    form.hidden = true;
    setCredentialStatus("");
  });
});

document.getElementById("changeEmailForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.getElementById("saveEmail");
  const newEmail = document.getElementById("newEmail").value.trim();
  const password = document.getElementById("emailCurrentPassword").value;
  submit.disabled = true;
  setCredentialStatus("Confirming your identity…", "info");
  try {
    await reauthenticateUser(password);
    await verifyBeforeUpdateEmail(currentUser, newEmail);
    form.reset();
    form.hidden = true;
    setCredentialStatus(`Verification sent to ${newEmail}. Your email will change after you confirm it.`, "success");
  } catch (error) {
    setCredentialStatus(authErrorMessage(error), "error");
  } finally {
    submit.disabled = false;
  }
});

document.getElementById("changePasswordForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.getElementById("savePassword");
  const currentPassword = document.getElementById("passwordCurrentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  if (newPassword !== confirmPassword) {
    setCredentialStatus("The new passwords do not match.", "error");
    return;
  }
  submit.disabled = true;
  setCredentialStatus("Updating your password…", "info");
  try {
    await reauthenticateUser(currentPassword);
    await updatePassword(currentUser, newPassword);
    form.reset();
    form.hidden = true;
    setCredentialStatus("Your password was updated successfully.", "success");
  } catch (error) {
    setCredentialStatus(authErrorMessage(error), "error");
  } finally {
    submit.disabled = false;
  }
});
