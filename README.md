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
5. Keep the production hostnames in `firebase.json` under `auth.authorizedDomains`. The checked-in list allows only `localhost`, `viewcast-a6f31.firebaseapp.com`, and `viewcast-a6f31.web.app`; add a custom hostname there before deploying it.
6. Open **Firestore Database**, create the default database, and choose a production location.
7. In **Firestore Database > Rules**, publish the contents of `firestore.rules`.

For local testing, use `http://localhost:4173` rather than `127.0.0.1`, or add `127.0.0.1` as an authorized domain. For GitHub Pages, add your `username.github.io` hostname.

The app supports:

- Email/password account creation
- Optional email verification from the Account page
- Closable verification popup when an unverified account attempts to use a feature
- Persistent email/password sign-in
- Password reset emails
- Protected dashboard pages
- Firestore user profiles stored at `users/{uid}`
- User-aware welcome text
- Sign out from the sidebar account control

Each Firestore user profile stores the Firebase UID, email address, display name, account creation time, update time, and most recent sign-in time. The included rules restrict each profile to its authenticated owner.

## YouTube OAuth

ViewCast includes a YouTube connection flow that uses Firebase Google sign-in with YouTube scopes:

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

YouTube access tokens are kept in session storage, cleared on sign-out, and sent to Google's revocation endpoint when a channel is unlinked or the user signs out. Creator analytics and AI results are also session-only; only small, non-sensitive usage counters and dashboard summaries persist between browser sessions.

## App Check and AI quotas

The callable Gemini backend has both a short-window instance limit and durable per-user/project daily limits. Firebase App Check support is wired in but intentionally fail-open until a reCAPTCHA Enterprise key is configured, so enabling it cannot accidentally lock every user out.

To enforce App Check in production:

1. Create a reCAPTCHA Enterprise website key restricted to the exact production hostnames.
2. Register the web app and that key in **Firebase Console > App Check**.
3. Put the public site key in `firebaseAppCheckSiteKey` in `js/firebase-config.js` and deploy the client.
4. Set `ENFORCE_APP_CHECK=true` in the Functions runtime environment and deploy the functions.
5. Confirm legitimate AI requests succeed, then monitor App Check metrics for rejected traffic.

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
