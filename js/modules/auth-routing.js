import {firebaseAuthorizedDomains} from "../firebase-config.js";

export const loginUrl = new URL("../../login.html", import.meta.url);
export const dashboardUrl = new URL("../../index.html", import.meta.url);

export function safeReturnUrl() {
  const returnTo = new URLSearchParams(window.location.search).get("returnTo");
  if (!returnTo) return dashboardUrl.href;
  try {
    const target = new URL(returnTo, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname === loginUrl.pathname) {
      return dashboardUrl.href;
    }
    return target.href;
  } catch {
    return dashboardUrl.href;
  }
}

export function loginUrlForCurrentPage() {
  const url = new URL(loginUrl.href);
  url.searchParams.set("returnTo", `${window.location.pathname}${window.location.search}`);
  return url.href;
}

export function warnIfUnauthorizedHost({isLoginPage, firebaseConfigured, showMessage}) {
  const hostname = window.location.hostname;
  if (!isLoginPage || !firebaseConfigured || firebaseAuthorizedDomains.includes(hostname)) return;
  showMessage(
    `Heads up: ${hostname || "this file preview"} is not listed as a Firebase authorized domain yet. If account creation fails, add this exact host in Firebase Authentication settings or test from localhost.`,
    "setup"
  );
}
