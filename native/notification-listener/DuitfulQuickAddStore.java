package com.aydiljoe.duitful.plugins;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The quick-add queue — the only place anything outside the app is allowed to
 * write, and deliberately the dumbest store in the project.
 *
 * WHY IT EXISTS. Duitful's vault is AES-GCM encrypted under a key derived from
 * the user's passcode, and that key only ever exists in the app process's
 * memory after an unlock. A widget runs in the launcher's process and a
 * BroadcastReceiver may run with no unlocked session at all, so neither can
 * write a transaction. This queue is the bridge: native appends a tiny plain
 * record here, and the web layer drains it (NotificationListener.drainQuickAdd)
 * and commits it into the encrypted vault the next time the app is open.
 *
 * WHAT THAT COSTS, STATED PLAINLY. Everything in this file is plaintext in the
 * app's private SharedPreferences (`duitful_quickadd`). It is readable by root
 * and by a backup extractor, and it is NOT protected by the passcode. That is
 * why it holds only an amount, an optional free-text category and a timestamp —
 * no balances, no merchant, no account, no history. It is capped at
 * {@link #MAX_ENTRIES} and emptied on every drain, so it is a short-lived
 * outbox, never a second copy of the ledger. Do not widen this shape without a
 * decision about the vault first.
 *
 * CONCURRENCY. A launcher tap, a notification reply and a JS drain can all land
 * at once, so every read-modify-write runs inside {@link #LOCK} and every write
 * uses commit() rather than apply() — a BroadcastReceiver's process can be
 * killed the instant onReceive() returns, and an apply() in flight would be
 * lost. The lock is a plain static monitor, which is sufficient because every
 * writer lives in the single app process (no android:process anywhere in the
 * manifest); SharedPreferences is not cross-process safe and MODE_MULTI_PROCESS
 * is deprecated and broken, so if a component is ever given its own process
 * this needs to become a ContentProvider, not a bigger lock.
 */
public final class DuitfulQuickAddStore {

    /** SharedPreferences file name. Part of the contract — do not rename. */
    public static final String PREFS = "duitful_quickadd";
    /** Key holding the JSON array of pending entries. Part of the contract. */
    public static final String KEY_QUEUE = "queue";
    /** Key holding whether the persistent quick-add notification is wanted. */
    public static final String KEY_NOTIFICATION_ENABLED = "notification_enabled";

    /** Oldest entries are dropped past this. */
    public static final int MAX_ENTRIES = 50;
    /** RM 10,000,000 — a typo guard, not a business rule. */
    public static final double MAX_AMOUNT = 10000000d;
    /** Free-text category, clipped so a malicious/garbled extra cannot bloat the file. */
    private static final int MAX_CATEGORY_CHARS = 40;

    /** Guards every read-modify-write below. See the class note on concurrency. */
    private static final Object LOCK = new Object();

    /**
     * What a sane amount looks like once the currency chrome is stripped:
     * up to 9 integer digits, optionally a dot and up to 6 decimals. No sign,
     * no exponent — which is what rejects "-5" and "1e9".
     */
    private static final Pattern AMOUNT = Pattern.compile("\\d{1,9}(\\.\\d{1,6})?");

    private DuitfulQuickAddStore() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // --- Queue ------------------------------------------------------------

    /**
     * Appends one entry: {"a": amount, "c": category, "t": epoch millis}.
     *
     * @param when preferred timestamp, usually System.currentTimeMillis().
     * @return the timestamp the entry actually got (nudged forward if it would
     *         have collided with the previous entry, so an Undo can always
     *         address exactly one row), or 0 if nothing was stored.
     */
    public static long append(Context context, double amount, String category, long when) {
        if (context == null) return 0L;
        double value = normaliseAmount(amount);
        if (value <= 0) return 0L;
        String clean = cleanCategory(category);
        synchronized (LOCK) {
            try {
                SharedPreferences prefs = prefs(context);
                JSONArray queue = readLocked(prefs);
                long stamp = when > 0 ? when : System.currentTimeMillis();
                JSONObject last = queue.length() > 0 ? queue.optJSONObject(queue.length() - 1) : null;
                if (last != null && last.optLong("t", 0L) >= stamp) stamp = last.optLong("t", 0L) + 1L;

                JSONObject entry = new JSONObject();
                entry.put("a", value);
                entry.put("c", clean);
                entry.put("t", stamp);
                queue.put(entry);

                writeLocked(prefs, trimLocked(queue));
                return stamp;
            } catch (Throwable ignored) {
                // A full disk or a hostile stored value must never take the
                // caller (a launcher tap, a notification reply) down with it.
                return 0L;
            }
        }
    }

    /**
     * Returns every pending entry and empties the queue in the same lock, so a
     * concurrent append either lands before the drain (and is returned) or
     * after it (and survives). Never returns null; unreadable rows are skipped
     * and unreadable storage yields an empty array.
     */
    public static JSONArray drain(Context context) {
        JSONArray out = new JSONArray();
        if (context == null) return out;
        synchronized (LOCK) {
            try {
                SharedPreferences prefs = prefs(context);
                JSONArray queue = readLocked(prefs);
                for (int i = 0; i < queue.length(); i++) {
                    JSONObject clean = sanitise(queue.optJSONObject(i));
                    if (clean != null) out.put(clean);
                }
                prefs.edit().remove(KEY_QUEUE).commit();
            } catch (Throwable ignored) {
                // Fall through with whatever was already collected.
            }
        }
        return out;
    }

    /** Removes the single entry stamped {@code timestamp}. Backs the Undo action. */
    public static boolean remove(Context context, long timestamp) {
        if (context == null || timestamp <= 0) return false;
        synchronized (LOCK) {
            try {
                SharedPreferences prefs = prefs(context);
                JSONArray queue = readLocked(prefs);
                JSONArray kept = new JSONArray();
                boolean removed = false;
                for (int i = 0; i < queue.length(); i++) {
                    JSONObject entry = queue.optJSONObject(i);
                    if (!removed && entry != null && entry.optLong("t", 0L) == timestamp) {
                        removed = true;
                        continue;
                    }
                    if (entry != null) kept.put(entry);
                }
                if (removed) writeLocked(prefs, kept);
                return removed;
            } catch (Throwable ignored) {
                return false;
            }
        }
    }

    /** Number of entries waiting to be drained. */
    public static int size(Context context) {
        if (context == null) return 0;
        synchronized (LOCK) {
            try {
                return readLocked(prefs(context)).length();
            } catch (Throwable ignored) {
                return 0;
            }
        }
    }

    // --- Amount parsing ---------------------------------------------------

    /**
     * Lenient parse of whatever a human typed into the notification's reply
     * field. Strips currency chrome and spaces, understands both the comma as a
     * thousands separator ("1,234.50") and as a decimal point ("12,50"), and
     * returns NaN for anything that is not a positive amount.
     *
     * Accepts:  "12"  "12.50"  "RM12.50"  "rm 12,50"  " 12.5 "  "1,234.50"
     * Rejects:  ""  "abc"  "-5"  "0"  "1e9"  "12.50.50"  anything over RM 10m
     */
    public static double parseAmount(String raw) {
        if (raw == null) return Double.NaN;
        String s = raw.trim();
        if (s.length() == 0 || s.length() > 32) return Double.NaN;
        s = s.toLowerCase(Locale.US);
        // Currency chrome people actually type in front of a number.
        s = s.replace("myr", "").replace("rm", "").replace("$", "");

        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            // Whitespace and the digit groupers people paste in are noise, not
            // data. U+00A0 is spelled out because Character.isWhitespace()
            // deliberately answers false for a non-breaking space, and several
            // keyboards emit exactly that between "RM" and the number.
            if (Character.isWhitespace(c) || c == '\u00a0' || c == '_' || c == '\'') continue;
            sb.append(c);
        }
        s = sb.toString();
        if (s.length() == 0) return Double.NaN;

        int firstComma = s.indexOf(',');
        if (firstComma >= 0) {
            int lastComma = s.lastIndexOf(',');
            int afterLast = s.length() - lastComma - 1;
            if (s.indexOf('.') >= 0) {
                // Both present: the dot is the decimal point, commas group digits.
                s = s.replace(",", "");
            } else if (firstComma == lastComma && afterLast >= 1 && afterLast <= 2) {
                // A single comma with one or two digits behind it is a decimal
                // point — "12,50" is RM 12.50, not RM 1250.
                s = s.substring(0, lastComma) + "." + s.substring(lastComma + 1);
            } else {
                s = s.replace(",", "");
            }
        }

        if (!AMOUNT.matcher(s).matches()) return Double.NaN;
        double value;
        try {
            value = Double.parseDouble(s);
        } catch (Throwable ignored) {
            return Double.NaN;
        }
        value = normaliseAmount(value);
        return value > 0 ? value : Double.NaN;
    }

    /** Rounds to sen and rejects zero/negative/absurd/non-finite. Returns 0 when unusable. */
    static double normaliseAmount(double amount) {
        if (Double.isNaN(amount) || Double.isInfinite(amount)) return 0d;
        if (amount <= 0d || amount > MAX_AMOUNT) return 0d;
        double rounded = Math.round(amount * 100d) / 100d;
        return rounded > 0d ? rounded : 0d;
    }

    // --- Internals --------------------------------------------------------

    private static JSONArray readLocked(SharedPreferences prefs) {
        String raw;
        try {
            raw = prefs.getString(KEY_QUEUE, null);
        } catch (Throwable ignored) {
            // ClassCastException if something ever wrote a non-string here.
            return new JSONArray();
        }
        if (raw == null || raw.length() == 0) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (Throwable ignored) {
            // Corrupted storage recovers to an empty queue rather than throwing
            // — one lost quick-add beats a receiver that can never run again.
            return new JSONArray();
        }
    }

    private static void writeLocked(SharedPreferences prefs, JSONArray queue) {
        // commit(), not apply(): see the class note on concurrency.
        prefs.edit().putString(KEY_QUEUE, queue.toString()).commit();
    }

    private static JSONArray trimLocked(JSONArray queue) {
        while (queue.length() > MAX_ENTRIES) queue.remove(0);
        return queue;
    }

    /** Rebuilds one stored row into exactly {a, c, t}, or null if it is junk. */
    private static JSONObject sanitise(JSONObject entry) {
        if (entry == null) return null;
        double amount = normaliseAmount(entry.optDouble("a", Double.NaN));
        if (amount <= 0) return null;
        try {
            JSONObject out = new JSONObject();
            out.put("a", amount);
            out.put("c", cleanCategory(entry.optString("c", "")));
            long stamp = entry.optLong("t", 0L);
            out.put("t", stamp > 0 ? stamp : System.currentTimeMillis());
            return out;
        } catch (Throwable ignored) {
            return null;
        }
    }

    static String cleanCategory(String category) {
        if (category == null) return "";
        String s = category.trim();
        if (s.length() == 0) return "";
        StringBuilder sb = new StringBuilder(Math.min(s.length(), MAX_CATEGORY_CHARS));
        for (int i = 0; i < s.length() && sb.length() < MAX_CATEGORY_CHARS; i++) {
            char c = s.charAt(i);
            // Control characters would only ever confuse the CSV/UI layer.
            if (c < 0x20 || c == 0x7f) continue;
            sb.append(c);
        }
        return sb.toString().trim();
    }
}
