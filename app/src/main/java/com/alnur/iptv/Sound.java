package com.alnur.iptv;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.audiofx.DynamicsProcessing;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

/**
 * Sound settings (boost 100–200 %, auto-level on/off) + Android's limiter on VLC's audio session.
 * Boost = VLC volume above 100 (PlayerActivity.setBoost); auto-level = VLC normvol+compressor (PlayerActivity.createEngine);
 * the limiter here (DynamicsProcessing, Android 9+) keeps boosted sound from cracking.
 */
final class Sound {
    static final String PREF = "sound";
    static final int DEF_BOOST = 100;
    static final boolean DEF_AUTO = false;

    // ---- saved settings (shared by the player panel and the web Settings page)
    static int boost(Context c) { return clamp(c.getSharedPreferences(PREF, 0).getInt("boost", DEF_BOOST)); }
    static boolean auto(Context c) { return c.getSharedPreferences(PREF, 0).getBoolean("auto", DEF_AUTO); }
    static void save(Context c, int boost, boolean auto) {
        c.getSharedPreferences(PREF, 0).edit().putInt("boost", clamp(boost)).putBoolean("auto", auto).apply();
    }
    static int clamp(int b) { return Math.max(100, Math.min(200, b)); }
    static boolean supported() { return Build.VERSION.SDK_INT >= 28; }

    // ---- live effect
    final int session;
    DynamicsProcessing dp;
    String error;

    Sound(int session) { this.session = session; }

    /** create the effect; false (with {@link #error}) when this device can't do it */
    boolean open() {
        if (!supported()) { error = "needs Android 9 or newer"; return false; }
        try {
            DynamicsProcessing.Config cfg = new DynamicsProcessing.Config.Builder(
                    DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                    false, 0,      // pre-EQ
                    false, 0,      // (auto-level is done by VLC's normaliser now)
                    false, 0,      // post-EQ
                    true)          // limiter
                    .build();
            dp = new DynamicsProcessing(0, session, cfg);
            applyNow();
            dp.setEnabled(true);
            return true;
        } catch (Throwable e) {
            error = e.getClass().getSimpleName() + ": " + e.getMessage();
            dp = null;
            return false;
        }
    }

    void applyNow() {
        if (dp == null) return;
        try {
            // brick-wall limiter just under full scale = clipping protection (always on). VLC's boost (up to 200 %)
            // reaches it as floating-point audio, so loud peaks are pressed down instead of cracking.
            DynamicsProcessing.Limiter lim = new DynamicsProcessing.Limiter(true, true, 0,
                    1f /*attack ms*/, 60f /*release ms*/, 15f /*ratio*/, -1.0f /*threshold dB*/, 0f);
            dp.setLimiterAllChannelsTo(lim);
        } catch (Throwable ignored) { }
    }

    void close() {
        if (dp != null) { try { dp.setEnabled(false); dp.release(); } catch (Throwable ignored) { } dp = null; }
    }
}
