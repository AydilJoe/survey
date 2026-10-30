package com.aydiljoe.duitful.plugins;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.google.mlkit.nl.entityextraction.DateTimeEntity;
import com.google.mlkit.nl.entityextraction.Entity;
import com.google.mlkit.nl.entityextraction.EntityAnnotation;
import com.google.mlkit.nl.entityextraction.EntityExtraction;
import com.google.mlkit.nl.entityextraction.EntityExtractionParams;
import com.google.mlkit.nl.entityextraction.EntityExtractor;
import com.google.mlkit.nl.entityextraction.EntityExtractorOptions;
import com.google.mlkit.nl.entityextraction.MoneyEntity;

import java.util.Arrays;
import java.util.HashSet;
import java.util.TimeZone;

/**
 * ML Kit Entity Extraction, kept in its own class so nothing from the
 * library is loaded on Android 7 (the library needs API 26; see
 * DuitfulKitPlugin). One English extractor for the life of the process; the
 * language model downloads from Google on first use and then works offline.
 */
@RequiresApi(26)
final class DuitfulKitEntities {
    private static EntityExtractor extractor;

    private DuitfulKitEntities() {}

    private static synchronized EntityExtractor client() {
        if (extractor == null) {
            extractor = EntityExtraction.getClient(
                new EntityExtractorOptions.Builder(EntityExtractorOptions.ENGLISH).build());
        }
        return extractor;
    }

    static void extract(String text, PluginCall call) {
        EntityExtractor ex = client();
        ex.downloadModelIfNeeded()
            .addOnFailureListener(e -> call.reject("Model download failed: " + e.getMessage(), "MODEL"))
            .addOnSuccessListener(v -> {
                EntityExtractionParams params = new EntityExtractionParams.Builder(text)
                    .setEntityTypesFilter(new HashSet<>(Arrays.asList(Entity.TYPE_MONEY, Entity.TYPE_DATE_TIME)))
                    .setReferenceTime(System.currentTimeMillis())
                    .setReferenceTimeZone(TimeZone.getDefault())
                    .build();
                ex.annotate(params)
                    .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage()), "ANNOTATE"))
                    .addOnSuccessListener(annotations -> {
                        JSArray money = new JSArray();
                        JSArray dates = new JSArray();
                        for (EntityAnnotation a : annotations) {
                            for (Entity entity : a.getEntities()) {
                                if (entity.getType() == Entity.TYPE_MONEY) {
                                    MoneyEntity m = entity.asMoneyEntity();
                                    JSObject o = new JSObject();
                                    o.put("text", a.getAnnotatedText());
                                    o.put("start", a.getStart());
                                    o.put("end", a.getEnd());
                                    o.put("currency", m.getUnnormalizedCurrency());
                                    o.put("integer", m.getIntegerPart());
                                    o.put("fraction", m.getFractionalPart());
                                    money.put(o);
                                } else if (entity.getType() == Entity.TYPE_DATE_TIME) {
                                    DateTimeEntity d = entity.asDateTimeEntity();
                                    JSObject o = new JSObject();
                                    o.put("text", a.getAnnotatedText());
                                    o.put("start", a.getStart());
                                    o.put("end", a.getEnd());
                                    o.put("timestamp", d.getTimestampMillis());
                                    o.put("hasDay", d.getDateTimeGranularity() >= DateTimeEntity.GRANULARITY_DAY);
                                    dates.put(o);
                                }
                            }
                        }
                        JSObject ret = new JSObject();
                        ret.put("money", money);
                        ret.put("dates", dates);
                        call.resolve(ret);
                    });
            });
    }
}
