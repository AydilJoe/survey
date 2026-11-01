package com.aydiljoe.duitful.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * "Siti says they paid" while Duitful is closed.
 *
 * The app hands over the split bills that still have someone owing
 * (DuitfulKit.relayWatch): each one's mailbox id and key, its title and the
 * names. Every ~15 minutes, with a network, WorkManager runs
 * DuitfulRelayWorker, which fetches those mailboxes from /api/relay/, opens
 * the events with the key on the phone, and posts a notification for each
 * "I've paid" it hasn't seen. Duitful's server learns nothing it didn't
 * already: it only ever sees mailbox ids and ciphertext.
 *
 * The list is the one thing kept outside the passcode vault, because the
 * worker has to run without the passcode. It is encrypted at rest with a key
 * in the Android Keystore (never exported), holds only the open bills, and is
 * wiped when the user turns the notifications off.
 */
final class DuitfulRelayWatch {
    static final String WORK_NAME = "duitful-relay-watch";
    private static final String PREFS = "duitful_relay_watch";
    private static final String PREF_STATE = "state";
    private static final String KEY_ALIAS = "duitful-relay-watch";
    private static final String CHANNEL = "duitful_split_paid";
    private static final String ORIGIN = "https://duitful.app";
    private static final int SEEN_CAP = 400;
    private static final int NOTIFY_ID_BASE = 7300;

    private DuitfulRelayWatch() {}

    /** Replaces the watch list; empty or off cancels the background check. */
    static void update(Context context, JSONArray boxes, JSONArray seen, boolean on) throws Exception {
        Context app = context.getApplicationContext();
        if (!on || boxes == null || boxes.length() == 0) {
            WorkManager.getInstance(app).cancelUniqueWork(WORK_NAME);
            app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(PREF_STATE).apply();
            return;
        }
        // Keep what the worker already announced, plus what the app has handled.
        Set<String> merged = new LinkedHashSet<>(seenOf(load(app)));
        if (seen != null) for (int i = 0; i < seen.length(); i++) merged.add(seen.optString(i));
        JSONObject state = new JSONObject();
        state.put("boxes", boxes);
        state.put("seen", new JSONArray(trim(merged)));
        save(app, state);

        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(DuitfulRelayWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(app).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    /** One pass over every watched mailbox. Called by DuitfulRelayWorker. */
    static void check(Context context) {
        Context app = context.getApplicationContext();
        JSONObject state = load(app);
        if (state == null) return;
        JSONArray boxes = state.optJSONArray("boxes");
        if (boxes == null) return;
        Set<String> seen = new LinkedHashSet<>(seenOf(state));
        List<String[]> fresh = new ArrayList<>();
        for (int i = 0; i < boxes.length(); i++) {
            JSONObject box = boxes.optJSONObject(i);
            if (box == null) continue;
            String id = box.optString("id");
            byte[] key = decodeB64Url(box.optString("key"));
            JSONObject people = box.optJSONObject("p");
            JSONArray events = fetchEvents(id);
            if (events == null || key == null || people == null) continue;
            for (int j = 0; j < events.length(); j++) {
                byte[] plain = DuitfulRelayCrypto.open(key, decodeB64Url(events.optString(j)), id, "event");
                if (plain == null) continue;
                try {
                    JSONObject ev = new JSONObject(new String(plain, StandardCharsets.UTF_8));
                    String eventId = ev.optString("e");
                    String personId = ev.optString("id");
                    if (!"paid".equals(ev.optString("t")) || eventId.isEmpty() || seen.contains(eventId)) continue;
                    seen.add(eventId);
                    if (!people.has(personId)) continue;
                    String who = ev.optString("fr");
                    if (who.isEmpty()) who = people.optString(personId, "Someone");
                    String text = String.format(Locale.US, "%s says they paid RM %.2f", who, ev.optDouble("a", 0));
                    fresh.add(new String[] { eventId, text, box.optString("ti", "Split bill") });
                } catch (Exception ignored) {}
            }
        }
        try {
            state.put("seen", new JSONArray(trim(seen)));
            save(app, state);
        } catch (Exception ignored) {}
        for (String[] f : fresh) notifyPaid(app, f[0], f[1], f[2]);
    }

    private static JSONArray fetchEvents(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{16}")) return null;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(ORIGIN + "/api/relay/?op=get&id=" + id).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < 512 * 1024) out.write(buf, 0, n);
                return new JSONObject(out.toString("UTF-8")).optJSONArray("events");
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void notifyPaid(Context app, String eventId, String text, String title) {
        ensureChannel(app);
        Intent launch = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        PendingIntent open = launch == null ? null : PendingIntent.getActivity(
            app, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(app, CHANNEL)
            .setSmallIcon(smallIcon(app))
            .setContentTitle(text)
            .setContentText(title + " · Open Duitful to confirm")
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        if (open != null) b.setContentIntent(open);
        try {
            NotificationManagerCompat.from(app).notify(NOTIFY_ID_BASE + (eventId.hashCode() & 0x3ff), b.build());
        } catch (Throwable ignored) {
            // No POST_NOTIFICATIONS (API 33+): the app still asks on next open.
        }
    }

    private static void ensureChannel(Context app) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager manager = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Split payments", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("When someone says they've paid a bill you split.");
            manager.createNotificationChannel(ch);
        } catch (Throwable ignored) {}
    }

    private static int smallIcon(Context app) {
        try {
            int id = app.getResources().getIdentifier("duitful_quickadd_ic", "drawable", app.getPackageName());
            if (id != 0) return id;
        } catch (Throwable ignored) {}
        try {
            int id = app.getApplicationInfo().icon;
            if (id != 0) return id;
        } catch (Throwable ignored) {}
        return android.R.drawable.ic_dialog_info;
    }

    /* ---- storage: one JSON blob, AES-GCM with a Keystore key ---- */

    private static SecretKey keystoreKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return gen.generateKey();
    }

    private static void save(Context app, JSONObject state) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey());
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(state.toString().getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(ct, 0, all, iv.length, ct.length);
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(PREF_STATE, Base64.encodeToString(all, Base64.NO_WRAP)).apply();
    }

    private static JSONObject load(Context app) {
        String stored = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_STATE, null);
        if (stored == null) return null;
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), new GCMParameterSpec(128, Arrays.copyOfRange(all, 0, 12)));
            return new JSONObject(new String(cipher.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null; // key gone (restore to a new phone): the app sends the list again
        }
    }

    private static List<String> seenOf(JSONObject state) {
        List<String> out = new ArrayList<>();
        JSONArray a = state == null ? null : state.optJSONArray("seen");
        if (a != null) for (int i = 0; i < a.length(); i++) out.add(a.optString(i));
        return out;
    }

    private static List<String> trim(Set<String> seen) {
        List<String> all = new ArrayList<>(seen);
        return all.size() > SEEN_CAP ? all.subList(all.size() - SEEN_CAP, all.size()) : all;
    }

    private static byte[] decodeB64Url(String s) {
        if (s == null || s.isEmpty()) return null;
        try {
            return Base64.decode(s, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }
}
