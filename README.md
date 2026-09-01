# ViewCast Dashboard Template

A self-contained responsive video analytics dashboard template with KPI cards, canvas charts, traffic source progress, audience activity, a video performance table, and sidebar page previews for creator workflows.

## Open

Serve the project over HTTP and open `login.html`. Firebase Authentication does not support a complete production flow from a raw `file://` URL.

For a quick local preview:

```bash
npx serve . -listen 4173
```

Then open `http://localhost:4173/login.html`, or replace `4173` with whichever port your local server prints.

If you use Firebase locally, run:

```bash
npx -y firebase-tools@latest emulators:start --only hosting
```

Then open the Hosting URL printed by the emulator, usually `http://localhost:5000/login.html`.

## Firebase Authentication

1. Create or open a project in the [Firebase console](https://console.firebase.google.com/).
2. Add a Web app from **Project settings > Your apps**.
3. In **Authentication > Sign-in method**, enable **Email/Password**.
4. Copy the Firebase web configuration into `js/firebase-config.js`.
5. Keep the production hostnames in `firebase.json` under `auth.authorizedDomains`. The checked-in list allows `localhost`, `viewcast1.netlify.app`, `viewcast2.firebaseapp.com`, and `viewcast2.web.app`; add any other custom hostname before deploying it.
6. Open **Firestore Database**, create the default database, and choose a production location.
7. In **Firestore Database > Rules**, publish the contents of `firestore.rules`.

For local testing, use `http://localhost:4173` rather than `127.0.0.1`, or add `127.0.0.1` as an authorized domain. For GitHub Pages, add your `username.github.io` hostname.

The app supports:

- Email/password account creation
- Immediate dashboard access after account creation
- Verified-email access for dashboard features and Firestore profile data
- Persistent email/password sign-in
- Password reset emails
- Protected dashboard pages
- Firestore user profiles stored at `users/{uid}`
- User-aware welcome text
- Sign out from the sidebar account control

Each Firestore user profile stores the Firebase UID, email address, display name, account creation time, update time, and most recent sign-in time. The included rules restrict each profile to its authenticated owner.

## YouTube OAuth

ViewCast includes a YouTube connection flow that uses Google authorization with YouTube scopes:

- `js/youtube-connect.js` opens Google consent from the My Channel page.
- Firebase Auth requests YouTube Data API and YouTube Analytics API read scopes.
- The connected channel and first analytics summary are saved on `users/{uid}` in Firestore.
- `js/dashboard-data.js` reads the saved connection and fills real YouTube values into the Overview, My Channel, and analytics detail pages.
- AI Insights generates rule-based channel tips from the saved YouTube views, watch time, subscriber, and video-count data.
- The Video Analyzer uses the same OAuth scopes to load real video statistics from YouTube Data API and owner-only metrics from YouTube Analytics API.

Setup completed for this Firebase project:

- Firebase Auth Google sign-in is enabled.
- YouTube Data API v3 is enabled.
- YouTube Analytics API is enabled.

The dashboard requests these scopes: `youtube.readonly`, `yt-analytics.readonly`, and `yt-analytics-monetary.readonly`. Use the **My Channel** page to connect or unlink a YouTube channel. Estimated revenue is shown when the connected channel has monetization data available.

YouTube is linked with Google's authorization-code flow. The renewable credential is stored only in a server-restricted Firestore document and is exchanged by authenticated Firebase Functions for short-lived access tokens used across Overview, My Channel, Analyzer, and Insights. Users authorize Google once when linking a channel; reopening the site and moving between tools renews access without another Google prompt. Unlinking, signing out, or deleting the account revokes the Google credential and removes the server-side copy. Creator analytics and AI results remain session-only; only small, non-sensitive usage counters and dashboard summaries persist between browser sessions.

## App Check and AI quotas

The callable Gemini backend has both a short-window instance limit and durable per-user/project daily limits. Firebase App Check can be enforced with a score-based reCAPTCHA Enterprise key restricted to `localhost`, `viewcast1.netlify.app`, `viewcast2.web.app`, and `viewcast2.firebaseapp.com`.

When adding a custom production domain:

1. Add the hostname to the ViewCast reCAPTCHA Enterprise website key.
2. Add the hostname to Firebase Authentication authorized domains.
3. Add the hostname to `firebaseAuthorizedDomains` in `js/firebase-config.js` and `auth.authorizedDomains` in `firebase.json`.
4. Deploy the client and confirm legitimate AI requests succeed.

Never put a reCAPTCHA secret, Gemini API key, or YouTube access token in client configuration. The reCAPTCHA website key is designed to be public; its hostname restrictions provide the important boundary.

## Customize

- Add dashboard views in `pages/`.
- Keep shared behavior in `js/`.
- Adjust colors and layout in `css/style.css`.
- Update shared navigation in `components/sidebar.js`.
- Replace blank metric, chart, and table states only after real YouTube or Firebase data is connected.

### Bugs
- make the ai insights channel use ai
- change the color of the chatbox to follow the theme
- add memory in advice chat and make it so that before you analyze anything it asks questions
- make it automatically generate insights
