package com.aydiljoe.duitful.plugins;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.concurrent.ExecutorService;

/**
 * Unbundled ML Kit Text Recognition v2 (Play Services) for DuitfulKit.recognizeText
 * on Android (since 1.68.1).
 *
 * Replaces @pantrist/capacitor-plugin-ml-kit-text-recognition so the heavy OCR
 * models live in Google Play services instead of being bundled into the APK,
 * and adds Chinese + Latin script recognition for Malaysian receipts.
 *
 * Returns the exact same JSON shape as iOS DuitfulTextReader.swift and the
 * legacy plugin so app/ocr.js consumes it unchanged:
 *   { text, blocks: [{ text, boundingBox, recognizedLanguage,
 *                      lines: [{ text, boundingBox, recognizedLanguage,
 *                                elements: [{ text, boundingBox, recognizedLanguage }] }] }] }
 */
final class DuitfulKitTextReader {
    private static final String TAG = "DuitfulKit";

    private DuitfulKitTextReader() {}

    static void recognize(PluginCall call, ExecutorService io) {
        final String raw = call.getString("base64Image", "");
        final int rot = normalizeRotation(call.getInt("rotation", 0));
        if (raw == null || raw.trim().isEmpty()) {
            call.reject("Missing base64Image", "IMAGE");
            return;
        }
        io.execute(() -> {
            Bitmap bmp = decodeBitmap(raw);
            if (bmp == null) {
                call.reject("Unable to read the image", "IMAGE");
                return;
            }
            InputImage image = InputImage.fromBitmap(bmp, rot);
            // Try Chinese + Latin first (handles Malaysian EN/BM/ZH receipts in one pass).
            // If Play Services hasn't downloaded the Chinese module yet or is offline,
            // fall back cleanly to the Latin recognizer.
            runChineseThenLatin(image, bmp, call);
        });
    }

    private static void runChineseThenLatin(InputImage image, Bitmap bmp, PluginCall call) {
        final TextRecognizer zh;
        try {
            zh = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        } catch (Throwable e) {
            runLatin(image, bmp, call);
            return;
        }
        zh.process(image)
            .addOnSuccessListener(result -> {
                closeQuietly(zh);
                recycleQuietly(bmp);
                call.resolve(toJson(result));
            })
            .addOnFailureListener(err -> {
                closeQuietly(zh);
                Log.w(TAG, "Chinese ML Kit OCR unavailable, falling back to Latin: " + err.getMessage());
                runLatin(image, bmp, call);
            });
    }

    private static void runLatin(InputImage image, Bitmap bmp, PluginCall call) {
        final TextRecognizer latin;
        try {
            latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        } catch (Throwable e) {
            recycleQuietly(bmp);
            call.reject(String.valueOf(e.getMessage()), "OCR");
            return;
        }
        latin.process(image)
            .addOnSuccessListener(result -> {
                closeQuietly(latin);
                recycleQuietly(bmp);
                call.resolve(toJson(result));
            })
            .addOnFailureListener(err -> {
                closeQuietly(latin);
                recycleQuietly(bmp);
                call.reject(String.valueOf(err.getMessage()), "OCR");
            });
    }

    private static Bitmap decodeBitmap(String raw) {
        try {
            String body = raw.trim();
            if (body.regionMatches(true, 0, "data:", 0, 5)) {
                int comma = body.indexOf(',');
                body = comma >= 0 ? body.substring(comma + 1) : "";
            }
            byte[] bytes = Base64.decode(body, Base64.DEFAULT);
            if (bytes == null || bytes.length == 0) return null;
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Throwable e) {
            return null;
        }
    }

    private static int normalizeRotation(int deg) {
        int r = ((deg % 360) + 360) % 360;
        if (r == 90 || r == 180 || r == 270) return r;
        return 0;
    }

    private static JSObject toJson(Text text) {
        JSArray blocks = new JSArray();
        if (text != null) {
            for (Text.TextBlock b : text.getTextBlocks()) {
                JSArray lines = new JSArray();
                for (Text.Line l : b.getLines()) {
                    JSArray elements = new JSArray();
                    for (Text.Element el : l.getElements()) {
                        JSObject eo = new JSObject();
                        eo.put("text", el.getText());
                        putBox(eo, el.getBoundingBox());
                        eo.put("recognizedLanguage", el.getRecognizedLanguage());
                        elements.put(eo);
                    }
                    JSObject lo = new JSObject();
                    lo.put("text", l.getText());
                    putBox(lo, l.getBoundingBox());
                    lo.put("recognizedLanguage", l.getRecognizedLanguage());
                    lo.put("elements", elements);
                    lines.put(lo);
                }
                JSObject bo = new JSObject();
                bo.put("text", b.getText());
                putBox(bo, b.getBoundingBox());
                bo.put("recognizedLanguage", b.getRecognizedLanguage());
                bo.put("lines", lines);
                blocks.put(bo);
            }
        }
        JSObject out = new JSObject();
        out.put("text", text != null ? text.getText() : "");
        out.put("blocks", blocks);
        return out;
    }

    private static void putBox(JSObject target, Rect rect) {
        if (rect == null) return;
        JSObject b = new JSObject();
        b.put("left", rect.left);
        b.put("top", rect.top);
        b.put("right", rect.right);
        b.put("bottom", rect.bottom);
        target.put("boundingBox", b);
    }

    private static void closeQuietly(TextRecognizer r) {
        try { r.close(); } catch (Throwable ignored) {}
    }

    private static void recycleQuietly(Bitmap bmp) {
        try { if (bmp != null && !bmp.isRecycled()) bmp.recycle(); } catch (Throwable ignored) {}
    }
}
