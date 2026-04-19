package com.aydiljoe.duitful.plugins;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.HashSet;
import java.util.Set;

/**
 * Listens to every posted notification and forwards text from a whitelist of
 * banks / e-wallets to the Capacitor plugin. Everything stays on-device.
 *
 * The user MUST enable "Notification access" for this app in system settings
 * (Settings → Apps → Special app access → Notification access). Call
 * NotificationListenerPlugin.openSettings() from JS to jump there.
 */
public class DuitfulNotificationListenerService extends NotificationListenerService {

    private static final Set<String> ALLOWED = new HashSet<>();
    static {
        // Malaysian banks
        ALLOWED.add("com.mbb.malaysia.android");             // Maybank
        ALLOWED.add("com.cimb.mob.my");                      // CIMB
        ALLOWED.add("com.cimb.cimbocto");                    // CIMB (octo)
        ALLOWED.add("com.hongleong.connectfirst");           // Hong Leong
        ALLOWED.add("my.com.rhbgroup.rhbmobilebanking");     // RHB
        ALLOWED.add("my.com.publicbank.pbengine");           // Public Bank
        // E-wallets
        ALLOWED.add("my.com.tngdigital.ewallet");            // Touch 'n Go
        ALLOWED.add("com.grabtaxi.passenger");               // Grab / GrabPay
        ALLOWED.add("my.com.myboost");                       // Boost
        ALLOWED.add("com.bigpay.wallet");                    // BigPay
        // BNPL
        ALLOWED.add("com.shopee.my");                        // Shopee / SPayLater
        ALLOWED.add("com.atomeapp.mobile");                  // Atome
        ALLOWED.add("sg.com.apaylater");                     // Atome SG
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String pkg = sbn.getPackageName();
            if (pkg == null || !ALLOWED.contains(pkg)) return;
            Notification n = sbn.getNotification();
            if (n == null) return;
            Bundle extras = n.extras;
            if (extras == null) return;

            CharSequence cs = extras.getCharSequence(Notification.EXTRA_TEXT);
            String text = cs == null ? "" : cs.toString();
            CharSequence big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (big != null && big.length() > text.length()) text = big.toString();
            CharSequence title = extras.getCharSequence(Notification.EXTRA_TITLE);
            if (text.isEmpty() && title == null) return;

            NotificationListenerPlugin.emit(pkg, title == null ? "" : title.toString(), text);
        } catch (Exception ignored) {}
    }

    @Override public void onNotificationRemoved(StatusBarNotification sbn) {}
}
