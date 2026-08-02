package com.aydiljoe.duitful.plugins;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Puts the "Log a spend" notification back after the phone reboots or the app
 * is updated. Notifications do not survive either event, and the whole point of
 * the quick-add notification is that it is simply always there — a user who has
 * to open the app to get back the thing that saves them opening the app has
 * been given nothing.
 *
 * It reads one boolean ({@link DuitfulQuickAddStore#KEY_NOTIFICATION_ENABLED})
 * and re-posts. No app data, no vault, no work of any kind if the user never
 * turned the feature on.
 *
 * Unlike DuitfulQuickAddReceiver this one must be android:exported="true":
 * BOOT_COMPLETED arrives from the system uid, and a non-exported receiver only
 * accepts broadcasts from its own app. The manifest additionally restricts
 * senders to holders of RECEIVE_BOOT_COMPLETED, and the worst a spoofed
 * broadcast could achieve is re-posting a notification the user already asked
 * for.
 *
 * ACTION_LOCKED_BOOT_COMPLETED is deliberately NOT handled: these preferences
 * live in credential-encrypted storage and are unreadable before first unlock,
 * so there would be nothing to read. ACTION_BOOT_COMPLETED, which fires after
 * unlock, is the right hook.
 */
public class DuitfulQuickAddBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            if (context == null || intent == null) return;
            String action = intent.getAction();
            if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                    && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
                return;
            }
            DuitfulQuickAddNotifier.refresh(context);
        } catch (Throwable ignored) {}
    }
}
