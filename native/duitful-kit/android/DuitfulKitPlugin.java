package com.aydiljoe.duitful.plugins;

import android.app.Activity;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
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
 *   aiStatus /       Gemini Nano through ML Kit's Prompt API: a second
 *   aiReadReceipt    opinion on a receipt the rule-based parser isn't sure of.
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
@CapacitorPlugin(name = "DuitfulKit")
public class DuitfulKitPlugin extends Plugin {

    private static final int MIN_SDK_FOR_ML = Build.VERSION_CODES.O; // 26

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private ActivityResultLauncher<IntentSenderRequest> scanLauncher;
    private PluginCall pendingScan;

    @Override
    public void load() {
        // Must be registered before the activity is STARTED; plugins load
        // during BridgeActivity.onCreate, which is early enough.
        scanLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onScanResult
        );
    }

    /* ---------- Document scanner ---------- */

    @PluginMethod
    public void scanDocument(PluginCall call) {
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
        DuitfulKitEntities.extract(text, call);
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
        DuitfulKitAi.status(getContext(), call);
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
        DuitfulKitAi.readReceipt(getContext(), text, call);
    }
}
