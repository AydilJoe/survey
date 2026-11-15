package com.aydiljoe.duitful.plugins;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Bank / e-wallet notifications caught while the app is closed.
 *
 * WHY IT EXISTS. The listener service runs whenever Android lets it, but the
 * web layer (and the passcode key that opens the vault) only exists while the
 * app is open and unlocked. Before this store, a notification that arrived
 * with the app closed reached NotificationListenerPlugin.emit(), found no
 * instance, and was dropped. On phones that kill the activity aggressively
 * (Vivo / OriginOS, Xiaomi, Oppo) that was almost every notification.
 *
 * WHAT IS KEPT. Only notifications from the whitelisted apps whose text holds
 * a currency amount (the service filters before calling append), as
 * {"p": package, "ti": title, "tx": text, "t": posted-at millis}. Capped at
 * {@link #MAX_ENTRIES}, anything older than {@link #MAX_AGE_MS} is dropped,
 * and the whole list is emptied on every drain. Unlike the quick-add queue it
 * holds bank text (amounts, payee names), so it is encrypted with AES-GCM
 * under an Android Keystore key that never leaves the device. If the key is
 * lost (restore to a new phone) the list is unreadable and simply starts over.
 *
 * CONCURRENCY. The service and a JS drain can run at once: every
 * read-modify-write holds {@link #LOCK} and writes with commit().
 */
public final class DuitfulCaptureStore {

    static final String PREFS = "duitful_capture";
    private static final String KEY_BLOB = "blob";
    private static final String KEY_ALIAS = "duitful_capture";

    static final int MAX_ENTRIES = 50;
    static final long MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    /** Notification keys already stored, so an update or a reconnect replay is not stored twice. */
    private static final int SEEN_CAP = 200;
    private static final int MAX_TEXT_CHARS = 600;

    private static final Object LOCK = new Object();

    private DuitfulCaptureStore() {}

    /** Stores one notification. Returns false when it was already stored or could not be. */
    public static boolean append(Context context, String pkg, String title, String text, String key, long when) {
        if (context == null || pkg == null) return false;
        synchronized (LOCK) {
            try {
                JSONObject state = load(context);
                JSONArray queue = state.optJSONArray("q");
                JSONArray seen = state.optJSONArray("s");
                if (queue == null) queue = new JSONArray();
                if (seen == null) seen = new JSONArray();
                String id = (key == null ? pkg : key) + "|" + clip(text).hashCode();
                for (int i = 0; i < seen.length(); i++) {
                    if (id.equals(seen.optString(i))) return false;
                }
                JSONObject entry = new JSONObject();
                entry.put("p", pkg);
                entry.put("ti", clip(title));
                entry.put("tx", clip(text));
                entry.put("t", when > 0 ? when : System.currentTimeMillis());
                queue.put(entry);
                seen.put(id);
                state.put("q", trim(fresh(queue), MAX_ENTRIES));
                state.put("s", trim(seen, SEEN_CAP));
                save(context, state);
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        }
    }

    /** Every stored notification, oldest first, and an empty queue afterwards. Never null. */
    public static JSONArray drain(Context context) {
        JSONArray out = new JSONArray();
        if (context == null) return out;
        synchronized (LOCK) {
            try {
                JSONObject state = load(context);
                JSONArray queue = state.optJSONArray("q");
                if (queue != null) out = fresh(queue);
                state.put("q", new JSONArray());
                save(context, state);
            } catch (Throwable ignored) {
                // Fall through with whatever was read.
            }
        }
        return out;
    }

    private static String clip(String s) {
        if (s == null) return "";
        return s.length() > MAX_TEXT_CHARS ? s.substring(0, MAX_TEXT_CHARS) : s;
    }

    private static JSONArray fresh(JSONArray queue) {
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        JSONArray kept = new JSONArray();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject e = queue.optJSONObject(i);
            if (e != null && e.optLong("t", 0L) >= cutoff) kept.put(e);
        }
        return kept;
    }

    private static JSONArray trim(JSONArray a, int cap) {
        if (a.length() <= cap) return a;
        JSONArray kept = new JSONArray();
        for (int i = a.length() - cap; i < a.length(); i++) kept.put(a.opt(i));
        return kept;
    }

    /* ---- storage: one JSON blob, AES-GCM with a Keystore key ---- */

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

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

    private static void save(Context context, JSONObject state) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey());
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(state.toString().getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(ct, 0, all, iv.length, ct.length);
        prefs(context).edit().putString(KEY_BLOB, Base64.encodeToString(all, Base64.NO_WRAP)).commit();
    }

    private static JSONObject load(Context context) {
        String stored = prefs(context).getString(KEY_BLOB, null);
        if (stored == null) return new JSONObject();
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), new GCMParameterSpec(128, Arrays.copyOfRange(all, 0, 12)));
            return new JSONObject(new String(cipher.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject(); // key gone or blob damaged: start over
        }
    }
}
