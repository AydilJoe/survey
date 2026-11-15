package com.aydiljoe.duitful.plugins;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What the notification listener saw, for Settings → Bank alerts → "Check
 * auto-capture". Only facts, never content: the app's package, when, and what
 * happened ("stored", "no amount", "not on the list", ...). No titles, no
 * text, no amounts. A ring buffer of {@link #MAX} rows in app-private prefs,
 * plus when the listener was last connected and disconnected.
 */
public final class DuitfulCaptureDiag {
    static final String PREFS = "duitful_capture_diag";
    static final int MAX = 20;
    private static final Object LOCK = new Object();

    private DuitfulCaptureDiag() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void note(Context c, String pkg, String result) {
        if (c == null) return;
        synchronized (LOCK) {
            try {
                SharedPreferences p = prefs(c);
                JSONArray log = new JSONArray(p.getString("log", "[]"));
                JSONObject row = new JSONObject();
                row.put("p", pkg == null ? "" : pkg);
                row.put("t", System.currentTimeMillis());
                row.put("r", result == null ? "" : result);
                log.put(row);
                JSONArray kept = new JSONArray();
                for (int i = Math.max(0, log.length() - MAX); i < log.length(); i++) kept.put(log.get(i));
                p.edit().putString("log", kept.toString()).apply();
            } catch (Throwable ignored) {}
        }
    }

    public static void connected(Context c, boolean on) {
        if (c == null) return;
        try { prefs(c).edit().putLong(on ? "connectedAt" : "disconnectedAt", System.currentTimeMillis()).apply(); } catch (Throwable ignored) {}
    }

    public static JSONObject read(Context c) {
        JSONObject out = new JSONObject();
        try {
            SharedPreferences p = prefs(c);
            out.put("connectedAt", p.getLong("connectedAt", 0L));
            out.put("disconnectedAt", p.getLong("disconnectedAt", 0L));
            out.put("log", new JSONArray(p.getString("log", "[]")));
        } catch (Throwable ignored) {}
        return out;
    }
}
