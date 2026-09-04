// Firebase web app configuration.
// This object is safe to use in client-side code; access is controlled by
// Firebase Authentication and your Firebase security rules.
export const firebaseConfig = {
  apiKey: "AIzaSyAXPp9GPY6PHZLdNL-qRroKjjg0xRx9Bz4",
  authDomain: "viewcast2.firebaseapp.com",
  projectId: "viewcast2",
  storageBucket: "viewcast2.firebasestorage.app",
  messagingSenderId: "109179683402",
  appId: "1:109179683402:web:803bd04b057012cf1d1cb3"
};

// Google OAuth 2.0 Web Client ID used only for YouTube API authorization.
// Keep channel links in Firestore instead of linking Google providers to Firebase Auth.
export const googleOAuthClientId = "109179683402-9u152t0gq2565t9rdci8b896ual2bba7.apps.googleusercontent.com";

// Gemini is called only through Firebase Functions. Never place its API key in client code.
export const geminiModel = "gemini-3.1-flash-lite";

// Public, domain-restricted reCAPTCHA Enterprise key registered with Firebase
// App Check. This is intentionally client-visible and is not a secret.
export const firebaseAppCheckSiteKey = "6LcpCqgtAAAAAOiJEgu7vF4CZRWTgu2md01ONltV";

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId
);

export const firebaseAuthorizedDomains = [
  "localhost",
  "viewcast1.netlify.app",
  "viewcast2.firebaseapp.com",
  "viewcast2.web.app"
];
