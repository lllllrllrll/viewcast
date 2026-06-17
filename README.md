# ViewCast Dashboard Template

A self-contained responsive video analytics dashboard template with KPI cards, canvas charts, traffic source progress, audience activity, a video performance table, and sidebar page previews for creator workflows.

## Open

Serve the project over HTTP and open `login.html`. Firebase Authentication does not support a complete production flow from a raw `file://` URL.

For a quick local preview:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/login.html`.

## Firebase Authentication

1. Create or open a project in the [Firebase console](https://console.firebase.google.com/).
2. Add a Web app from **Project settings > Your apps**.
3. In **Authentication > Sign-in method**, enable **Email/Password**.
4. Copy the Firebase web configuration into `service/firebase-config.js`.
5. In **Authentication > Settings > Authorized domains**, add the domain where ViewCast will be hosted.
6. Open **Firestore Database**, create the default database, and choose a production location.
7. In **Firestore Database > Rules**, publish the contents of `firestore.rules`.

For local testing, use `http://localhost:4173` rather than `127.0.0.1`, or add `127.0.0.1` as an authorized domain. For GitHub Pages, add your `username.github.io` hostname.

The app supports:

- Email/password account creation
- Persistent email/password sign-in
- Password reset emails
- Protected dashboard pages
- Firestore user profiles stored at `users/{uid}`
- User-aware welcome text
- Sign out from the sidebar account control

Each Firestore user profile stores the Firebase UID, email address, display name, account creation time, update time, and most recent sign-in time. The included rules restrict each profile to its authenticated owner.

## YouTube OAuth

ViewCast includes a YouTube connection scaffold that uses Google OAuth and Firebase Functions:

- `service/youtube-config.js` stores the public Google OAuth client ID and deployed Function URL.
- `service/youtube-connect.js` opens Google consent from the dashboard.
- `functions/index.js` exchanges the OAuth code, verifies the Firebase user, stores the YouTube connection in Firestore, and saves the connected channel title/URL on `users/{uid}`.

To finish setup:

1. In Google Cloud Console, enable **YouTube Data API v3** and **YouTube Analytics API** for the same project.
2. Configure the OAuth consent screen.
3. Create an OAuth client ID with application type **Web application**.
4. Add authorized JavaScript origins:

```text
http://localhost:4173
https://viewcast-a6f31.web.app
https://viewcast-a6f31.firebaseapp.com
```

5. Copy the OAuth client ID into `service/youtube-config.js`.
6. Copy `functions/.env.example` to `functions/.env` and replace the placeholder client ID.
7. Store the OAuth client secret as a Firebase Functions secret:

```bash
firebase functions:secrets:set YOUTUBE_CLIENT_SECRET
```

8. Install Functions dependencies if needed:

```bash
npm --prefix functions install
```

9. Deploy Functions:

```bash
firebase deploy --only functions
```

The dashboard requests these scopes: `youtube.readonly` and `yt-analytics.readonly`. The channel URL field is still useful as a manual fallback, but real dashboard metrics require this OAuth connection.

## Customize

- Update metric values in the KPI card markup.
- Edit chart data in the `<script>` block near the bottom of `index.html`.
- Adjust colors in the `:root` CSS variables.
- Replace video rows in the table body.
- Edit the `pageDetails` object to customize sidebar pages such as Trends, Video Analyzer, Success Predictor, My Channel, and AI Insights.
