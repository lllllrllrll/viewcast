import {getApps, initializeApp} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  EmailAuthProvider,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {getFunctions, httpsCallable} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-functions.js";
import {createStatusSetter, setControlsDisabled} from "../services/ui-state.js?v=1";

function clearLocalAccountData() {
  [localStorage, sessionStorage].forEach((storage) => {
    Object.keys(storage)
      .filter((key) => key.startsWith("viewcast"))
      .forEach((key) => storage.removeItem(key));
  });
}

function deleteErrorMessage(error) {
  const messages = {
    "auth/invalid-credential": "The current password is incorrect.",
    "auth/missing-password": "Enter your current password.",
    "auth/popup-closed-by-user": "The sign-in confirmation was closed.",
    "auth/requires-recent-login": "Please sign out, sign back in, and try again.",
    "auth/too-many-requests": "Too many attempts. Please wait and try again.",
    "permission-denied": "ViewCast could not delete your stored profile. Please try again."
  };
  return messages[error?.code] || "Your account could not be deleted. Please try again.";
}

export function initializeAccountDeletion({firebaseConfig, firebaseConfigured}) {
  const modal = document.getElementById("deleteAccountModal");
  const form = document.getElementById("deleteAccountForm");
  const passwordField = document.getElementById("deletePasswordField");
  const password = document.getElementById("deleteAccountPassword");
  const status = document.getElementById("deleteAccountStatus");
  const confirmButton = document.getElementById("confirmDeleteAccount");
  const setStatus = createStatusSetter(status, {reflectType: true});
  let shouldOpen = new URLSearchParams(window.location.search).get("delete") === "1";
  let accountUser = null;
  let usesPasswordProvider = false;

  function close() {
    if (!modal) return;
    modal.hidden = true;
    form?.reset();
    setStatus("");
    document.body.classList.remove("verification-locked");
  }

  function open() {
    if (!modal || !accountUser) return;
    passwordField.hidden = !usesPasswordProvider;
    password.required = usesPasswordProvider;
    modal.hidden = false;
    document.body.classList.add("verification-locked");
    if (usesPasswordProvider) password.focus();
  }

  async function reauthenticate(user) {
    if (usesPasswordProvider) {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password.value));
      return;
    }
    if (user.providerData.some((provider) => provider.providerId === "google.com")) {
      await reauthenticateWithPopup(user, new GoogleAuthProvider());
      return;
    }
    const error = new Error("Unsupported sign-in provider.");
    error.code = "auth/operation-not-supported-in-this-environment";
    throw error;
  }

  document.getElementById("openDeleteAccount")?.addEventListener("click", open);
  document.getElementById("closeDeleteAccount")?.addEventListener("click", close);
  document.getElementById("cancelDeleteAccount")?.addEventListener("click", close);
  modal?.addEventListener("click", (event) => { if (event.target === modal) close(); });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!accountUser) {
      setStatus("Your signed-in account could not be loaded.", "error");
      return;
    }
    if (usesPasswordProvider && !password.value) {
      setStatus("Enter your current password to delete your account.", "error");
      password.focus();
      return;
    }
    setControlsDisabled(confirmButton, true);
    setStatus("Confirming your identity…", "info");
    try {
      await reauthenticate(accountUser);
      setStatus("Deleting your account…", "info");
      const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
      await httpsCallable(getFunctions(app), "deleteAccount")();
      clearLocalAccountData();
      window.location.replace("../login.html?deleted=1");
    } catch (error) {
      console.error("Account deletion failed.", error);
      setStatus(deleteErrorMessage(error), "error");
      setControlsDisabled(confirmButton, false);
    }
  });

  if (!firebaseConfigured) return;
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  onAuthStateChanged(getAuth(app), (user) => {
    accountUser = user;
    usesPasswordProvider = Boolean(user?.providerData.some((provider) => provider.providerId === "password"));
    if (!user || !shouldOpen) return;
    shouldOpen = false;
    open();
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("delete");
    window.history.replaceState({}, "", cleanUrl);
  });
}
