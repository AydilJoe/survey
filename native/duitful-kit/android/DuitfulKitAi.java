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

    // A bank / e-wallet notification the rule-based parser couldn't place.
    // The model only labels it; the app takes the amount from the text itself.
    private static final String ALERT_INSTRUCTIONS =
        "You read one notification from a Malaysian bank or e-wallet app. "
            + "Reply with one JSON object and nothing else: "
            + "{\"direction\": \"spend\" or \"income\" or \"move\" or \"ignore\", \"counterparty\": string, "
            + "\"category\": string, \"is_promo_or_security\": true or false}. "
            + "spend: money left the user's account. income: money arrived. move: the user moved money between their own accounts. "
            + "ignore: not a completed transaction. is_promo_or_security is true for adverts, surveys, OTPs, codes and login alerts. "
            + "counterparty is the shop or person exactly as written, or \"\". category is one of: ";
    private static final int MAX_ALERT_CHARS = 600;

    // One Talk to Kira item the voice rules weren't sure of (1.93.0). The
    // model labels the words only; the app keeps its own amount and drops a
    // category not in its list or a note that isn't the item's own words.
    private static final String VOICE_INSTRUCTIONS =
        "You label one short money note a person said to a Malaysian personal finance app. "
            + "Reply with one JSON object and nothing else: "
            + "{\"direction\": \"spend\" or \"income\" or \"\", \"category\": string, \"note\": string}. "
            + "spend: the person paid for something. income: money came to the person (pay, freelance work, a gift, a refund, money found). "
            + "Use \"\" if unsure. note is two to four words copied from the text naming what it was, without the amount. "
            + "Never write a number. category is one of: ";
    private static final int MAX_VOICE_CHARS = 200;

    // The monthly recap: the app computes every figure and sends them as
    // lines; the model only rewords. The app throws the answer away if it
    // carries a number the facts don't (recapTextOk in recap.js).
    private static final String RECAP_INSTRUCTIONS =
        "You write a short monthly spending recap for a personal finance app. "
            + "Use only the facts below. Write two or three short sentences in plain, friendly English, not formal. "
            + "Copy every number exactly as written in the facts. Do not calculate, round, or add any number or percentage. "
            + "Describe only; do not give advice or suggestions. No greeting, no emoji, no lists.\n\nFacts:\n";
    private static final int MAX_RECAP_CHARS = 1200;

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
        generate(ctx, INSTRUCTIONS + body, 128, call);
    }

    /** Labels one notification: direction, counterparty, category, promo/security. */
    static void readAlert(Context ctx, String text, String categories, PluginCall call) {
        String body = text.length() > MAX_ALERT_CHARS ? text.substring(0, MAX_ALERT_CHARS) : text;
        String cats = categories == null ? "" : categories;
        if (cats.length() > 300) cats = cats.substring(0, 300);
        generate(ctx, ALERT_INSTRUCTIONS + cats + ", or \"\".\n\nNotification:\n" + body, 96, call);
    }

    /** Labels one voice item: direction, category, note. Never an amount. */
    static void readVoice(Context ctx, String text, String categories, PluginCall call) {
        String body = text.length() > MAX_VOICE_CHARS ? text.substring(0, MAX_VOICE_CHARS) : text;
        String cats = categories == null ? "" : categories;
        if (cats.length() > 500) cats = cats.substring(0, 500);
        generate(ctx, VOICE_INSTRUCTIONS + cats + ", or \"\".\n\nText:\n" + body, 64, call);
    }

    /** The monthly recap reworded from the app's own fact lines. */
    static void writeRecap(Context ctx, String facts, PluginCall call) {
        String body = facts.length() > MAX_RECAP_CHARS ? facts.substring(0, MAX_RECAP_CHARS) : facts;
        generate(ctx, RECAP_INSTRUCTIONS + body, 160, call);
    }

    /** One prompt in, the model's text out as {json}. Shared by both readers. */
    private static void generate(Context ctx, String prompt, int maxTokens, PluginCall call) {
        GenerateContentRequest.Builder builder = new GenerateContentRequest.Builder(new TextPart(prompt));
        builder.setTemperature(0f);
        builder.setMaxOutputTokens(maxTokens);
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
