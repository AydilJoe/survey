package com.aydiljoe.duitful.plugins;

import android.content.Intent;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Capacitor bridge to DuitfulNotificationListenerService and to the quick-add
 * queue.
 *
 * Notification capture:
 *   - NotificationListener.isEnabled()    → { enabled: boolean }
 *   - NotificationListener.openSettings() → opens Android notification-access settings
 * Incoming notifications are pushed to JS as the "notification" event, which
 * in turn calls window.duitfulIncoming({ package, title, text }).
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

    /** Called by DuitfulNotificationListenerService. */
    public static void emit(String pkg, String title, String text) {
        if (instance == null) return;
        JSObject payload = new JSObject();
        try {
            payload.put("package", pkg == null ? "" : pkg);
            payload.put("title", title == null ? "" : title);
            payload.put("text", text == null ? "" : text);
        } catch (Exception e) {
            return;
        }
        instance.notifyListeners("notification", payload);
    }
}
