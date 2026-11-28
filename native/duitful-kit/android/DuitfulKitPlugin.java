package com.aydiljoe.duitful.plugins;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Duitful's on-device "kits" on Android, one plugin, three jobs:
 *
 *   scanDocument     Google's ML Kit Document Scanner: finds the receipt's
 *                    edges, straightens it and cleans it up, then hands back
 *                    JPEG pages as data URLs for the OCR the app already runs.
 *                    The scanner UI runs inside Google Play services, so the
 *                    app needs no camera permission for it.
 *   extractEntities  ML Kit Entity Extraction: amounts and dates in a piece
 *                    of text (a receipt read, a bank notification).
 *   requestReview    Play's own in-app review sheet, asked once per install
 *                    at the debt-free moment. Play decides whether to show
 *                    it; resolving says we asked, not that it appeared.
 *   aiStatus /       Gemini Nano through ML Kit's Prompt API: a second
 *   aiReadReceipt    opinion on a receipt the rule-based parser isn't sure of.
 *   aiReadAlert      The same model labelling a bank notification the capture
 *                    rules couldn't place (direction, counterparty, category).
 *   speechAvailable/ Android's SpeechRecognizer for "Talk to Kira" (1.80.0,
 *   speechStart /    DuitfulKitSpeech): on-device on Android 12+ when the
 *   speechStop       phone has it, else the phone's recognition service with
 *                    EXTRA_PREFER_OFFLINE. Partial text is the "speechPartial"
 *                    event; speechStart resolves {text}. RECORD_AUDIO is
 *                    asked (alias "microphone") only when the mic is used.
 *
 * Nothing here talks to a Duitful server. The scanner and Gemini Nano run on
 * the phone; Entity Extraction downloads its language model from Google once,
 * then runs offline. Text goes in and comes back; nothing is stored.
 *
 * Entity Extraction and the Prompt API require Android 8 (API 26) while the
 * app supports Android 7. The install script adds tools:overrideLibrary for
 * exactly those packages, so every call into them goes through
 * DuitfulKitEntities / DuitfulKitAi, which are only loaded after an
 * SDK_INT >= 26 check. On Android 7 the methods report "unsupported" and the
 * web layer carries on with its own parser.
 */
@CapacitorPlugin(
    name = "DuitfulKit",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = DuitfulKitPlugin.MIC)
    }
)
public class DuitfulKitPlugin extends Plugin {

    private static final int MIN_SDK_FOR_ML = Build.VERSION_CODES.O; // 26
    static final String TAG = "DuitfulKit";
    static final String MIC = "microphone";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private ActivityResultLauncher<IntentSenderRequest> scanLauncher;
    private PluginCall pendingScan;
    private DuitfulKitSpeech speech;

    /** Files shared to Duitful, waiting for the app (unlocked) to take them. */
    private final List<Uri> shared = new ArrayList<>();
    static final int SHARED_MAX_FILES = 12;
    static final int SHARED_MAX_BYTES = 25 * 1024 * 1024;

