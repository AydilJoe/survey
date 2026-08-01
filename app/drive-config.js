/* Duitful — Google Drive backup config.
 *
 * To enable Google Drive sync on the web:
 *   1. Create a Google Cloud project, enable the Google Drive API.
 *   2. Configure the OAuth consent screen (External, Testing or Production).
 *      Add scopes: drive.appdata, userinfo.email.
 *   3. Create an OAuth 2.0 Client ID of type "Web application".
 *      Authorized JavaScript origins:
 *        - https://duitful.app
 *        - https://aydiljoe.github.io
 *        - http://localhost:8000
 *   4. Paste the client ID below.
 *
 * Client IDs are public — safe to commit. The OAuth client secret is NOT used
 * (we use the implicit-flow / token-client pattern from Google Identity Services).
 *
 * iOS (native) uses its own client, because Google's iOS sign-in SDK refuses a
 * web client ID:
 *   1. Same Google Cloud project as the web client above (that's why both start
 *      with the project number 184121637925 — the expected shape).
 *   2. APIs & Services → Credentials → Create credentials → OAuth client ID.
 *   3. Application type: "iOS". Bundle ID: com.aydiljoe.duitful
 *      (must match `appId` in capacitor.config.json).
 *   4. Paste the client ID into `iosClientId` below.
 *
 * scripts/patch-ios.mjs derives the reversed-client-ID URL scheme from this
 * value and writes it into the generated ios/ project's Info.plist, which is
 * what Google's SDK needs to receive the sign-in callback. Change the id here
 * and the URL scheme follows on the next `npm run patch:ios`.
 *
 * Leaving `iosClientId` empty is supported (forks without their own Google
 * project): the iOS build then reports cloud backup as not configured instead
 * of failing at sign-in, and patch-ios.mjs skips the URL scheme.
 *
 * Android needs no id of its own here — it signs in with `webClientId` through
 * the device's Google account.
 */
window.DRIVE_CONFIG = {
  webClientId: "184121637925-il087n9kdirov78ko4jqiuo8t51vphe4.apps.googleusercontent.com",
  iosClientId: "184121637925-7aiidqonv3s7bhpppabi1hssjss8vvn3.apps.googleusercontent.com",
  scopes: [
    "https://www.googleapis.com/auth/drive.appdata",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),
  fileName: "duitful-backup.enc",
};
