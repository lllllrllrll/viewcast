// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDhMbjM7iL56rjsfm1LyE2FhiC1gje0DKE",
  authDomain: "viewcast-a6f31.firebaseapp.com",
  projectId: "viewcast-a6f31",
  storageBucket: "viewcast-a6f31.firebasestorage.app",
  messagingSenderId: "351557961377",
  appId: "1:351557961377:web:fb29d0a5df97d1be3b52e0",
  measurementId: "G-L7TDZVX5WC"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);