package com.aydiljoe.duitful.plugins;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import java.util.ArrayList;

/**
 * "Talk to Kira" (1.80.0): Android's own SpeechRecognizer turns a short
 * spoken spend into text for the Voice sheet.
 *
 *   - On-device first: on Android 12+ (API 31) with an on-device recogniser
 *     for the language, createOnDeviceSpeechRecognizer keeps the audio on
 *     the phone. Otherwise the phone's default recognition service is asked
 *     with EXTRA_PREFER_OFFLINE, which stays offline when the phone has the
 *     language pack; without one, that service (usually Google's) may
 *     process the audio, as the privacy policy says.
 *   - Nothing is recorded or kept: the recogniser hands back text, the
 *     plugin forwards it to JS, and the audio never touches storage.
 *   - At most MAX_MS (30 s) per listen; the recogniser itself ends on
 *     silence. Every SpeechRecognizer call runs on the main thread, as the
 *     API requires.
 *
 * The caller (DuitfulKitPlugin) checks RECORD_AUDIO first.
 */
final class DuitfulKitSpeech {

    interface Callback {
        void partial(String text);
        void level(float level);
        void done(String text);
        void error(String code, String message);
    }

    static final long MAX_MS = 30_000L;

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer rec;
    private Callback cb;
    private String lang = "en-MY";
    private String last = "";
    private boolean triedFallback = false;
    /** Bumped on every listen, so a late safety net never ends the next one. */
    private int gen = 0;
    private final Runnable timeout = this::stop;

    DuitfulKitSpeech(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /** An on-device recogniser exists (Android 12+). */
    static boolean onDeviceAvailable(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        try {
            return SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx);
        } catch (Throwable t) {
            return false;
        }
    }

    /** Any recogniser at all: on-device, or the phone's recognition service. */
    static boolean available(Context ctx) {
        try {
            return onDeviceAvailable(ctx) || SpeechRecognizer.isRecognitionAvailable(ctx);
        } catch (Throwable t) {
            return false;
        }
    }

    private ArrayList<String> hints;

    boolean busy() {
        return cb != null;
    }

    void start(final String language, final Callback callback) {
        start(language, null, callback);
    }

    /**
     * 1.82.0: hints are words the person is likely to say (Malaysian spend
     * words, their categories, wallets and split first names, from JS). On
     * Android 13+ they go in EXTRA_BIASING_STRINGS for the on-device
     * recogniser only; the fallback service and older phones never get them.
     */
    void start(final String language, final ArrayList<String> hintList, final Callback callback) {
        main.post(() -> {
            if (cb != null) {
                callback.error("BUSY", "Already listening");
                return;
            }
            cb = callback;
            gen++;
            lang = language == null || language.isEmpty() ? "en-MY" : language;
            hints = hintList;
            last = "";
            triedFallback = false;
            if (!begin(onDeviceAvailable(ctx))) return;
            main.postDelayed(timeout, MAX_MS);
        });
    }

    /** Released, timed out or cancelled: the recogniser finishes with what it heard. */
    void stop() {
        main.post(() -> {
            if (rec == null) return;
            final int mine = gen;
            try {
                rec.stopListening();
            } catch (Throwable t) {
                finish(last);
                return;
            }
            // A safety net in case the service never answers after stopping.
            main.postDelayed(() -> { if (cb != null && gen == mine) finish(last); }, 2_000L);
        });
    }

    private boolean begin(boolean onDevice) {
        destroyRecognizer();
        try {
            if (onDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                rec = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx);
            } else {
                rec = SpeechRecognizer.createSpeechRecognizer(ctx);
            }
        } catch (Throwable t) {
            Log.w(DuitfulKitPlugin.TAG, "speech: could not create a recogniser", t);
            fail("UNAVAILABLE", "No speech recogniser");
            return false;
        }
        if (rec == null) {
            fail("UNAVAILABLE", "No speech recogniser");
            return false;
        }
        rec.setRecognitionListener(new Listener(onDevice));
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        // Only the on-device recogniser gets the hints (names and wallet
        // names included), so they never go to a speech service off the phone.
        if (onDevice && hints != null && !hints.isEmpty()
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, hints);
        }
        try {
            rec.startListening(intent);
        } catch (Throwable t) {
            Log.w(DuitfulKitPlugin.TAG, "speech: startListening threw", t);
            fail("SPEECH", "Could not start listening");
            return false;
        }
        return true;
    }

    private final class Listener implements RecognitionListener {
        private final boolean onDevice;
        private long lastLevelMs = 0L;

        Listener(boolean onDevice) {
            this.onDevice = onDevice;
        }

        @Override public void onReadyForSpeech(Bundle params) { }
        @Override public void onBeginningOfSpeech() { }
        @Override
        public void onRmsChanged(float rmsdB) {
            if (cb == null) return;
            long now = android.os.SystemClock.uptimeMillis();
            if (now - lastLevelMs < 48L) return;
            lastLevelMs = now;
            // Normalise roughly -2..10 dB to 0..1; only the float goes to JS.
            float norm = Math.max(0f, Math.min(1f, (rmsdB + 2f) / 12f));
            cb.level(norm);
        }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onEvent(int eventType, Bundle params) { }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = first(partialResults);
            if (text.isEmpty() || text.equals(last) || cb == null) return;
            last = text;
            cb.partial(text);
        }

        @Override
        public void onResults(Bundle results) {
            String text = first(results);
            finish(text.isEmpty() ? last : text);
        }

        @Override
        public void onError(int error) {
            if (cb == null) return;
            // The on-device recogniser doesn't know this language: once, try
            // the phone's own service, still preferring offline.
            if (onDevice && !triedFallback && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                        || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)) {
                triedFallback = true;
                if (SpeechRecognizer.isRecognitionAvailable(ctx)) {
                    begin(false);
                    return;
                }
            }
            switch (error) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    finish(last);
                    break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    fail("DENIED", "Microphone permission denied");
                    break;
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                    fail("BUSY", "The recogniser is busy");
                    break;
                default:
                    if (!last.isEmpty()) finish(last);
                    else fail("SPEECH", "Speech error " + error);
            }
        }
    }

    private static String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty() || list.get(0) == null) return "";
        return list.get(0).trim();
    }

    private void finish(String text) {
        Callback c = cb;
        cleanup();
        if (c != null) c.done(text == null ? "" : text);
    }

    private void fail(String code, String message) {
        Callback c = cb;
        cleanup();
        if (c != null) c.error(code, message);
    }

    private void cleanup() {
        cb = null;
        main.removeCallbacks(timeout);
        destroyRecognizer();
    }

    private void destroyRecognizer() {
        if (rec == null) return;
        try {
            rec.cancel();
        } catch (Throwable ignored) { }
        try {
            rec.destroy();
        } catch (Throwable ignored) { }
        rec = null;
    }
}
