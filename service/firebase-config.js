// Replace these values with the web app configuration from:
// Firebase console > Project settings > Your apps > Web app.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export const firebaseConfigured = !Object.values(firebaseConfig).some((value) =>
  value.startsWith("YOUR_")
);
