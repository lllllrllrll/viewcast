import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app-check.js";
import {firebaseAppCheckSiteKey} from "./firebase-config.js?v=2";

const appCheckInstances = new WeakMap();

export function ensureAppCheck(app) {
  if (!firebaseAppCheckSiteKey) return null;
  let instance = appCheckInstances.get(app);
  if (!instance) {
    instance = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(firebaseAppCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    });
    appCheckInstances.set(app, instance);
  }
  return instance;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function ensureAppCheckToken(app) {
  const appCheck = ensureAppCheck(app);
  if (!appCheck) throw new Error("App Check is not configured.");
  try {
    return await getToken(appCheck, false);
  } catch (error) {
    if (error.code !== "appCheck/initial-throttle") throw error;
    await wait(2000);
    return getToken(appCheck, true);
  }
}
