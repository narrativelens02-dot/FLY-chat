// ===== Firebase Configuration — FLYchat =====
// Project: flychat-8eeab
// Console: https://console.firebase.google.com/project/flychat-8eeab

import { initializeApp }    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider }
                             from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore }      from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage }        from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { getAnalytics }      from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCQAAggcn9Vw_J3JmWCCgM3yQNxP-n3ReA",
  authDomain:        "flychat-8eeab.firebaseapp.com",
  projectId:         "flychat-8eeab",
  storageBucket:     "flychat-8eeab.firebasestorage.app",
  messagingSenderId: "484573322859",
  appId:             "1:484573322859:web:0e4820514d848f58985b2e",
  measurementId:     "G-ZZ5EXPKBBC"
};

// Initialize Firebase
const app       = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export const auth          = getAuth(app);
export const db            = getFirestore(app);
export const storage       = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

googleProvider.addScope('email');
googleProvider.addScope('profile');

export { app };
