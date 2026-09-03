import {signOut, updateProfile} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {doc, serverTimestamp, setDoc} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {secureSignOut} from "../services/privacy.js?v=1";
import {loginUrl} from "./auth-routing.js?v=1";

const pendingProfileKey = "viewcastPendingProfile";

export function displayNameFor(user) {
  return user.displayName || sessionStorage.getItem("viewcastDisplayName") ||
    user.email?.split("@")[0] || "User";
}

export function rememberPendingProfile(user, displayName, options = {}) {
  if (!user) return;
  sessionStorage.setItem("viewcastDisplayName", displayName || displayNameFor(user));
  sessionStorage.setItem(pendingProfileKey, JSON.stringify({
    uid: user.uid,
    email: user.email || "",
    displayName: displayName || displayNameFor(user),
    isNewAccount: Boolean(options.isNewAccount)
  }));
}

export function readPendingProfile(user) {
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingProfileKey) || "null");
    return pending?.uid === user.uid ? pending : null;
  } catch (error) {
    console.warn("Could not read the pending Firebase profile.", error);
    return null;
  }
}

async function saveUserProfile(db, user, displayName, options = {}) {
  const profile = {
    uid: user.uid,
    email: user.email || "",
    displayName: displayName || displayNameFor(user),
    updatedAt: serverTimestamp(),
    lastSignInAt: serverTimestamp()
  };
  if (options.isNewAccount) profile.createdAt = serverTimestamp();
  await setDoc(doc(db, "users", user.uid), profile, {merge: true});
}

export async function syncUserProfile(db, user, displayName, options = {}) {
  rememberPendingProfile(user, displayName, options);
  await saveUserProfile(db, user, displayName, options);
  sessionStorage.removeItem(pendingProfileKey);
}

function addAccountControl(user, auth) {
  const footer = document.querySelector(".sidebar-footer");
  if (!footer || document.getElementById("accountControl")) return;
  const wrapper = document.createElement("div");
  wrapper.className = "account-control";
  wrapper.id = "accountControl";
  wrapper.innerHTML = `
    <div class="account-avatar" aria-hidden="true"></div>
    <div class="account-details"><strong></strong><div class="plan-indicator">Basic</div><span></span></div>
    <button class="account-signout" type="button" title="Sign out" aria-label="Sign out">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path></svg>
      <span>Log out</span>
    </button>`;
  const name = displayNameFor(user);
  wrapper.querySelector(".account-avatar").textContent = name.charAt(0).toUpperCase();
  wrapper.querySelector(".account-details strong").textContent = name;
  wrapper.querySelector(".account-details span").textContent = user.email || "Signed in";
  footer.insertAdjacentElement("beforebegin", wrapper);
  wrapper.querySelector(".account-signout").addEventListener("click", async () => {
    await secureSignOut(auth, signOut);
    window.location.replace(loginUrl.href);
  });
}

export function updateUserInterface(user, auth) {
  const displayName = displayNameFor(user);
  document.querySelectorAll("[data-user-name]").forEach((element) => { element.textContent = displayName; });
  document.querySelectorAll("[data-user-email]").forEach((element) => { element.textContent = user.email || ""; });
  document.querySelectorAll("[data-account-label]").forEach((element) => { element.textContent = "Sign Out"; });
  document.querySelectorAll(".welcome-login").forEach((link) => {
    link.href = "#";
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      await secureSignOut(auth, signOut);
      window.location.replace(loginUrl.href);
    });
  });
  addAccountControl(user, auth);
  if (user.displayName) sessionStorage.removeItem("viewcastDisplayName");
}

export async function applyPendingProfile(auth, db, user) {
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
      await updateProfile(currentUser, {displayName: profileDisplayName});
      await currentUser.reload();
      currentUser = auth.currentUser || currentUser;
    } catch (error) {
      console.warn("Could not save the pending Firebase display name.", error);
    }
  }
  try {
    await syncUserProfile(db, currentUser, profileDisplayName || displayNameFor(currentUser), {
      isNewAccount: Boolean(pendingProfile?.isNewAccount)
    });
  } catch (error) {
    console.warn("Could not sync the Firebase user profile to Firestore.", error);
  }
  return currentUser;
}
