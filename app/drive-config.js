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
 */
window.DRIVE_CONFIG = {
  webClientId: "",
  scopes: [
    "https://www.googleapis.com/auth/drive.appdata",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),
  fileName: "duitful-backup.enc",
};
