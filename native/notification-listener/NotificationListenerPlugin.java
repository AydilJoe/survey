package com.aydiljoe.duitful.plugins;

import android.content.Intent;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

/**
 * Capacitor bridge to DuitfulNotificationListenerService.
 * Exposes:
 *   - NotificationListener.isEnabled()    → { enabled: boolean }
 *   - NotificationListener.openSettings() → opens Android notification-access settings
 * Incoming notifications are pushed to JS as the "notification" event, which
 * in turn calls window.duitfulIncoming({ package, title, text }).
 */
@CapacitorPlugin(name = "NotificationListener")
public class NotificationListenerPlugin extends Plugin {
    private static NotificationListenerPlugin instance;

    @Override
    public void load() { instance = this; }

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
