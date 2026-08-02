package com.aydiljoe.duitful.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;

import java.util.Locale;

/**
 * Builds and posts the two quick-add notifications.
 *
 * 1. THE PERSISTENT ONE — an ongoing, silent, low-priority notification titled
 *    "Log a spend" with two actions: **Add**, which carries a
 *    {@link RemoteInput} so the amount is typed straight into the shade (the
 *    same mechanism as replying to a chat app), and **Scan receipt**, which
 *    opens duitful://action/scan. A home-screen widget cannot do this —
 *    RemoteViews has no EditText — so the notification is the only surface on
 *    Android where a number can be entered without opening the app.
 *
 * 2. THE CONFIRMATION — a short-lived "RM 12.50 saved · filed when you next
 *    open Duitful" with an Undo action that deletes that one queued entry by
 *    its timestamp.
 *
 * Neither notification ever reads app data. The amount shown in the
 * confirmation is the one the user just typed, echoed back; nothing is
 * decrypted, and the confirmation is VISIBILITY_PRIVATE so the figure does not
 * sit on the lock screen.
 *
 * Everything here is best-effort: on API 33+ a user who never granted
 * POST_NOTIFICATIONS makes notify() a silent no-op (and on some OEM builds a
 * SecurityException), which must not take a BroadcastReceiver down.
 */
public final class DuitfulQuickAddNotifier {

    /** The persistent "Log a spend" notification. */
    public static final int NOTIFICATION_ID = 47110;
    /**
     * Confirmations get their own ids so one does not replace another while the
     * user is still deciding whether to undo. 100 slots keyed off the entry's
     * timestamp: a collision needs 100 quick-adds inside one Undo window, and
     * costs at worst a replaced confirmation, never a wrong Undo (the queued
     * entry is addressed by its full timestamp, which travels in the intent).
     */
    private static final int CONFIRM_ID_BASE = 47200;
    private static final int CONFIRM_ID_SLOTS = 100;

    /** Distinct PendingIntent request codes; sharing one would collapse them. */
    private static final int RC_REPLY = 1;
    private static final int RC_SCAN = 2;
    private static final int RC_OPEN = 3;
    private static final int RC_UNDO_BASE = 100;

    static final String CHANNEL_QUICK_ADD = "duitful_quickadd";
    static final String CHANNEL_CONFIRM = "duitful_quickadd_ack";

    /** Matches quickActionFromUrl() in app/script.js. Do not fork this shape. */
    private static final String ACTION_URL_PREFIX = "duitful://action/";

    private static final String TITLE = "Log a spend";
    private static final String HINT = "Tap Add and type an amount.";
    private static final String FILED = "Filed when you next open Duitful";

    private DuitfulQuickAddNotifier() {}

    // --- Enabled flag -----------------------------------------------------

