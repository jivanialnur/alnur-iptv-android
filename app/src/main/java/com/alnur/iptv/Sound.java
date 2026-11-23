package com.alnur.iptv;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.audiofx.DynamicsProcessing;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

/**
 * Volume boost (100–200 %) + Auto-level, done by Android's own audio engine (DynamicsProcessing, Android 9+)
 * on VLC's audio session. Chain: input gain (boost) → 1-band compressor (auto-level) → limiter (no clipping, always on).
 * The phone/tablet volume buttons keep working as before – this sits on top of them.
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
    final Handler h = new Handler(Looper.getMainLooper());
    // current (ramped) values
    float gainDb = 0, ratio = 1, threshold = 0, post = 0;
    // targets
    float tGainDb = 0, tRatio = 1, tThreshold = 0, tPost = 0;

    Sound(int session) { this.session = session; }

    /** create the effect; false (with {@link #error}) when this device can't do it */
    boolean open() {
        if (!supported()) { error = "needs Android 9 or newer"; return false; }
        try {
            DynamicsProcessing.Config cfg = new DynamicsProcessing.Config.Builder(
                    DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                    false, 0,      // pre-EQ
                    true, 1,       // 1-band compressor = auto-level
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

    /** set targets from the settings; values glide there in ~1.5 s (no sudden jump in loudness) */
    void set(int boostPct, boolean autoLevel, boolean instant) {
        tGainDb = (float) (20 * Math.log10(clamp(boostPct) / 100.0));   // 100 % = 0 dB, 200 % = +6 dB
        if (autoLevel) { tThreshold = -30f; tRatio = 4f; tPost = 9f; }   // squeeze loud parts (ads), lift quiet channels
        else { tThreshold = 0f; tRatio = 1f; tPost = 0f; }               // compressor does nothing
        if (instant) { gainDb = tGainDb; ratio = tRatio; threshold = tThreshold; post = tPost; applyNow(); }
        else { h.removeCallbacks(step); h.post(step); }
    }

    final Runnable step = new Runnable() {
        @Override public void run() {
            float k = 0.12f; // per 50 ms → ~1.5 s glide
            gainDb += (tGainDb - gainDb) * 0.35f; // the slider itself should feel quick
            ratio += (tRatio - ratio) * k;
            threshold += (tThreshold - threshold) * k;
            post += (tPost - post) * k;
            boolean done = Math.abs(tGainDb - gainDb) < 0.05f && Math.abs(tRatio - ratio) < 0.02f
                    && Math.abs(tThreshold - threshold) < 0.1f && Math.abs(tPost - post) < 0.05f;
            if (done) { gainDb = tGainDb; ratio = tRatio; threshold = tThreshold; post = tPost; }
            applyNow();
            if (!done) h.postDelayed(this, 50);
        }
    };

    void applyNow() {
        if (dp == null) return;
        try { dp.setInputGainAllChannelsTo(gainDb); } catch (Throwable ignored) { }
        try {
            // slow attack/release: the level moves gently, ads don't "jump"; noise gate keeps silence/hiss from being lifted
            DynamicsProcessing.MbcBand band = new DynamicsProcessing.MbcBand(true, 24000f,
                    60f /*attack ms*/, 1200f /*release ms*/, ratio, threshold, 8f /*knee dB*/,
                    -70f /*noise gate dB*/, 1f /*expander*/, 0f /*pre gain*/, post);
            dp.setMbcBandAllChannelsTo(0, band);
        } catch (Throwable ignored) { }
        try {
            // brick-wall limiter just under full scale = clipping protection (always on)
            DynamicsProcessing.Limiter lim = new DynamicsProcessing.Limiter(true, true, 0,
                    1f /*attack ms*/, 80f /*release ms*/, 12f /*ratio*/, -1.5f /*threshold dB*/, 0f);
            dp.setLimiterAllChannelsTo(lim);
        } catch (Throwable ignored) { }
    }

    void close() {
        h.removeCallbacks(step);
        if (dp != null) { try { dp.setEnabled(false); dp.release(); } catch (Throwable ignored) { } dp = null; }
    }
}