    @Override
    public void load() {
        // Must be registered before the activity is STARTED; plugins load
        // during BridgeActivity.onCreate, which is early enough.
        scanLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onScanResult
        );
        // Launched by Share / Open with.
        keepShared(getActivity().getIntent());
    }

    /* ---------- Share / Open with ----------
       A statement PDF or photos shared from a bank app, Mail or Files. The
       intent only carries content:// pointers; they are kept here until the
       app is unlocked and asks (takeSharedFiles), then read and forgotten.
       Nothing is copied to storage. */

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (keepShared(intent)) notifyListeners("sharedFiles", new JSObject(), true);
    }

    @SuppressWarnings("deprecation")
    private boolean keepShared(Intent intent) {
        if (intent == null || intent.getAction() == null) return false;
        List<Uri> found = new ArrayList<>();
        try {
            String action = intent.getAction();
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) found.add(u);
            } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                ArrayList<Uri> us = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (us != null) for (Uri u : us) if (u != null) found.add(u);
            } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null
                    && "content".equals(intent.getData().getScheme())) {
                found.add(intent.getData());
            }
        } catch (Exception e) {
            return false;
        }
        if (found.isEmpty()) return false;
        synchronized (shared) {
            shared.clear();
            shared.addAll(found.subList(0, Math.min(found.size(), SHARED_MAX_FILES)));
        }
        return true;
    }

    /** {files: [{name, mime, base64}]}; empty when nothing was shared. Each file is handed over once. */
    @PluginMethod
    public void takeSharedFiles(PluginCall call) {
        final List<Uri> list;
        synchronized (shared) {
            list = new ArrayList<>(shared);
            shared.clear();
        }
        io.execute(() -> {
            JSArray files = new JSArray();
            for (Uri u : list) {
                try {
                    String mime = getContext().getContentResolver().getType(u);
                    if (mime == null || !(mime.equals("application/pdf") || mime.startsWith("image/"))) continue;
                    String name = "shared";
                    try (Cursor c = getContext().getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                        if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
                    } catch (Exception ignored) {}
                    byte[] bytes;
                    try (InputStream in = getContext().getContentResolver().openInputStream(u)) {
                        if (in == null) continue;
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            if (out.size() > SHARED_MAX_BYTES) break;
                        }
                        if (out.size() > SHARED_MAX_BYTES) continue;
                        bytes = out.toByteArray();
                    }
                    files.put(new JSObject().put("name", name).put("mime", mime).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)));
                } catch (Exception e) {
                    Log.w(TAG, "shared file unreadable", e);
                }
            }
            call.resolve(new JSObject().put("files", files));
        });
    }

    /* ---------- Text recognition (Play Services ML Kit v2) ---------- */

    /**
     * Unbundled ML Kit Text Recognition v2 (Chinese + Latin via Play Services).
     * Mirrors iOS DuitfulKit.recognizeText({ base64Image, rotation }).
     */
    @PluginMethod
    public void recognizeText(PluginCall call) {
        DuitfulKitTextReader.recognize(call, io);
    }

    /* ---------- Document scanner ---------- */

    @PluginMethod
    public void scanDocument(PluginCall call) {
        Log.i(TAG, "scanDocument");
        try {
            startScan(call);
        } catch (Throwable e) {
            // 1.54.1 died here on some phones: an NPE inside
            // GmsDocumentScanning.getClient, thrown on the plugin thread
            // where nothing catches it. Whatever the scanner library does,
            // a scan that can't start must fall back to the camera, never
            // close the app. tests/android-launch.sh fails on this line.
            Log.e(TAG, "scanDocument threw", e);
            pendingScan = null;
            call.reject("Scanner unavailable", "UNAVAILABLE");
        }
    }

    private void startScan(PluginCall call) {
        if (pendingScan != null) {
            call.reject("A scan is already open", "BUSY");
            return;
        }
        int pages = Math.max(1, Math.min(5, call.getInt("pageLimit", 3)));
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(call.getBoolean("allowGallery", true))
            .setPageLimit(pages)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();
        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
        pendingScan = call;
        scanner.getStartScanIntent(getActivity())
            .addOnSuccessListener(sender -> scanLauncher.launch(new IntentSenderRequest.Builder(sender).build()))
            .addOnFailureListener(e -> {
                PluginCall c = pendingScan;
                pendingScan = null;
                // Low-RAM phones (under ~1.7 GB) and phones without Play
                // services land here. The web layer falls back to the camera.
                if (c != null) c.reject(String.valueOf(e.getMessage()), "UNAVAILABLE");
            });
    }

    private void onScanResult(ActivityResult result) {
        PluginCall call = pendingScan;
        pendingScan = null;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Scan cancelled", "CANCELLED");
            return;
        }
        GmsDocumentScanningResult scan = GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
        List<GmsDocumentScanningResult.Page> pages = scan == null ? null : scan.getPages();
        if (pages == null || pages.isEmpty()) {
            call.reject("Scan cancelled", "CANCELLED");
            return;
        }
        // Reading and base64-ing a few MB of JPEG is too slow for the main
        // thread; resolve() is safe to call from any thread.
        io.execute(() -> {
            JSArray images = new JSArray();
            try {
                for (GmsDocumentScanningResult.Page page : pages) {
                    images.put("data:image/jpeg;base64," + readBase64(page.getImageUri()));
                }
            } catch (Exception e) {
                call.reject("Couldn't read the scanned page", "READ_FAILED", e);
                return;
            }
            JSObject ret = new JSObject();
            ret.put("images", images);
            call.resolve(ret);
        });
    }

    private String readBase64(Uri uri) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) throw new IllegalStateException("No data for " + uri);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        }
    }

    /* ---------- Entity Extraction ---------- */

    @PluginMethod
    public void extractEntities(PluginCall call) {
        String text = call.getString("text", "");
        if (Build.VERSION.SDK_INT < MIN_SDK_FOR_ML) {
            call.reject("Needs Android 8 or newer", "UNSUPPORTED");
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("money", new JSArray());
            empty.put("dates", new JSArray());
            call.resolve(empty);
            return;
        }
        try {
            DuitfulKitEntities.extract(text, call);
        } catch (Throwable e) {
            Log.e(TAG, "DuitfulKitEntities.extract threw", e);
            call.reject("Unavailable", "UNAVAILABLE");
        }
    }

    /* ---------- Gemini Nano ---------- */

    @PluginMethod
    public void aiStatus(PluginCall call) {
        if (Build.VERSION.SDK_INT < MIN_SDK_FOR_ML) {
            JSObject ret = new JSObject();
            ret.put("available", false);
            ret.put("reason", "unsupported");
            call.resolve(ret);
            return;
        }
        try {
            DuitfulKitAi.status(getContext(), call);
        } catch (Throwable e) {
            Log.e(TAG, "DuitfulKitAi.status threw", e);
            call.reject("Unavailable", "UNAVAILABLE");
        }
    }

    @PluginMethod
    public void aiReadReceipt(PluginCall call) {
        String text = call.getString("text", "");
        if (Build.VERSION.SDK_INT < MIN_SDK_FOR_ML) {
            call.reject("Needs Android 8 or newer", "UNSUPPORTED");
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            call.reject("No text", "EMPTY");
            return;
        }
        try {
            DuitfulKitAi.readReceipt(getContext(), text, call);
        } catch (Throwable e) {
            Log.e(TAG, "DuitfulKitAi.readReceipt threw", e);
            call.reject("Unavailable", "UNAVAILABLE");
        }
    }

    /** The monthly recap in plain sentences, from the app's own fact lines. → {json: text} */
    @PluginMethod
    public void aiWriteRecap(PluginCall call) {
        String facts = call.getString("facts", "");
        if (Build.VERSION.SDK_INT < MIN_SDK_FOR_ML) {
            call.reject("Needs Android 8 or newer", "UNSUPPORTED");
            return;
        }
        if (facts == null || facts.trim().isEmpty()) {
            call.reject("No facts", "EMPTY");
            return;
        }
        DuitfulKitAi.writeRecap(getContext(), facts, call);
    }

    @PluginMethod
    public void aiReadAlert(PluginCall call) {
        String text = call.getString("text", "");
        if (Build.VERSION.SDK_INT < MIN_SDK_FOR_ML) {
            call.reject("Needs Android 8 or newer", "UNSUPPORTED");
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            call.reject("No text", "EMPTY");
            return;
        }
        String categories = "";
        try {
            JSArray cats = call.getArray("categories");
            if (cats != null) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < cats.length() && i < 20; i++) {
                    String c = cats.optString(i, "");
                    if (c.isEmpty()) continue;
                    if (sb.length() > 0) sb.append(", ");
                    sb.append(c);
                }
                categories = sb.toString();
            }
        } catch (Exception ignored) {}
        try {
            DuitfulKitAi.readAlert(getContext(), text, categories, call);
        } catch (Throwable e) {
            Log.e(TAG, "DuitfulKitAi.readAlert threw", e);
            call.reject("Unavailable", "UNAVAILABLE");
        }
    }

    /**
     * Ask Play for the in-app review sheet. Play enforces its own per-user
     * quota and shows nothing once it is spent or the user has already
     * rated, so `asked` reports that the flow completed, not that a sheet
     * appeared. Both callbacks resolve: a review we could not ask for is a
     * normal outcome, never an error the app should handle.
     */
    /**
     * The split bills to watch while Duitful is closed (see DuitfulRelayWatch):
     * {boxes: [{id, key, ti, p: {personId: name}}], seen: [eventId], on}.
     * An empty list, or on:false, cancels the background check and wipes it.
     */
    @PluginMethod
    public void relayWatch(PluginCall call) {
        try {
            DuitfulRelayWatch.update(getContext(), call.getArray("boxes"), call.getArray("seen"), call.getBoolean("on", true), call.getObject("strings"));
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), "RELAY");
        }
    }

    /**
     * Pushes the non-amount Option D widget summary (theme, locked state,
     * status word, month countdown ring, review count and upcoming bill names)
     * to DuitfulWidgetProvider via an explicit in-app broadcast.
     */
    @PluginMethod
    public void syncWidget(PluginCall call) {
        try {
            String pkg = getContext().getPackageName();
            Intent sync = new Intent(pkg + ".WIDGET_SYNC");
            sync.setClassName(pkg, pkg + ".DuitfulWidgetProvider");
            sync.putExtra("theme", call.getString("theme", "system"));
            sync.putExtra("locked", Boolean.TRUE.equals(call.getBoolean("locked", false)));
            sync.putExtra("status", call.getString("status", ""));
            sync.putExtra("tone", call.getString("tone", "ok"));
            sync.putExtra("month", call.getString("month", ""));
            sync.putExtra("daysLeft", call.getInt("daysLeft", 0));
            sync.putExtra("dayPct", call.getInt("dayPct", 0));
            sync.putExtra("daysLeftShort", call.getString("daysLeftShort", ""));
            sync.putExtra("daysLeftLines", call.getString("daysLeftLines", ""));
            sync.putExtra("daysLeftLong", call.getString("daysLeftLong", ""));
            sync.putExtra("reviewCount", call.getInt("reviewCount", 0));
            sync.putExtra("reviewWord", call.getString("reviewWord", ""));
            sync.putExtra("reviewLine", call.getString("reviewLine", ""));
            sync.putExtra("comingUp", call.getString("comingUp", ""));
            sync.putExtra("noUpcoming", call.getString("noUpcoming", ""));
            sync.putExtra("lockedTitle", call.getString("lockedTitle", ""));
            sync.putExtra("lockedHint", call.getString("lockedHint", ""));
            sync.putExtra("scanLabel", call.getString("scanLabel", ""));
            sync.putExtra("splitLabel", call.getString("splitLabel", ""));
            sync.putExtra("catFood", call.getString("catFood", ""));
            sync.putExtra("catTransport", call.getString("catTransport", ""));
            sync.putExtra("catGroceries", call.getString("catGroceries", ""));
            sync.putExtra("catOther", call.getString("catOther", ""));
            sync.putExtra("due1Name", call.getString("due1Name", ""));
            sync.putExtra("due1When", call.getString("due1When", ""));
            sync.putExtra("due2Name", call.getString("due2Name", ""));
            sync.putExtra("due2When", call.getString("due2When", ""));
            sync.putExtra("dueSub", call.getString("dueSub", ""));
            sync.putExtra("streakDays", call.getInt("streakDays", 0));
            sync.putExtra("streakLabel", call.getString("streakLabel", ""));
            getContext().sendBroadcast(sync);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), "WIDGET");
        }
    }

    /* ---------- Talk to Kira: speech to text ----------
       {lang} is a BCP-47 tag from the app (en-MY, ms-MY, zh-CN). Nothing is
       recorded: the recogniser hands back text and the audio is gone. */

    /** {available, onDevice}: is there a recogniser, and is one on the phone. */
    @PluginMethod
    public void speechAvailable(PluginCall call) {
        boolean onDevice = DuitfulKitSpeech.onDeviceAvailable(getContext());
        boolean any = DuitfulKitSpeech.available(getContext());
        call.resolve(new JSObject().put("available", any).put("onDevice", onDevice));
    }

    /** Listens until speechStop, silence or 30 s; resolves {text} ("" if nothing was heard). */
    @PluginMethod
    public void speechStart(PluginCall call) {
        if (getPermissionState(MIC) != PermissionState.GRANTED) {
            requestPermissionForAlias(MIC, call, "speechPermissionAnswered");
            return;
        }
        beginSpeech(call);
    }

    @PermissionCallback
    private void speechPermissionAnswered(PluginCall call) {
        if (getPermissionState(MIC) == PermissionState.GRANTED) {
            beginSpeech(call);
        } else {
            call.reject("Microphone permission denied", "DENIED");
        }
    }

    private void beginSpeech(final PluginCall call) {
        if (!DuitfulKitSpeech.available(getContext())) {
            call.reject("No speech recogniser on this phone", "UNAVAILABLE");
            return;
        }
        if (speech == null) speech = new DuitfulKitSpeech(getContext());
        speech.start(call.getString("lang", "en-MY"), speechHints(call), new DuitfulKitSpeech.Callback() {
            @Override
            public void partial(String text) {
                notifyListeners("speechPartial", new JSObject().put("text", text));
            }

            @Override
            public void level(float level) {
                notifyListeners("speechLevel", new JSObject().put("level", level));
            }

            @Override
            public void done(String text) {
                call.resolve(new JSObject().put("text", text));
            }

            @Override
            public void error(String code, String message) {
                call.reject(message, code);
            }
        });
    }

    /** speechStart's optional hints: strings of 1-40 characters, no duplicates, at most 100. */
    private static ArrayList<String> speechHints(PluginCall call) {
        ArrayList<String> out = new ArrayList<>();
        JSArray arr = call.getArray("hints");
        if (arr == null) return out;
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < arr.length() && out.size() < 100; i++) {
            Object o = arr.opt(i);
            if (!(o instanceof String)) continue;
            String t = ((String) o).trim();
            if (t.isEmpty() || t.length() > 40 || !seen.add(t.toLowerCase(java.util.Locale.ROOT))) continue;
            out.add(t);
        }
        return out;
    }

    /** Let go of Kira / tap the mic: the pending speechStart resolves with what was heard. */
    @PluginMethod
    public void speechStop(PluginCall call) {
        if (speech != null) speech.stop();
        call.resolve(new JSObject().put("ok", true));
    }

    @Override
    protected void handleOnPause() {
        // Never listen in the background.
        if (speech != null) speech.stop();
        super.handleOnPause();
    }

    @PluginMethod
    public void requestReview(PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve(new JSObject().put("asked", false));
            return;
        }
        final ReviewManager manager;
        try {
            manager = ReviewManagerFactory.create(activity);
        } catch (Throwable e) {
            Log.e(TAG, "requestReview threw", e);
            call.resolve(new JSObject().put("asked", false));
            return;
        }
        manager.requestReviewFlow().addOnCompleteListener(task -> {
            if (!task.isSuccessful()) {
                call.resolve(new JSObject().put("asked", false));
                return;
            }
            ReviewInfo info = task.getResult();
            manager.launchReviewFlow(activity, info)
                .addOnCompleteListener(flow -> call.resolve(new JSObject().put("asked", flow.isSuccessful())));
        });
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        final String style = (call.getString("style", "LIGHT")).toUpperCase(java.util.Locale.ROOT);
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve(new JSObject().put("ok", false));
            return;
        }
        activity.runOnUiThread(() -> {
            View root = activity.getWindow() != null ? activity.getWindow().getDecorView() : null;
            if (root == null) {
                call.resolve(new JSObject().put("ok", false));
                return;
            }
            int flag;
            if ("HEAVY".equals(style) || "RIGID".equals(style)) {
                flag = HapticFeedbackConstants.LONG_PRESS;
            } else if ("SUCCESS".equals(style) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                flag = HapticFeedbackConstants.CONFIRM;
            } else if ("MEDIUM".equals(style)) {
                flag = HapticFeedbackConstants.VIRTUAL_KEY;
            } else {
                flag = HapticFeedbackConstants.CLOCK_TICK;
            }
            boolean ok = root.performHapticFeedback(flag);
            call.resolve(new JSObject().put("ok", ok));
        });
    }

    @PluginMethod
    public void attestDevice(PluginCall call) {
        final String nonce = call.getString("nonce", "").trim();
        if (nonce.isEmpty()) {
            call.resolve(new JSObject().put("supported", false).put("error", "missing-nonce"));
            return;
        }
        final Context ctx = getContext();
        if (ctx == null) {
            call.resolve(new JSObject().put("supported", false).put("platform", "android"));
            return;
        }
        try {
            // App-signing-key-scoped ANDROID_ID hashed with SHA-256 (no permission required,
            // survives reinstalls on the same device). Bound into Play Integrity's signed nonce.
            String rawAndroidId = android.provider.Settings.Secure.getString(
                ctx.getContentResolver(),
                android.provider.Settings.Secure.ANDROID_ID
            );
            if (rawAndroidId == null || rawAndroidId.isEmpty()) {
                call.resolve(new JSObject().put("supported", false).put("platform", "android"));
                return;
            }
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] devBytes = md.digest(("duitful-dev:" + rawAndroidId).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder devHex = new StringBuilder();
            for (byte b : devBytes) devHex.append(String.format(java.util.Locale.US, "%02x", b));
            final String deviceId = devHex.substring(0, 32);

            md.reset();
            byte[] boundBytes = md.digest((nonce + ":" + deviceId).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            final String boundNonce = android.util.Base64.encodeToString(
                boundBytes,
                android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP
            );

            com.google.android.play.core.integrity.IntegrityManager manager =
                com.google.android.play.core.integrity.IntegrityManagerFactory.create(ctx);
            com.google.android.play.core.integrity.IntegrityTokenRequest.Builder reqBuilder =
                com.google.android.play.core.integrity.IntegrityTokenRequest.builder().setNonce(boundNonce);
            String cloudNum = call.getString("cloudProjectNumber", "");
            if (cloudNum != null && !cloudNum.isEmpty()) {
                try { reqBuilder.setCloudProjectNumber(Long.parseLong(cloudNum)); } catch (NumberFormatException ignored) {}
            }
            manager.requestIntegrityToken(reqBuilder.build())
                .addOnSuccessListener(resp -> {
                    String token = resp != null ? resp.token() : "";
                    if (token == null || token.isEmpty()) {
                        call.resolve(new JSObject().put("supported", false).put("platform", "android"));
                        return;
                    }
                    call.resolve(new JSObject()
                        .put("supported", true)
                        .put("platform", "android")
                        .put("integrityToken", token)
                        .put("deviceId", deviceId));
                })
                .addOnFailureListener(err -> call.resolve(new JSObject()
                    .put("supported", false)
                    .put("platform", "android")
                    .put("error", "integrity-unavailable")));
        } catch (Throwable t) {
            call.resolve(new JSObject().put("supported", false).put("platform", "android").put("error", "attest-error"));
        }
    }
}
