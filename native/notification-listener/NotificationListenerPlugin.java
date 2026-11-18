package com.aydiljoe.duitful.plugins;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor bridge to DuitfulNotificationListenerService and to the quick-add
 * queue.
 *
 * Notification capture:
 *   - NotificationListener.isEnabled()    → { enabled: boolean }
 *   - NotificationListener.openSettings() → opens Android notification-access settings
 *   - NotificationListener.drainCaptured() → { items: [{ p, ti, tx, t }, …] }
 * Captured notifications are stored first (DuitfulCaptureStore, encrypted) so
 * one that arrives while the app is closed is not lost. The "notification"
 * event { package, title, text, queued: true } is a nudge: JS drains the store
 * and hands each item to window.duitfulIncoming().
 *
 * Quick-add queue (see DuitfulQuickAddStore for why it exists — nothing outside
 * the app can write to the AES-GCM vault, so native leaves entries in a plain
 * capped outbox and the web layer commits them on next open):
 *   - NotificationListener.drainQuickAdd()                → { items: [{ a, c, t }, …] }
 *   - NotificationListener.enableQuickAddNotification()   → { enabled, permitted }
 *   - NotificationListener.disableQuickAddNotification()  → { enabled, permitted }
 *   - NotificationListener.isQuickAddNotificationEnabled()→ { enabled, permitted }
 */
@CapacitorPlugin(name = "NotificationListener")
public class NotificationListenerPlugin extends Plugin {
    private static NotificationListenerPlugin instance;

    @Override
    public void load() {
        instance = this;
        // Self-heal the quick-add notification: from API 34 the user can swipe
        // an ongoing notification away, and a force-stop clears it outright.
        // Opening the app is the natural moment to put it back.
        try {
            DuitfulQuickAddNotifier.refresh(getContext());
        } catch (Throwable ignored) {}
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        boolean enabled = NotificationManagerCompat
            .getEnabledListenerPackages(getContext())
            .contains(getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /**
     * Hands over every bank notification stored since the last drain and
     * empties the store, so each is returned exactly once.
     */
    @PluginMethod
    public void drainCaptured(PluginCall call) {
        JSONArray items = DuitfulCaptureStore.drain(getContext());
        JSObject result = new JSObject();
        try {
            result.put("items", items);
        } catch (Exception e) {
            call.reject("Could not read captured notifications.", e);
            return;
        }
        call.resolve(result);
    }

    // --- Quick-add queue --------------------------------------------------

    /**
     * Hands over every entry queued by the widget / the quick-add notification
     * and empties the queue in the same lock, so an entry is returned exactly
     * once. Always resolves with an array — an empty one when there is nothing
     * pending or when the stored JSON was unreadable.
     *
     * The JS side owns what happens next: these are plain numbers, not
     * transactions, and only the app can write them into the encrypted vault.
     */
    @PluginMethod
    public void drainQuickAdd(PluginCall call) {
        JSONArray items = DuitfulQuickAddStore.drain(getContext());
        JSObject result = new JSObject();
        try {
            result.put("items", items);
        } catch (Exception e) {
            // The queue is already cleared at this point, so failing here would
            // lose entries silently; reject loudly instead.
            call.reject("Could not read the quick-add queue.", e);
            return;
        }
        call.resolve(result);
    }

    @PluginMethod
    public void enableQuickAddNotification(PluginCall call) {
        DuitfulQuickAddNotifier.enable(getContext());
        call.resolve(quickAddState());
    }

    @PluginMethod
    public void disableQuickAddNotification(PluginCall call) {
        DuitfulQuickAddNotifier.disable(getContext());
        call.resolve(quickAddState());
    }

    @PluginMethod
    public void isQuickAddNotificationEnabled(PluginCall call) {
        call.resolve(quickAddState());
    }

    /**
     * `enabled` is what the user asked for; `permitted` is whether Android will
     * actually show it (POST_NOTIFICATIONS is a runtime permission from API 33,
     * and the channel can be blocked at any time). The two disagreeing is the
     * case the settings UI has to explain, so report both rather than one
     * flattened boolean.
     */
    private JSObject quickAddState() {
        JSObject result = new JSObject();
        boolean permitted;
        try {
            permitted = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        } catch (Throwable ignored) {
            permitted = false;
        }
        result.put("enabled", DuitfulQuickAddNotifier.isEnabled(getContext()));
        result.put("permitted", permitted);
        try {
            // Nice-to-have for the settings row ("3 waiting"). Guarded because
            // JSObject's numeric overloads are the ones whose "does it throw"
            // signature has moved between Capacitor versions; the booleans
            // above are proven by isEnabled() right up there.
            result.put("pending", DuitfulQuickAddStore.size(getContext()));
        } catch (Exception ignored) {}
        return result;
    }

    /**
     * Settings → Bank alerts → "Check auto-capture": plain facts, no content.
     * { accessGranted, batteryUnrestricted, connectedAt, disconnectedAt,
     *   stored, log: [{ p, t, r }], manufacturer, model, sdk }
     */
    @PluginMethod
    public void captureStatus(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            boolean granted = NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName());
            ret.put("accessGranted", granted);
            boolean unrestricted = true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                unrestricted = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            }
            ret.put("batteryUnrestricted", unrestricted);
            JSONObject diag = DuitfulCaptureDiag.read(getContext());
            ret.put("connectedAt", diag.optLong("connectedAt", 0L));
            ret.put("disconnectedAt", diag.optLong("disconnectedAt", 0L));
            ret.put("log", diag.optJSONArray("log") == null ? new JSONArray() : diag.optJSONArray("log"));
            ret.put("stored", DuitfulCaptureStore.size(getContext()));
            ret.put("manufacturer", Build.MANUFACTURER);
            ret.put("model", Build.MODEL);
            ret.put("sdk", Build.VERSION.SDK_INT);
        } catch (Exception e) {
            call.reject("Could not read the capture status.", e);
            return;
        }
        call.resolve(ret);
    }

    /** The app's pending-review count, for the persistent notification ("2 to review"). */
    @PluginMethod
    public void setPendingCount(PluginCall call) {
        Integer n = call.getInt("count", 0);
        DuitfulQuickAddNotifier.setPendingCount(getContext(), n == null ? 0 : n);
        call.resolve();
    }

    /**
     * The words the quick-add notification shows, in the language picked in
     * Duitful: {strings: {title, hint, add, ...}}. Missing keys stay English.
     */
    @PluginMethod
    public void setStrings(PluginCall call) {
        JSObject strings = call.getObject("strings");
        DuitfulQuickAddNotifier.setStrings(getContext(), strings == null ? "{}" : strings.toString());
        call.resolve();
    }

    /** Called by DuitfulNotificationListenerService. */
    public static void emit(String pkg, String title, String text) {
        emit(pkg, title, text, true);
    }

    /** queued: true when the notification is in the store (JS drains it); false = handle the text directly. */
    public static void emit(String pkg, String title, String text, boolean queued) {
        if (instance == null) return;
        JSObject payload = new JSObject();
        try {
            payload.put("package", pkg == null ? "" : pkg);
            payload.put("title", title == null ? "" : title);
            payload.put("text", text == null ? "" : text);
            payload.put("queued", queued);
        } catch (Exception e) {
            return;
        }
        instance.notifyListeners("notification", payload);
    }
}