    public static boolean isEnabled(Context context) {
        if (context == null) return false;
        try {
            return DuitfulQuickAddStore.prefs(context)
                    .getBoolean(DuitfulQuickAddStore.KEY_NOTIFICATION_ENABLED, false);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static void setEnabled(Context context, boolean enabled) {
        try {
            DuitfulQuickAddStore.prefs(context)
                    .edit()
                    .putBoolean(DuitfulQuickAddStore.KEY_NOTIFICATION_ENABLED, enabled)
                    .commit();
        } catch (Throwable ignored) {}
    }

    public static void enable(Context context) {
        if (context == null) return;
        setEnabled(context, true);
        post(context, null);
    }

    public static void disable(Context context) {
        if (context == null) return;
        setEnabled(context, false);
        try {
            NotificationManagerCompat.from(context.getApplicationContext()).cancel(NOTIFICATION_ID);
        } catch (Throwable ignored) {}
    }

    /**
     * Re-posts the notification if the user wants it. Called on plugin load, on
     * boot, after a package replace, and after every reply — the last one
     * matters because replying leaves the action stuck in its "sending…"
     * spinner until the notification is re-posted, and because from API 34 the
     * user can swipe an ongoing notification away.
     */
    public static void refresh(Context context) {
        if (isEnabled(context)) post(context, null);
    }

    // --- The persistent notification --------------------------------------

    /**
     * @param error when non-null, shown in place of the hint — this is how a
     *              reply that did not parse comes back to the user instead of
     *              being silently dropped.
     */
    public static void post(Context context, String error) {
        if (context == null) return;
        Context app = context.getApplicationContext();
        try {
            ensureChannels(app);
            int icon = smallIcon(app);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(app, CHANNEL_QUICK_ADD)
                    .setSmallIcon(icon)
                    .setContentTitle(TITLE)
                    .setContentText(error != null ? error : HINT)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(error != null ? error : HINT))
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    // Carries no figures, so it is safe on a lock screen — that
                    // is the whole point of being able to log without unlocking.
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setOngoing(true)
                    .setSilent(true)
                    .setOnlyAlertOnce(true)
                    .setShowWhen(false)
                    .setLocalOnly(true)
                    .setContentIntent(openApp(app))
                    .addAction(addAction(app, icon))
                    .addAction(scanAction(app, icon));
            notify(app, NOTIFICATION_ID, builder);
        } catch (Throwable ignored) {}
    }

    private static NotificationCompat.Action addAction(Context app, int icon) {
        RemoteInput input = new RemoteInput.Builder(DuitfulQuickAddReceiver.REMOTE_INPUT_KEY)
                // RemoteInput has no inputType/keyboard hint on any API level —
                // the label is the only steer the IME gets, hence the very
                // forgiving parser in DuitfulQuickAddStore.parseAmount().
                .setLabel("Amount")
                .setAllowFreeFormInput(true)
                .build();
        Intent intent = new Intent(DuitfulQuickAddReceiver.ACTION_REPLY);
        // Explicit: no other app is ever offered this, and the O+ implicit
        // broadcast restrictions do not apply.
        intent.setClass(app, DuitfulQuickAddReceiver.class);
        PendingIntent pending = PendingIntent.getBroadcast(
                app, RC_REPLY, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutableFlag());
        return new NotificationCompat.Action.Builder(icon, "Add", pending)
                .addRemoteInput(input)
                .setAllowGeneratedReplies(false)
                // No activity is launched, so the shade must not dismiss itself
                // or ask an untrusted launcher to unlock the device first.
                .setShowsUserInterface(false)
                .build();
    }

    private static NotificationCompat.Action scanAction(Context app, int icon) {
        PendingIntent pending = PendingIntent.getActivity(
                app, RC_SCAN, actionIntent(app, "scan"), PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag());
        return new NotificationCompat.Action.Builder(icon, "Scan receipt", pending).build();
    }

    // --- The confirmation -------------------------------------------------

    /** "RM 12.50 saved · filed when you next open Duitful", plus Undo. */
    public static void postConfirmation(Context context, double amount, String category, long timestamp) {
        if (context == null || timestamp <= 0) return;
        Context app = context.getApplicationContext();
        try {
            ensureChannels(app);
            int icon = smallIcon(app);
            int id = confirmationId(timestamp);
            String money = formatAmount(amount);
            String clean = DuitfulQuickAddStore.cleanCategory(category);
            String detail = clean.length() > 0 ? clean + " · " + FILED : FILED;

            Intent undo = new Intent(DuitfulQuickAddReceiver.ACTION_UNDO);
            undo.setClass(app, DuitfulQuickAddReceiver.class);
            undo.putExtra(DuitfulQuickAddReceiver.EXTRA_TIMESTAMP, timestamp);
            undo.putExtra(DuitfulQuickAddReceiver.EXTRA_NOTIFICATION_ID, id);
            PendingIntent undoPending = PendingIntent.getBroadcast(
                    app,
                    RC_UNDO_BASE + (id - CONFIRM_ID_BASE),
                    undo,
                    PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag());

            NotificationCompat.Builder builder = new NotificationCompat.Builder(app, CHANNEL_CONFIRM)
                    .setSmallIcon(icon)
                    .setContentTitle(money + " saved")
                    .setContentText(detail)
                    .setTicker(money + " saved · " + FILED.toLowerCase(Locale.US))
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    // A figure — keep it off the lock screen.
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setSilent(true)
                    .setAutoCancel(true)
                    .setLocalOnly(true)
                    .setShowWhen(true)
                    .setWhen(timestamp)
                    // Long enough to change your mind, short enough not to
                    // become clutter. No-op below API 26.
                    .setTimeoutAfter(60000L)
                    .setContentIntent(openApp(app))
                    .addAction(new NotificationCompat.Action.Builder(icon, "Undo", undoPending).build());
            notify(app, id, builder);
        } catch (Throwable ignored) {}
    }

    /** Drops the confirmation for one queued entry (after its Undo is tapped). */
    public static void cancelConfirmation(Context context, int notificationId, long timestamp) {
        if (context == null) return;
        int id = notificationId > 0 ? notificationId : confirmationId(timestamp);
        try {
            NotificationManagerCompat.from(context.getApplicationContext()).cancel(id);
        } catch (Throwable ignored) {}
    }

    static int confirmationId(long timestamp) {
        long slot = timestamp % CONFIRM_ID_SLOTS;
        if (slot < 0) slot = -slot;
        return CONFIRM_ID_BASE + (int) slot;
    }

    /** "RM 12.50" — Locale.US so a ms-MY device does not render "RM 12,50". */
    static String formatAmount(double amount) {
        return String.format(Locale.US, "RM %.2f", amount);
    }

    // --- Plumbing ---------------------------------------------------------

    private static void notify(Context app, int id, NotificationCompat.Builder builder) {
        try {
            NotificationManagerCompat.from(app).notify(id, builder.build());
        } catch (Throwable ignored) {
            // Missing POST_NOTIFICATIONS (API 33+) or a locked-down OEM build.
            // Nothing to recover: the entry is already queued either way.
        }
    }

    private static void ensureChannels(Context app) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager manager =
                    (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            NotificationChannel quickAdd = new NotificationChannel(
                    CHANNEL_QUICK_ADD, "Quick add", NotificationManager.IMPORTANCE_LOW);
            quickAdd.setDescription("The always-there \"Log a spend\" notification you can type an amount into.");
            quickAdd.setShowBadge(false);
            quickAdd.enableVibration(false);
            quickAdd.setSound(null, null);
            manager.createNotificationChannel(quickAdd);

            NotificationChannel confirm = new NotificationChannel(
                    CHANNEL_CONFIRM, "Quick add confirmations", NotificationManager.IMPORTANCE_LOW);
            confirm.setDescription("Brief \"saved\" receipts with an Undo, after a quick add.");
            confirm.setShowBadge(false);
            confirm.enableVibration(false);
            confirm.setSound(null, null);
            manager.createNotificationChannel(confirm);
        } catch (Throwable ignored) {}
    }

