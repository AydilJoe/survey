# Duitful — Android notification plugin (capture + quick-add queue)

Two features sharing one package and one Capacitor plugin:

1. **Auto-capture** — reads bank / e-wallet notifications and sends them to the web layer for user review.
2. **Quick add** — logs a spend *without opening the app*, from the home-screen widget or by typing an amount straight into a notification.

## Files

- `NotificationListenerPlugin.java` — Capacitor plugin (`NotificationListener`). Exposes `isEnabled()`, `openSettings()`, `drainQuickAdd()`, `enableQuickAddNotification()`, `disableQuickAddNotification()`, `isQuickAddNotificationEnabled()`.
- `DuitfulNotificationListenerService.java` — the Android service that listens to notifications.
- `DuitfulQuickAddStore.java` — the quick-add queue: a capped, locked, plaintext outbox in SharedPreferences. **Read the class comment before touching it** — it explains what is deliberately *not* stored there and why.
- `DuitfulQuickAddReceiver.java` — the `com.aydiljoe.duitful.QUICK_ADD` broadcast contract, plus the notification's reply and undo actions.
- `DuitfulQuickAddNotifier.java` — builds the "Log a spend" notification (with its `RemoteInput` field) and the "RM 12.50 saved" confirmation.
- `DuitfulQuickAddBootReceiver.java` — re-posts the notification after a reboot or an app update.

## Install

`npm run cap:sync` runs `scripts/install-notification-listener.mjs` automatically — it copies the `.java` files into `android/app/src/main/java/com/aydiljoe/duitful/plugins/`, registers the plugin in `MainActivity.java`, writes the quick-add notification icon, and inserts the `<service>`, `<receiver>` and `<uses-permission>` entries in `AndroidManifest.xml`. Idempotent and cross-platform; the script no-ops if `android/` doesn't exist (e.g. iOS-only checkout).

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
- Copies all six `.java` files listed above
- Adds `import com.aydiljoe.duitful.plugins.NotificationListenerPlugin;` and the `registerPlugin(NotificationListenerPlugin.class);` call to `MainActivity.java`
- Adds the `<service android:name="…DuitfulNotificationListenerService" …>` block inside `<application>` in `AndroidManifest.xml`
- Writes `res/drawable/duitful_quickadd_ic.xml` (the notification's small icon)
- Adds `POST_NOTIFICATIONS` + `RECEIVE_BOOT_COMPLETED` permissions and the two quick-add `<receiver>` blocks

## Quick add

### Why a queue at all

The vault is AES-GCM encrypted under a key derived from the user's passcode, and that key only exists in the app process's memory while the app is open. A widget runs in the *launcher's* process; a broadcast receiver may run with no unlocked session at all. Neither can write a transaction. So native writes a tiny plain record — amount, optional category, timestamp — into `SharedPreferences("duitful_quickadd")["queue"]`, capped at 50, and the web layer drains it and commits it into the vault on next open. Nothing else is ever mirrored outside the vault.

### The broadcast contract

Fixed. The home-screen widget (`scripts/patch-android-widget.mjs`) sends exactly this:

```
action  com.aydiljoe.duitful.QUICK_ADD          (receiver is NOT exported — in-app senders only)
extra   amount    double, required, must be > 0
extra   category  String, optional
```

Each accepted broadcast posts a brief *"RM 12.50 saved · filed when you next open Duitful"* confirmation with an **Undo** action that deletes that one entry by its timestamp.

### The notification you can type into

Android widgets cannot contain a text field — `RemoteViews` has no `EditText`. Notifications can, via `RemoteInput`, which is the same mechanism as replying to a chat app from the shade. So the persistent quick-add notification (ongoing, silent, low-priority, titled **Log a spend**) carries two actions: **Add**, which opens an inline "Amount" field, and **Scan receipt**, which opens `duitful://action/scan`.

The typed amount is parsed leniently — `12`, `12.50`, `RM12.50`, `rm 12,50`, ` 12.5 `, `1,234.50` all work. Anything that is not a positive amount (`abc`, `-5`, `0`, `1e9`) re-posts the notification with the reason instead of being dropped silently. Valid amounts go through the same queue as the widget.

### Wire it from JS

```js
const NL = window.Capacitor?.Plugins?.NotificationListener;

// On app start / resume — commit anything logged while the app was closed.
const { items } = await NL.drainQuickAdd();      // [{ a: 12.5, c: "Food", t: 1754123456789 }, …]

// Settings toggle.
const { enabled, permitted, pending } = await NL.isQuickAddNotificationEnabled();
await NL.enableQuickAddNotification();           // needs POST_NOTIFICATIONS on API 33+
await NL.disableQuickAddNotification();
```

`drainQuickAdd()` empties the queue in the same lock it read it under, so entries are handed over exactly once — **whatever is returned must be committed or it is gone.** `permitted` is false when Android will not show the notification (permission denied or channel blocked); `enabled` is only what the user asked for.

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
