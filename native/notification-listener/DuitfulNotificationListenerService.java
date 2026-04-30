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
        // Malaysia — banks
        ALLOWED.add("com.mbb.malaysia.android");             // Maybank
        ALLOWED.add("com.maybank2u.life");                   // Maybank MAE
        ALLOWED.add("com.cimb.mob.my");                      // CIMB
        ALLOWED.add("com.cimb.octo");                        // CIMB OCTO
        ALLOWED.add("com.hongleong.cfs.connect");            // Hong Leong
        ALLOWED.add("my.com.rhbgroup.rhbmobilebanking");     // RHB
        ALLOWED.add("my.com.publicbank.pbengine");           // Public Bank
        ALLOWED.add("com.ambank.ambankgroup");               // AmBank
        ALLOWED.add("com.bankislam.android");                // Bank Islam
        ALLOWED.add("com.bsn.mybsn");                        // BSN
        // Malaysia — e-wallets / fuel / BNPL
        ALLOWED.add("my.com.tngdigital.ewallet");            // Touch 'n Go
        ALLOWED.add("my.com.myboost");                       // Boost
        ALLOWED.add("com.bigpay.wallet");                    // BigPay
        ALLOWED.add("com.setel.app");                        // Setel
        ALLOWED.add("com.shopee.my");                        // Shopee / SPayLater
        ALLOWED.add("com.atomeapp.mobile");                  // Atome
        ALLOWED.add("com.grabtaxi.passenger");               // Grab / GrabPay (also SG)
        // Singapore (Atome SG also serves MY users; kept in this region-shared block)
        ALLOWED.add("sg.com.apaylater");                     // Atome SG
        ALLOWED.add("com.dbs.sg.dbsmbanking");               // DBS digibank SG
        ALLOWED.add("com.ocbc.mobile");                      // OCBC SG
        ALLOWED.add("sg.com.uob.mighty.app");                // UOB Mighty
        ALLOWED.add("com.dbs.sg.paylah");                    // DBS PayLah!
        // Indonesia
        ALLOWED.add("com.bca");                              // BCA mobile
        ALLOWED.add("com.bankmandiri.mandiriapp");           // Livin' by Mandiri
        ALLOWED.add("src.com.bni");                          // BNI Mobile
        ALLOWED.add("id.co.bri.brimo");                      // BRImo
        ALLOWED.add("com.gojek.app");                        // GoPay (Gojek)
        ALLOWED.add("com.ovo");                              // OVO
        ALLOWED.add("id.dana");                              // DANA
        ALLOWED.add("com.shopee.id");                        // ShopeePay ID
        // Thailand
        ALLOWED.add("com.kasikorn.retail.mbanking.wap");     // K PLUS
        ALLOWED.add("com.scb.phone");                        // SCB Easy
        ALLOWED.add("com.ktb.netbank");                      // Krungthai NEXT
        ALLOWED.add("com.bbl.mobilebanking");                // Bangkok Bank Mobile
        ALLOWED.add("com.krungsri.kma");                     // KMA Krungsri
        ALLOWED.add("com.ttb.touch");                        // ttb touch
        ALLOWED.add("th.co.truemoney.wallet");               // TrueMoney Wallet
        ALLOWED.add("jp.naver.line.android");                // Rabbit LINE Pay (piggyback — see OPEN_ISSUES)
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
