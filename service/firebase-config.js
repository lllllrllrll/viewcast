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

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId
);
