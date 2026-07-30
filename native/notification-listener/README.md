# Duitful — Android NotificationListenerService plugin

Auto-captures bank / e-wallet notifications on Android and sends them to the web layer for user review.

## Files

- `NotificationListenerPlugin.java` — Capacitor plugin (`NotificationListener`) exposing `isEnabled()` and `openSettings()` to JS.
- `DuitfulNotificationListenerService.java` — the actual Android service that listens to notifications.

## Install

`npm run cap:sync` runs `scripts/install-notification-listener.mjs` automatically — it copies the two `.java` files into `android/app/src/main/java/com/aydiljoe/duitful/plugins/`, registers the plugin in `MainActivity.java`, and inserts the `<service>` block in `AndroidManifest.xml`. Idempotent and cross-platform; the script no-ops if `android/` doesn't exist (e.g. iOS-only checkout).

If you ever need to (re)run just the installer without a full sync:

```
npm run native:notification-listener
```

Then:

```
npm run cap:android      # opens Android Studio for the build
```

### What the script touches

- Creates `android/app/src/main/java/com/aydiljoe/duitful/plugins/`
- Copies `NotificationListenerPlugin.java` + `DuitfulNotificationListenerService.java`
- Adds `import com.aydiljoe.duitful.plugins.NotificationListenerPlugin;` and the `registerPlugin(NotificationListenerPlugin.class);` call to `MainActivity.java`
- Adds the `<service android:name="…DuitfulNotificationListenerService" …>` block inside `<application>` in `AndroidManifest.xml`

### Manual fallback

If the script can't recognise the shape of your `MainActivity.java` (unusual edits, additional plugins) it falls back to a warning and tells you which line to add. The full manual recipe is preserved here for reference:

<details>
<summary>Manual install (deprecated, kept for emergencies)</summary>

1. **Create the package directory** in the generated Android project:
   ```
   android/app/src/main/java/com/aydiljoe/duitful/plugins/
   ```

2. **Copy both `.java` files** from this folder into that directory.

3. **Register the plugin** in `android/app/src/main/java/com/aydiljoe/duitful/MainActivity.java`:
   ```java
   import com.aydiljoe.duitful.plugins.NotificationListenerPlugin;

   public class MainActivity extends BridgeActivity {
     @Override
     public void onCreate(Bundle savedInstanceState) {
       registerPlugin(NotificationListenerPlugin.class);
       super.onCreate(savedInstanceState);
     }
   }
   ```

4. **Add the service + permission** to `android/app/src/main/AndroidManifest.xml` inside `<application>`:
   ```xml
   <service
     android:name="com.aydiljoe.duitful.plugins.DuitfulNotificationListenerService"
     android:label="Duitful Notification Listener"
     android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"
     android:exported="true">
     <intent-filter>
       <action android:name="android.service.notification.NotificationListenerService" />
     </intent-filter>
   </service>
   ```

5. **Sync and build**:
   ```
   npm run cap:sync
   npm run cap:android
   ```
</details>

## Wire from JS (already done in `script.js`)

The web app listens on `window.duitfulIncoming(...)`. When you build the native app, also register the plugin listener — add this near the existing `initIAP()` block:

```js
if (isNative() && window.Capacitor?.Plugins?.NotificationListener) {
  const NL = window.Capacitor.Plugins.NotificationListener;
  NL.addListener('notification', (data) => window.duitfulIncoming(data));
}
```

## User flow

1. User installs the app from Play Store.
2. Settings → Pending transactions → taps "Enable auto-capture".
3. App calls `NotificationListener.openSettings()` which opens Android's Notification-access screen.
4. User toggles **Duitful** on.
5. From now on, bank/e-wallet notifications are parsed on-device and queued as pending transactions. Nothing ever leaves the phone.

## Incoming transfers → split auto-match (v1.14)

`window.duitfulIncoming(...)` now tries two parsers, in order:

1. **Credit** (`parseIncomingTransfer` in `script.js`) — MYR only, and only
   when the text carries a credit verb (`received` / `credited` / `incoming` /
   `menerima` / `diterima` / `masuk`). If it parses, `splitMatchIncoming()`
   (`split.js`) compares the amount against every open request someone owes
   you: an exact hit, or one within RM 1, becomes a pending action reading
   *"RM 23.50 received — settle Ali's share of Dinner @ Naz?"*. Several
   equally good matches produce a *"who paid?"* row with one button per
   person. **Nothing is ever settled without that tap**, and a credit that
   matches nothing is dropped without a trace — your salary landing is not
   Duitful's business.
2. **Debit** (`parseBankText`) — the original card/wallet spend capture,
   unchanged.

Test it in the devtools console without a phone:

```js
duitfulIncoming({ package: "com.maybank2u.life", text: "You have received RM23.50 from ALI BIN ABU" })
```

## Privacy

Everything happens on-device. There is no server call. The notification text is parsed, displayed for user review, and discarded once accepted or dismissed.
