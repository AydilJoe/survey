package com.aydiljoe.duitful.plugins;

import android.app.Notification;
import android.content.ComponentName;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Listens to every posted notification and forwards text from a whitelist of
 * banks / e-wallets to the Capacitor plugin. Everything stays on-device.
 *
 * The user MUST enable "Notification access" for this app in system settings
 * (Settings → Apps → Special app access → Notification access). Call
 * NotificationListenerPlugin.openSettings() from JS to jump there.
 *
 * Every matching notification is stored first (DuitfulCaptureStore, encrypted)
 * and the web layer drains the store; the live event is only a nudge to drain
 * now. That way a notification that arrives while the app is closed is kept
 * for the next open instead of being lost.
 */
public class DuitfulNotificationListenerService extends NotificationListenerService {

    private static final Set<String> ALLOWED = new HashSet<>();
    static {
        // Malaysia — banks
        // Ids marked "Play" were checked against play.google.com (gl=MY) in
        // Nov 2026. The older unmarked ids returned 404 there; they are kept
        // (harmless) in case an older install still uses them.
        ALLOWED.add("com.maybank2u.life");                   // MAE by Maybank2u (Play) — Maybank's consumer app
        ALLOWED.add("com.mbb.malaysia.android");             // Maybank (old id)
        ALLOWED.add("com.cimb.cimbocto");                    // CIMB OCTO MY (Play)
        ALLOWED.add("com.cimb.mob.my");                      // CIMB (old id)
        ALLOWED.add("com.cimb.octo");                        // CIMB OCTO (old id)
        ALLOWED.add("my.com.hongleongconnect.mobileconnect");// HLB Connect (Play)
        ALLOWED.add("com.hongleong.cfs.connect");            // Hong Leong (old id)
        ALLOWED.add("com.rhbgroup.rhbmobilebanking");        // RHB Mobile Banking (Play)
        ALLOWED.add("my.com.rhbgroup.rhbmobilebanking");     // RHB (old id)
        ALLOWED.add("com.pbb.mypb");                         // MyPB by Public Bank (Play)
        ALLOWED.add("my.com.publicbank.pbengine");           // Public Bank (old id)
        ALLOWED.add("com.ambank.ambankonline");              // AmOnline (Play)
        ALLOWED.add("com.ambank.ambankgroup");               // AmBank (old id)
        ALLOWED.add("com.bankislam.bimbmobile");             // BIMB Mobile (Play)
        ALLOWED.add("com.bankislam.android");                // Bank Islam (old id)
        ALLOWED.add("com.bsn.mybsn");                        // myBSN (Play)
        ALLOWED.add("my.com.hsbc.hsbcmalaysia");             // HSBC Malaysia (Play)
        ALLOWED.add("com.ocbc.mobilemy");                    // OCBC Malaysia (Play)
        ALLOWED.add("com.uob.mightymy");                     // UOB TMRW Malaysia (Play)
        ALLOWED.add("air.app.scb.breeze.android.main.my.prod"); // SC Mobile Malaysia — Standard Chartered (Play)
        ALLOWED.add("com.alliance.AOPMobileApp");            // allianceonline Mobile (Play)
        ALLOWED.add("com.aop2023");                          // Alliance+ — Alliance Bank (Play)
        ALLOWED.add("com.affin.mobilebanking");              // AffinAlwaysX (Play)
        ALLOWED.add("com.irakyatmob.bkrm");                  // iRakyat Mobile Banking — Bank Rakyat (Play)
        ALLOWED.add("my.com.muamalat.mobile.rib");           // i-Muamalat Mobile — Bank Muamalat (Play)
        ALLOWED.add("com.cedarplus.agro");                   // AGRONet Mobile — Agrobank (Play)
        ALLOWED.add("com.MBSB.Bank.Mobile.Banking");         // MBSB Bank Mobile Banking (Play)
        // Malaysia — digital banks (Play, Nov 2026)
        ALLOWED.add("my.com.gxbank.app");                    // GXBank (Play)
        ALLOWED.add("com.personal.adb");                     // AEON Bank (Play)
        ALLOWED.add("co.myboostbank.boostberhad");           // Boost Bank (Play)
        ALLOWED.add("my.rytbank.app");                       // Ryt Bank (Play)
        // Malaysia — e-wallets / fuel / BNPL
        ALLOWED.add("my.com.tngdigital.ewallet");            // Touch 'n Go eWallet (Play)
        ALLOWED.add("my.com.myboost");                       // Boost (Play)
        ALLOWED.add("com.tpaay.bigpay");                     // BigPay (Play)
        ALLOWED.add("com.bigpay.wallet");                    // BigPay (old id)
        ALLOWED.add("com.setel.mobile");                     // Setel (Play)
        ALLOWED.add("com.setel.app");                        // Setel (old id)
        ALLOWED.add("com.shopee.my");                        // Shopee / SPayLater (Play)
        ALLOWED.add("com.shopeepay.my");                     // ShopeePay — the standalone MY app (Play)
        ALLOWED.add("my.atome.paylater");                    // Atome MY (Play)
        ALLOWED.add("com.atomeapp.mobile");                  // Atome (old id)
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
        // Philippines
        ALLOWED.add("com.bdo.unibank.mobilebanking");        // BDO Mobile
        ALLOWED.add("com.bpi.cmpr");                         // BPI Mobile
        ALLOWED.add("com.metrobank.metroclick");             // Metrobank Mobile
        ALLOWED.add("com.globe.gcash.android");              // GCash
        ALLOWED.add("com.paymaya");                          // Maya / PayMaya
        ALLOWED.add("com.shopee.ph");                        // ShopeePay PH
        // Vietnam
        ALLOWED.add("com.VCB");                              // Vietcombank
        ALLOWED.add("com.vietinbank.ipay");                  // VietinBank iPay
        ALLOWED.add("vn.com.techcombank.bb.app");            // Techcombank Mobile
        ALLOWED.add("com.vnpay.bidv");                       // BIDV SmartBanking
        ALLOWED.add("com.mbmobile");                         // MB Bank
        ALLOWED.add("com.mservice.momotransfer");            // MoMo
        ALLOWED.add("vn.com.vng.zalopay");                   // ZaloPay
        ALLOWED.add("com.shopee.vn");                        // ShopeePay VN
    }

