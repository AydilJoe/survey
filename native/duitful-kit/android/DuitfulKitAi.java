package com.aydiljoe.duitful.plugins;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.genai.common.DownloadCallback;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.GenAiException;
import com.google.mlkit.genai.prompt.Candidate;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import com.google.mlkit.genai.prompt.Generation;
import com.google.mlkit.genai.prompt.TextPart;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;

import java.util.List;
import java.util.concurrent.Executor;

/**
 * Gemini Nano through ML Kit's Prompt API (beta), kept in its own class so
 * nothing from the library loads on Android 7. Gemini Nano lives in the
 * system's AICore on a short list of recent phones; everywhere else
 * checkStatus() says UNAVAILABLE and the web layer keeps its own parser.
 *
 * The model reads text the phone already has (the receipt's OCR) and
 * answers with JSON. Nothing leaves the device. When the model is
 * DOWNLOADABLE we ask AICore to fetch it in the background once and report
 * "not yet"; the next scan after the download finishes can use it.
 */
@RequiresApi(26)
final class DuitfulKitAi {
    private static GenerativeModelFutures model;
    private static boolean downloadRequested;

    // Kept short: Gemini Nano has a small context, and receipts are long.
    private static final String INSTRUCTIONS =
        "You read the OCR text of a shop receipt, usually from Malaysia. "
            + "Reply with one JSON object and nothing else: "
            + "{\"total\": number or null, \"merchant\": string, \"date\": \"YYYY-MM-DD\" or \"\", \"currency\": ISO code or \"\"}. "
            + "total is the final amount the customer paid after tax, service charge and rounding. "
            + "It is never the cash handed over, the change, a subtotal, or a savings line. "
            + "merchant is the shop or company name without its registration number.\n\nReceipt:\n";
    private static final int MAX_CHARS = 3000;

    private DuitfulKitAi() {}

    private static synchronized GenerativeModelFutures client() {
        if (model == null) model = GenerativeModelFutures.from(Generation.INSTANCE.getClient());
        return model;
    }

    private static Executor main(Context ctx) {
        return ContextCompat.getMainExecutor(ctx);
    }

    static void status(Context ctx, PluginCall call) {
        ListenableFuture<Integer> f;
        try {
            f = client().checkStatus();
        } catch (Throwable t) {
            resolveStatus(call, false, "error");
            return;
        }
        f.addListener(() -> {
            int s;
            try {
                Integer v = f.get();
                s = v == null ? FeatureStatus.UNAVAILABLE : v;
            } catch (Exception e) {
                resolveStatus(call, false, "error");
                return;
            }
            if (s == FeatureStatus.AVAILABLE) {
                resolveStatus(call, true, "");
            } else if (s == FeatureStatus.DOWNLOADABLE) {
                requestDownload();
                resolveStatus(call, false, "downloading");
            } else if (s == FeatureStatus.DOWNLOADING) {
                resolveStatus(call, false, "downloading");
            } else {
                resolveStatus(call, false, "unsupported");
            }
        }, main(ctx));
    }

    private static synchronized void requestDownload() {
        if (downloadRequested) return;
        downloadRequested = true;
        try {
            client().download(new DownloadCallback() {
                @Override
                public void onDownloadFailed(@NonNull GenAiException e) {
                    synchronized (DuitfulKitAi.class) { downloadRequested = false; }
                }
            });
        } catch (Throwable t) {
            downloadRequested = false;
        }
    }

    private static void resolveStatus(PluginCall call, boolean available, String reason) {
        JSObject ret = new JSObject();
        ret.put("available", available);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    static void readReceipt(Context ctx, String text, PluginCall call) {
        String body = text.length() > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;
        GenerateContentRequest.Builder builder = new GenerateContentRequest.Builder(new TextPart(INSTRUCTIONS + body));
        builder.setTemperature(0f);
        builder.setMaxOutputTokens(128);
        ListenableFuture<GenerateContentResponse> f;
        try {
            f = client().generateContent(builder.build());
        } catch (Throwable t) {
            call.reject(String.valueOf(t.getMessage()), "AI");
            return;
        }
        f.addListener(() -> {
            try {
                GenerateContentResponse res = f.get();
                List<Candidate> candidates = res == null ? null : res.getCandidates();
                String out = candidates == null || candidates.isEmpty() ? "" : candidates.get(0).getText();
                JSObject ret = new JSObject();
                ret.put("json", out == null ? "" : out);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "AI");
            }
        }, main(ctx));
    }
}
