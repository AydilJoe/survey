package com.aydiljoe.duitful.plugins;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.core.app.RemoteInput;

/**
 * The one entry point for logging a spend without opening Duitful.
 *
 * THE CONTRACT — other components (the home-screen widget, the quick-add
 * notification) depend on this exact shape; do not change it without changing
 * them:
 *
 *   action  com.aydiljoe.duitful.QUICK_ADD
 *   extra   amount    double, required, must be &gt; 0
 *   extra   category  String, optional
 *
 * The entry is appended to {@link DuitfulQuickAddStore} — a plain, capped,
 * short-lived outbox in the app's private SharedPreferences — because nothing
 * outside the app can write to the vault: it is AES-GCM encrypted under a key
 * derived from the passcode that only exists in the app process's memory while
 * the app is open. The web layer drains the queue and commits it on next open.
 *
 * Two more actions are handled here, both internal and both fired only by
 * PendingIntents this app built:
 *
 *   com.aydiljoe.duitful.QUICK_ADD_REPLY  RemoteInput text from the shade
 *   com.aydiljoe.duitful.QUICK_ADD_UNDO   extras t (long), n (int) — drop one entry
 *
 * The receiver is declared android:exported="false" (see
 * scripts/install-notification-listener.mjs): a queue that any installed app
 * could push fabricated spends into would be worse than no queue. Same-app
 * senders — which is all of them — are unaffected.
 *
 * NOTHING here is allowed to throw. onReceive() runs on the main thread of a
 * process that a launcher tap just started; an exception surfaces to the user
 * as "Duitful has stopped" over their home screen, so every path is wrapped.
 */
public class DuitfulQuickAddReceiver extends BroadcastReceiver {

    /** Public contract. */
    public static final String ACTION_QUICK_ADD = "com.aydiljoe.duitful.QUICK_ADD";
    public static final String EXTRA_AMOUNT = "amount";
    public static final String EXTRA_CATEGORY = "category";

    /** Internal. */
    public static final String ACTION_REPLY = "com.aydiljoe.duitful.QUICK_ADD_REPLY";
    public static final String ACTION_UNDO = "com.aydiljoe.duitful.QUICK_ADD_UNDO";
    public static final String EXTRA_TIMESTAMP = "t";
    public static final String EXTRA_NOTIFICATION_ID = "n";
    public static final String REMOTE_INPUT_KEY = "duitful_quickadd_amount";

    /** Shown on the persistent notification when a reply did not parse. */
    private static final String ERROR_PREFIX = "That did not look like an amount: ";
    private static final String ERROR_HINT = ". Try 12.50";
    private static final int ERROR_ECHO_CHARS = 24;

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            handle(context, intent);
        } catch (Throwable ignored) {
            // See the class note: never crash out of a launcher-initiated tap.
        }
    }

    private void handle(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        if (ACTION_QUICK_ADD.equals(action)) {
            double amount = readAmount(intent);
            if (!(amount > 0)) return; // malformed broadcast — ignore, never crash
            save(context, amount, readCategory(intent));
            return;
        }

        if (ACTION_REPLY.equals(action)) {
            String typed = readReply(intent);
            double amount = DuitfulQuickAddStore.parseAmount(typed);
            if (Double.isNaN(amount)) {
                // Re-post with the reason rather than swallowing the input.
                DuitfulQuickAddNotifier.post(context, errorLabel(typed));
                return;
            }
            save(context, amount, readCategory(intent));
            return;
        }

        if (ACTION_UNDO.equals(action)) {
            long timestamp = intent.getLongExtra(EXTRA_TIMESTAMP, 0L);
            int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0);
            DuitfulQuickAddStore.remove(context, timestamp);
            DuitfulQuickAddNotifier.cancelConfirmation(context, notificationId, timestamp);
            DuitfulQuickAddNotifier.refresh(context);
        }
    }

    /** Queue it, confirm it, and clear the reply action's "sending…" spinner. */
    private static void save(Context context, double amount, String category) {
        long stamp = DuitfulQuickAddStore.append(context, amount, category, System.currentTimeMillis());
        if (stamp > 0) {
            DuitfulQuickAddNotifier.postConfirmation(context, amount, category, stamp);
        }
        // Re-post the persistent notification whether or not the append landed:
        // after a RemoteInput reply it is stuck showing a spinner until it is.
        DuitfulQuickAddNotifier.refresh(context);
    }

    // --- Extras, read defensively -----------------------------------------

    /**
     * The contract says double, but a sender that puts an int, a long, a float
     * or even a String is obviously trying to log the same spend — accept it
     * rather than dropping a real transaction on a type technicality.
     */
    private static double readAmount(Intent intent) {
        Object raw;
        try {
            Bundle extras = intent.getExtras();
            raw = extras == null ? null : extras.get(EXTRA_AMOUNT);
        } catch (Throwable ignored) {
            // A Bundle carrying a class this process cannot unmarshal.
            return Double.NaN;
        }
        if (raw == null) return Double.NaN;
        if (raw instanceof Number) {
            // Straight through the numeric normaliser, NOT via toString(): a
            // double of 12.340000000000002 is a perfectly good RM 12.34, and
            // the text parser would (rightly) refuse that many decimals.
            double value = DuitfulQuickAddStore.normaliseAmount(((Number) raw).doubleValue());
            return value > 0 ? value : Double.NaN;
        }
        if (raw instanceof CharSequence) {
            return DuitfulQuickAddStore.parseAmount(raw.toString());
        }
        return Double.NaN;
    }

    private static String readCategory(Intent intent) {
        try {
            Bundle extras = intent.getExtras();
            Object raw = extras == null ? null : extras.get(EXTRA_CATEGORY);
            return raw instanceof CharSequence ? raw.toString() : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String readReply(Intent intent) {
        try {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            if (results == null) return null;
            CharSequence typed = results.getCharSequence(REMOTE_INPUT_KEY);
            return typed == null ? null : typed.toString();
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String errorLabel(String typed) {
        String echo = typed == null ? "" : typed.trim();
        if (echo.length() == 0) return "Type an amount, like 12.50";
        if (echo.length() > ERROR_ECHO_CHARS) echo = echo.substring(0, ERROR_ECHO_CHARS) + "…";
        // cleanCategory() doubles as the control-character stripper: whatever
        // the IME produced is about to be echoed back into a notification.
        return ERROR_PREFIX + "\"" + DuitfulQuickAddStore.cleanCategory(echo) + "\"" + ERROR_HINT;
    }
}