    /**
     * A currency beside a figure: "RM 0.10", "RM1,234.50", "S$5", "Rp. 10.000", "50.00 บาท", "100.000đ", "马币12.50".
     * Only these are stored. Java's \\s does not match a no-break space, which some apps put between "RM" and the figure.
     */
    private static final Pattern AMOUNT = Pattern.compile(
        "(?i)(?:\\bRM|\\bMYR|S\\$|\\bSGD|\\bRp\\.?|\\bIDR|฿|\\bTHB|₱|\\bPHP|\\bPhp|₫|\\bVND|马币|馬幣|令吉|新币|新幣|新元)[\\s\\u00A0\\u202F]*\\d"
        + "|\\d[\\s\\u00A0\\u202F]*(?:₫|\\bVND\\b|đ|บาท|令吉|新元|\\bMYR\\b|\\bRM\\b|\\bSGD\\b|\\bTHB\\b|\\bPHP\\b|\\bIDR\\b)");

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        capture(sbn);
    }

    /**
     * After Android (re)binds the listener — at boot, after an OEM battery
     * manager unbound it, after notification access is toggled — pick up what
     * is still in the shade from the whitelisted apps. The store skips any it
     * already holds.
     */
    @Override
    public void onListenerConnected() {
        DuitfulCaptureDiag.connected(getApplicationContext(), true);
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active != null) for (StatusBarNotification sbn : active) capture(sbn);
        } catch (Exception ignored) {}
    }

    /**
     * Some OEM battery managers (Vivo / OriginOS among them) unbind listeners.
     * Ask to be bound again; Android ignores this if access was revoked.
     */
    @Override
    public void onListenerDisconnected() {
        DuitfulCaptureDiag.connected(getApplicationContext(), false);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                requestRebind(new ComponentName(this, DuitfulNotificationListenerService.class));
            }
        } catch (Exception ignored) {}
    }

    private void capture(StatusBarNotification sbn) {
        try {
            if (sbn == null) return;
            String pkg = sbn.getPackageName();
            if (pkg == null) return;
            boolean allowed = ALLOWED.contains(pkg);
            // Not on the list: noted (package only) when it looks like money,
            // so a bank app with an unexpected id shows up in the check.
            if (!allowed && !looksLikeMoney(sbn)) return;
            Notification n = sbn.getNotification();
            if (n == null) return;
            Bundle extras = n.extras;
            if (extras == null) return;

            // The longest of the ways apps and OEM skins carry the body:
            // EXTRA_TEXT, EXTRA_BIG_TEXT (BigTextStyle), EXTRA_TEXT_LINES
            // (InboxStyle, common for grouped alerts).
            String text = str(extras.getCharSequence(Notification.EXTRA_TEXT));
            String big = str(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
            if (big.length() > text.length()) text = big;
            CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null && lines.length > 0) {
                StringBuilder sb = new StringBuilder();
                for (CharSequence line : lines) {
                    if (line == null) continue;
                    if (sb.length() > 0) sb.append('\n');
                    sb.append(line);
                }
                if (sb.length() > text.length()) text = sb.toString();
            }
            String title = str(extras.getCharSequence(Notification.EXTRA_TITLE_BIG));
            if (title.isEmpty()) title = str(extras.getCharSequence(Notification.EXTRA_TITLE));
            if (!allowed) { DuitfulCaptureDiag.note(getApplicationContext(), pkg, "not on the list"); return; }
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0 && !AMOUNT.matcher(title + " " + text).find()) return;
            if (text.isEmpty() && title.isEmpty()) { DuitfulCaptureDiag.note(getApplicationContext(), pkg, "empty"); return; }
            // No amount, nothing to log: promos and "share your feedback"
            // messages are never stored.
            if (!AMOUNT.matcher(title + " " + text).find()) { DuitfulCaptureDiag.note(getApplicationContext(), pkg, "no amount"); return; }

            long when = sbn.getPostTime() > 0 ? sbn.getPostTime() : System.currentTimeMillis();
            int stored = DuitfulCaptureStore.append(getApplicationContext(), pkg, title, text, sbn.getKey(), when);
            DuitfulCaptureDiag.note(getApplicationContext(), pkg,
                stored == DuitfulCaptureStore.STORED ? "stored" : stored == DuitfulCaptureStore.SEEN ? "already stored" : "store failed");
            // If the encrypted store failed, hand the text to an open app
            // directly rather than nudging it to drain an empty store.
            NotificationListenerPlugin.emit(pkg, title, text, stored != DuitfulCaptureStore.FAILED);
            // "1 to review" on the persistent notification, with the app closed.
            if (stored == DuitfulCaptureStore.STORED) DuitfulQuickAddNotifier.refresh(getApplicationContext());
        } catch (Exception ignored) {}
    }

    private static boolean looksLikeMoney(StatusBarNotification sbn) {
        try {
            Notification n = sbn.getNotification();
            if (n == null || n.extras == null) return false;
            Bundle e = n.extras;
            String all = str(e.getCharSequence(Notification.EXTRA_TITLE)) + " " + str(e.getCharSequence(Notification.EXTRA_TEXT))
                + " " + str(e.getCharSequence(Notification.EXTRA_BIG_TEXT));
            return AMOUNT.matcher(all).find();
        } catch (Exception e) {
            return false;
        }
    }

    private static String str(CharSequence cs) {
        return cs == null ? "" : cs.toString();
    }

    @Override public void onNotificationRemoved(StatusBarNotification sbn) {}
}
