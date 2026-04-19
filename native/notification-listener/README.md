# Duitful — Android NotificationListenerService plugin

Auto-captures bank / e-wallet notifications on Android and sends them to the web layer for user review.

## Files

- `NotificationListenerPlugin.java` — Capacitor plugin (`NotificationListener`) exposing `isEnabled()` and `openSettings()` to JS.
- `DuitfulNotificationListenerService.java` — the actual Android service that listens to notifications.

## Install (after `npm run cap:add:android`)

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

## Privacy

Everything happens on-device. There is no server call. The notification text is parsed, displayed for user review, and discarded once accepted or dismissed.
