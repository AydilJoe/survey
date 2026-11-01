package com.aydiljoe.duitful.plugins;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * WorkManager's entry point for the split-payment check (DuitfulRelayWatch).
 * Public with the standard constructor: WorkManager creates it by reflection,
 * and duitful-rules.pro keeps everything under the app's package.
 */
public class DuitfulRelayWorker extends Worker {
    public DuitfulRelayWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            DuitfulRelayWatch.check(getApplicationContext());
        } catch (Throwable ignored) {
            // A failed pass is retried on the next period; never crash the app.
        }
        return Result.success();
    }
}
