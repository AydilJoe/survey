package com.aydiljoe.duitful.plugins;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens a message from a split bill's encrypted mailbox, exactly as
 * app/split.js seals it: AES-GCM with the bill's 128-bit key, the first 12
 * bytes are the IV, the last 16 the tag, and "duitful-relay/1/<kind>/<id>"
 * is the associated data. Plain javax.crypto and no Android classes, so it
 * can be tested off-device.
 */
final class DuitfulRelayCrypto {
    private DuitfulRelayCrypto() {}

    /** The plaintext, or null when the message wasn't sealed with this key. */
    static byte[] open(byte[] key, byte[] sealed, String mailboxId, String kind) {
        if (key == null || key.length != 16 || sealed == null || sealed.length < 12 + 16) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                new GCMParameterSpec(128, Arrays.copyOfRange(sealed, 0, 12)));
            cipher.updateAAD(("duitful-relay/1/" + kind + "/" + mailboxId).getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(sealed, 12, sealed.length - 12);
        } catch (Exception e) {
            return null;
        }
    }
}