    /**
     * Our own white-on-transparent glyph if the patch script installed it,
     * otherwise the launcher icon. Never 0 — a notification with no small icon
     * throws on post.
     */
    private static int smallIcon(Context app) {
        try {
            int id = app.getResources()
                    .getIdentifier("duitful_quickadd_ic", "drawable", app.getPackageName());
            if (id != 0) return id;
        } catch (Throwable ignored) {}
        try {
            int id = app.getApplicationInfo().icon;
            if (id != 0) return id;
        } catch (Throwable ignored) {}
        return android.R.drawable.ic_input_add;
    }

    private static PendingIntent openApp(Context app) {
        Intent intent = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        if (intent == null) {
            intent = actionIntent(app, "spend");
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(
                app, RC_OPEN, intent, PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag());
    }

    /**
     * duitful://action/&lt;name&gt;, resolved to an explicit component so the
     * intent can never be offered to another app. The scheme filter is
     * installed by scripts/patch-android-shortcuts.mjs; if it is somehow
     * missing we fall back to plain "open the app".
     */
    private static Intent actionIntent(Context app, String action) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(ACTION_URL_PREFIX + action));
        intent.setPackage(app.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ResolveInfo info = app.getPackageManager().resolveActivity(intent, 0);
            if (info != null && info.activityInfo != null && info.activityInfo.name != null) {
                intent.setClassName(app.getPackageName(), info.activityInfo.name);
                return intent;
            }
        } catch (Throwable ignored) {}
        Intent launch = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        if (launch != null) {
            launch.setAction(Intent.ACTION_VIEW);
            launch.setData(Uri.parse(ACTION_URL_PREFIX + action));
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            return launch;
        }
        return intent;
    }

    /**
     * RemoteInput REQUIRES a mutable PendingIntent — the system writes the
     * typed text into it. FLAG_MUTABLE landed in API 31 and is a compile-time
     * constant, so referencing it is safe on older devices; it simply must not
     * be passed there, hence the version check.
     */
    private static int mutableFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
    }

    /** FLAG_IMMUTABLE has existed since API 23 (this project's minSdk). */
    private static int immutableFlag() {
        return PendingIntent.FLAG_IMMUTABLE;
    }
}
