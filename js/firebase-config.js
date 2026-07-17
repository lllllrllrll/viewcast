// Firebase web app configuration.
// This object is safe to use in client-side code; access is controlled by
// Firebase Authentication and your Firebase security rules.
export const firebaseConfig = {
  apiKey: "AIzaSyDhMbjM7iL56rjsfm1LyE2FhiC1gje0DKE",
  authDomain: "viewcast-a6f31.firebaseapp.com",
  projectId: "viewcast-a6f31",
  storageBucket: "viewcast-a6f31.firebasestorage.app",
  messagingSenderId: "351557961377",
  appId: "1:351557961377:web:fb29d0a5df97d1be3b52e0",
  measurementId: "G-L7TDZVX5WC"
};

// Google OAuth 2.0 Web Client ID used only for YouTube API authorization.
// Keep channel links in Firestore instead of linking Google providers to Firebase Auth.
export const googleOAuthClientId = "351557961377-ocbt4u5dm00n0mqfjvf808rpakc0b5bt.apps.googleusercontent.com";

// Gemini is called through Firebase Functions using the GEMINI_API_KEY secret.
// PASTE YOUR KEY BELOW FOR TESTING.
// Comment it out (set to "") when you want to switch back to secure Firebase Functions.
export const geminiApiKey = "";
export const geminiModel = "gemini-3.1-flash-lite";

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId
);

export const firebaseAuthorizedDomains = [
  "localhost",
  "viewcast-a6f31.firebaseapp.com",
  "viewcast-a6f31.web.app"
];
