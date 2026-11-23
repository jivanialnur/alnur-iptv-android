package com.alnur.iptv;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Environment;
import android.widget.ImageView;
import android.widget.Toast;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;
import java.util.Locale;

/** Full-screen player built on VLC (plays AC3 / MP2 / HEVC / interlaced TS that the PC app had to convert). */
public class PlayerActivity extends Activity {
    static String pending;   // JSON from the web UI: {items:[{name,num,kind,url,sub,key,start}], index, ua}
    static String result;    // JSON back to the web UI

    static class Item { String name, num, kind, url, sub, key; long start; long lastPos = -1, lastDur = -1; }

    final ArrayList<Item> items = new ArrayList<>();
    int index;
    String ua = "VLC/3.0.21 LibVLC/3.0.21";
    boolean autoNext;

    LibVLC vlc;
    MediaPlayer mp;
    VLCVideoLayout videoLayout;
    final Handler h = new Handler(Looper.getMainLooper());

    FrameLayout root, controls;
    TextView title, subtitle, curTime, durTime, osd, msg, liveBadge, liveBadge2;
    LinearLayout row1;
    View aspectBtn, panelView;
    static PlayerActivity current; // the one playing now (a new channel closes the old one, also when it is minimised)
    boolean pipActive, stoppedNow;
    ImageView playBtn, prevBtn, nextBtn, backBtn, numBtn, muteBtn;
    View rwBtn, ffBtn, linkBtn, dlBtn, openBtn;
    LinearLayout bottomBar;
    SeekBar seek, vol;
    boolean stoppedForOther;
    final Blur blur = new Blur();
    int audioSession;
    Sound sound;
    GlassView soundPanel;      // (old 🔊 panel – removed, kept null)
    int boost = 100;           // 100–200: extra volume above the tablet's maximum (VLC amplifies)
    boolean autoLevelOn, warned150, capBar;
    SeekBar boostSeek;
    TextView boostVal, boostWarn, soundNote;
    android.widget.Switch autoSw;   // blurred video copy for the glass panels
    GlassView osdBox, msgBox; // playback stopped so Download / another app can use the 1 connection
    ProgressBar spinner;
    boolean seeking, controlsShown = true, ended;
    int scaleMode = 0;
    float density;
    AudioManager audio;
    int retries;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        density = getResources().getDisplayMetrics().density;
        audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        parse();
        if (items.isEmpty()) { finish(); return; }
        if (current != null && current != this) { try { current.finishWithResult(); } catch (Exception ignored) { } } // old (maybe minimised) player frees the connection
        current = this;
        buildUi();
        hideSystemBars();
        audioSession = audio.generateAudioSessionId();
        sound = new Sound(audioSession);
        sound.open();                               // limiter on the tablet's sound output (stops cracking when boosted)
        boost = Sound.boost(this);
        createEngine();
        playIndex(index, true);
        h.post(ticker);
        h.post(glassTick);
    }

    void parse() {
        try {
            JSONObject o = new JSONObject(pending == null ? "{}" : pending);
            JSONArray a = o.optJSONArray("items");
            if (a != null) for (int i = 0; i < a.length(); i++) {
                JSONObject j = a.getJSONObject(i);
                Item it = new Item();
                it.name = j.optString("name"); it.num = j.optString("num"); it.kind = j.optString("kind");
                it.url = j.optString("url"); it.sub = j.optString("sub"); it.key = j.optString("key");
                it.start = (long) (j.optDouble("start", 0) * 1000);
                items.add(it);
            }
            index = Math.max(0, Math.min(items.size() - 1, o.optInt("index", 0)));
            ua = o.optString("ua", ua);
            autoNext = o.optBoolean("autoNext", false);
        } catch (Exception ignored) { }
    }

    /** VLC engine. Auto-level = VLC's volume normaliser + a gentle compressor (these are fixed when the engine starts). */
    void createEngine() {
        ArrayList<String> opts = new ArrayList<>();
        opts.add("--http-reconnect");
        opts.add("--deinterlace=-1");
        opts.add("--deinterlace-mode=yadif");
        opts.add("--audio-time-stretch");
        // stats stay ON: the grey "buffered" part of the seek bar is worked out from them
        // own audio session: Android's limiter is attached to it (see Sound)
        opts.add("--aout=android_audiotrack");
        opts.add("--audiotrack-session-id=" + audioSession);
        autoLevelOn = Sound.auto(this);
        if (autoLevelOn) {
            opts.add("--audio-filter=normvol:compressor");
            opts.add("--norm-buff-size=20");      // looks at the last ~0.5 s
            opts.add("--norm-max-level=1.6");     // loud parts (ads) are pulled down to this
            opts.add("--compressor-rms-peak=0.0"); // react to loudness, not single peaks
            opts.add("--compressor-attack=50");
            opts.add("--compressor-release=800"); // slow: no pumping / sudden jumps
            opts.add("--compressor-threshold=-24");
            opts.add("--compressor-ratio=3");
            opts.add("--compressor-knee=6");
            opts.add("--compressor-makeup-gain=7"); // quiet channels come up
        }
        vlc = new LibVLC(this, opts);
        mp = new MediaPlayer(vlc);
        mp.attachViews(videoLayout, null, true, true); // TextureView: lets the glass panels blur the picture behind them
        mp.setEventListener(this::onVlcEvent);
    }

    /** switch auto-level while watching: new engine, continue where we were */
    void restartEngine() {
        long pos = isLive() ? 0 : Math.max(0, mp.getTime());
        try { mp.setEventListener(null); mp.stop(); mp.detachViews(); mp.release(); } catch (Exception ignored) { }
        try { vlc.release(); } catch (Exception ignored) { }
        createEngine();
        blur.texture = null;
        retries = 0;
        h.postDelayed(() -> start(cur().url, pos), 700); // the server needs a moment to free the single connection
    }

    Item cur() { return items.get(index); }
    boolean isLive() { String k = cur().kind; return "live".equals(k); }

    // ------------------------------------------------------------------ playback
    void playIndex(int i, boolean first) {
        if (!first) savePos();
        index = i;
        ended = false; retries = 0; aheadSmooth = 0;
        Item it = cur();
        title.setText((isLive() && !it.num.isEmpty() ? it.num + "  ·  " : "") + it.name);
        subtitle.setText(it.sub);
        boolean live = isLive();
        rwBtn.setVisibility(live ? View.GONE : View.VISIBLE);
        ffBtn.setVisibility(live ? View.GONE : View.VISIBLE);
        seek.setVisibility(live ? View.INVISIBLE : View.VISIBLE);
        liveBadge.setVisibility(View.GONE);
        liveBadge2.setVisibility(live ? View.VISIBLE : View.GONE);
        row1.setVisibility(live ? View.GONE : View.VISIBLE);           // live: no empty seek row – a slim bar
        bottomBar.setPadding(dp(18), dp(live ? 3 : 6), dp(18), dp(3));
        durTime.setVisibility(live ? View.GONE : View.VISIBLE);
        curTime.setVisibility(live ? View.GONE : View.VISIBLE);
        numBtn.setVisibility(live ? View.VISIBLE : View.GONE);
        dlBtn.setVisibility(live ? View.GONE : View.VISIBLE);
        boolean many = items.size() > 1;
        prevBtn.setAlpha(many ? 1f : 0.3f); nextBtn.setAlpha(many ? 1f : 0.3f);
        curTime.setText(""); durTime.setText("");
        msgBox.setVisibility(View.GONE);
        start(it.url, live ? 0 : it.start);
        showControls();
    }

    void start(String url, long startMs) {
        stoppedForOther = false;
        spinner.setVisibility(View.VISIBLE);
        try { mp.stop(); } catch (Exception ignored) { }
        Media m = new Media(vlc, Uri.parse(url));
        m.setHWDecoderEnabled(true, false);
        m.addOption(":http-user-agent=" + ua);
        m.addOption(":network-caching=" + (isLive() ? 2000 : 3000));
        m.addOption(":http-reconnect");
        if (startMs > 5000) m.addOption(":start-time=" + (startMs / 1000.0));
        mp.setMedia(m);
        m.release();
        mp.play();
        if (startMs > 5000) toast(String.format(Locale.US, "Resumed from %d min", startMs / 60000));
    }

    void onVlcEvent(MediaPlayer.Event e) {
        switch (e.type) {
            case MediaPlayer.Event.Buffering:
                spinner.setVisibility(e.getBuffering() < 100f ? View.VISIBLE : View.GONE);
                break;
            case MediaPlayer.Event.Playing:
                mp.setVolume(boost);
                spinner.setVisibility(View.GONE);
                setPlayIcon(true);
                msgBox.setVisibility(View.GONE);
                break;
            case MediaPlayer.Event.Paused:
                setPlayIcon(false);
                break;
            case MediaPlayer.Event.Vout:
                if (e.getVoutCount() > 0) { spinner.setVisibility(View.GONE); applyScale(); }
                break;
            case MediaPlayer.Event.EndReached:
                onEnded();
                break;
            case MediaPlayer.Event.EncounteredError:
                onError();
                break;
            default:
                break;
        }
    }

    void onEnded() {
        if (isLive()) { // a live stream should never end: reconnect
            if (retries++ < 5) { h.postDelayed(() -> start(cur().url, 0), 800); return; }
            showMsg("The channel stopped. Tap ⟳ to try again.");
            return;
        }
        ended = true;
        Item it = cur();
        it.lastPos = 0; it.lastDur = Math.max(it.lastDur, mp.getLength() / 1000);
        if (autoNext && index + 1 < items.size()) {
            toast("Next episode…");
            h.postDelayed(() -> playIndex(index + 1, false), 1500);
        } else {
            setPlayIcon(false);
            showControls();
        }
    }

    void onError() {
        spinner.setVisibility(View.GONE);
        if (retries++ < 3) { // the server often says "busy" for a moment after changing channel
            h.postDelayed(() -> start(cur().url, isLive() ? 0 : Math.max(0, mp.getTime())), 700L * retries);
            return;
        }
        showMsg("Could not play this " + (isLive() ? "channel" : "video") + ".\nThe server may be busy or the stream is offline.\nTap ⟳ to try again.");
    }

    void showMsg(String t) { msg.setText(t + "\n\n⟳  Retry"); msgBox.setVisibility(View.VISIBLE); showControls(); }

    final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (mp != null && !isLive()) {
                long t = mp.getTime(), d = mp.getLength();
                if (d > 0) {
                    if (!seeking) { seek.setMax((int) (d / 1000)); seek.setProgress((int) (t / 1000)); }
                    seek.setSecondaryProgress((int) (Math.min(d, t + bufferedAheadMs()) / 1000));
                    curTime.setText(fmt(t / 1000)); durTime.setText(fmt(d / 1000));
                    Item it = cur();
                    if (!ended && t > 0) { it.lastPos = t / 1000; it.lastDur = d / 1000; }
                }
            }
            h.postDelayed(this, 500);
        }
    };

    /** How far ahead of the playing point VLC already has the video (grey part of the seek bar).
     *  = network cache VLC keeps (3 s) + data read from the server but not yet used (stats: read − demuxed bytes ÷ bitrate). */
    long aheadSmooth = 0;
    long bufferedAheadMs() {
        long ahead = 0;
        try {
            org.videolan.libvlc.interfaces.IMedia md = mp.getMedia();
            if (md != null) {
                org.videolan.libvlc.interfaces.IMedia.Stats st = md.getStats();
                md.release();
                if (st != null && st.demuxBitrate > 0) {
                    long backlog = Math.max(0L, (long) st.readBytes - (long) st.demuxReadBytes);
                    ahead = (long) (backlog / st.demuxBitrate); // bitrate is bytes per ms
                }
            }
        } catch (Throwable ignored) { }
        if (!mp.isPlaying() && spinner.getVisibility() == View.VISIBLE) ahead = 0; // still loading
        else ahead += 3000;
        ahead = Math.min(ahead, 10 * 60 * 1000L);
        aheadSmooth = aheadSmooth == 0 ? ahead : (aheadSmooth * 3 + ahead) / 4;
        return aheadSmooth;
    }

    static String fmt(long s) {
        if (s < 0) s = 0;
        long hh = s / 3600, mm = (s % 3600) / 60, ss = s % 60;
        return hh > 0 ? String.format(Locale.US, "%d:%02d:%02d", hh, mm, ss) : String.format(Locale.US, "%02d:%02d", mm, ss);
    }

    void togglePlay() {
        if (ended) { playIndex(index, false); return; }
        if (stoppedForOther) { msgBox.setVisibility(View.GONE); retries = 0; start(cur().url, isLive() ? 0 : Math.max(0, cur().lastPos * 1000)); return; }
        if (mp.isPlaying()) mp.pause(); else mp.play();
        showControls();
    }

    void seekBy(long sec) {
        if (isLive()) return;
        long d = mp.getLength(), t = mp.getTime() + sec * 1000;
        if (d > 0) t = Math.max(0, Math.min(d - 2000, t));
        mp.setTime(Math.max(0, t));
        osd((sec > 0 ? "+" : "") + sec + " s");
        showControls();
    }

    void zap(int dir) {
        if (items.size() < 2) return;
        int n = (index + dir + items.size()) % items.size();
        playIndex(n, false);
    }

    void savePos() {
        Item it = cur();
        if (!isLive() && mp != null && !ended) {
            long t = mp.getTime(), d = mp.getLength();
            if (t > 0) { it.lastPos = t / 1000; it.lastDur = d / 1000; }
        }
    }

    // ------------------------------------------------------------------ menus
    void audioMenu() {
        MediaPlayer.TrackDescription[] t = mp.getAudioTracks();
        if (t == null || t.length == 0) { toast("No other audio tracks"); return; }
        String[] names = new String[t.length];
        int sel = -1, curId = mp.getAudioTrack();
        for (int i = 0; i < t.length; i++) { names[i] = t[i].name; if (t[i].id == curId) sel = i; }
        new AlertDialog.Builder(this).setTitle("Audio").setSingleChoiceItems(names, sel, (d, w) -> { mp.setAudioTrack(t[w].id); d.dismiss(); }).show();
    }

    void subsMenu() {
        MediaPlayer.TrackDescription[] t = mp.getSpuTracks();
        if (t == null || t.length == 0) { toast("No subtitles in this video"); return; }
        String[] names = new String[t.length];
        int sel = -1, curId = mp.getSpuTrack();
        for (int i = 0; i < t.length; i++) { names[i] = t[i].name; if (t[i].id == curId) sel = i; }
        new AlertDialog.Builder(this).setTitle("Subtitles").setSingleChoiceItems(names, sel, (d, w) -> { mp.setSpuTrack(t[w].id); d.dismiss(); }).show();
    }

    static final String[] SCALE_NAMES = {"Fit", "Fill", "Stretch", "16:9", "4:3", "Original"};
    void cycleScale() { scaleMode = (scaleMode + 1) % SCALE_NAMES.length; applyScale(); osd("⤢ " + SCALE_NAMES[scaleMode]); }
    void applyScale() {
        MediaPlayer.ScaleType st;
        switch (scaleMode) {
            case 1: st = MediaPlayer.ScaleType.SURFACE_FIT_SCREEN; break;
            case 2: st = MediaPlayer.ScaleType.SURFACE_FILL; break;
            case 3: st = MediaPlayer.ScaleType.SURFACE_16_9; break;
            case 4: st = MediaPlayer.ScaleType.SURFACE_4_3; break;
            case 5: st = MediaPlayer.ScaleType.SURFACE_ORIGINAL; break;
            default: st = MediaPlayer.ScaleType.SURFACE_BEST_FIT;
        }
        try { mp.setVideoScale(st); } catch (Exception ignored) { }
    }

    void numberPad() {
        EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_CLASS_NUMBER);
        in.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        in.setGravity(Gravity.CENTER);
        new AlertDialog.Builder(this).setTitle("Channel number").setView(in)
                .setPositiveButton("Go", (d, w) -> goNumber(in.getText().toString().trim()))
                .setNegativeButton("Cancel", null).show();
        in.requestFocus();
        h.postDelayed(() -> {
            android.view.inputmethod.InputMethodManager im = (android.view.inputmethod.InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            im.showSoftInput(in, 0);
        }, 200);
    }

    void goNumber(String n) {
        if (n.isEmpty()) return;
        for (int i = 0; i < items.size(); i++) {
            Item it = items.get(i);
            try { if (Long.parseLong(it.num) == Long.parseLong(n)) { playIndex(i, false); return; } } catch (Exception ignored) { }
        }
        // not in this list: ask the web UI to find it in all channels
        result = buildResult(n);
        setResult(RESULT_OK);
        finish();
    }

    // ------------------------------------------------------------------ gestures (like YouTube): left third = brightness, right third = volume,
    // middle: swipe DOWN = minimise to a small floating window (picture-in-picture); in that window drag it to ✕ to close
    float downX, downY, startVal; boolean swiping, capAt150; int swipeSide;
    GestureDetector gd;

    boolean handleTouch(MotionEvent ev) {
        if (gd.onTouchEvent(ev)) return true;
        int w = root.getWidth(), hgt = root.getHeight();
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = ev.getX(); downY = ev.getY(); swiping = false;
                swipeSide = downX > w * 2 / 3f ? 1 : downX < w / 3f ? 0 : 2;
                startVal = swipeSide == 1 ? level() / 100f : currentBrightness();
                capAt150 = level() < 150; // one swipe stops at 150 %; swipe again to go further
                return true;
            case MotionEvent.ACTION_MOVE:
                float dy = downY - ev.getY();
                if (!swiping && Math.abs(dy) > 24 * density && Math.abs(dy) > Math.abs(ev.getX() - downX)) swiping = true;
                if (swiping && swipeSide == 2) {
                    if (-dy > 40 * density) osd("⬇ Release to minimise");
                    return true;
                }
                if (swiping) {
                    if (swipeSide == 1) {
                        float v = Math.max(0f, Math.min(2f, startVal + dy / (hgt * 0.6f)));
                        int lvl = Math.round(v * 100);
                        if (capAt150 && lvl > 150) lvl = 150;
                        setLevel(lvl);
                        if (capAt150 && lvl == 150) osd(WARN_STOP, 2500); else volOsd(lvl);
                    } else {
                        float v = Math.max(0f, Math.min(1f, startVal + dy / (hgt * 0.6f)));
                        WindowManager.LayoutParams lp = getWindow().getAttributes();
                        lp.screenBrightness = Math.max(0.02f, v);
                        getWindow().setAttributes(lp);
                        osd("☀ " + Math.round(v * 100) + "%");
                    }
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (swiping && swipeSide == 2 && ev.getY() - downY > Math.max(120 * density, hgt * 0.18f) && !minimise()) toast("Minimise is not available on this tablet");
                swiping = false;
                return true;
            default:
                return true;
        }
    }

    // ------------------------------------------------------------------ minimise (picture-in-picture)
    boolean minimise() {
        if (Build.VERSION.SDK_INT < 26 || pipActive) return false;
        try {
            int vw = 16, vh = 9;
            try { org.videolan.libvlc.interfaces.IMedia.VideoTrack vt = mp.getCurrentVideoTrack(); if (vt != null && vt.width > 0 && vt.height > 0) { vw = vt.width; vh = vt.height; } } catch (Throwable ignored) { }
            float r = vw / (float) vh;
            if (r > 2.39f) { vw = 239; vh = 100; } else if (r < 0.42f) { vw = 42; vh = 100; } // Android's allowed range
            android.app.PictureInPictureParams.Builder b = new android.app.PictureInPictureParams.Builder().setAspectRatio(new android.util.Rational(vw, vh));
            if (Build.VERSION.SDK_INT >= 31) b.setSeamlessResizeEnabled(true);
            closeSoundPanel();
            hideControls();
            return enterPictureInPictureMode(b.build());
        } catch (Throwable e) {
            return false;
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, android.content.res.Configuration cfg) {
        super.onPictureInPictureModeChanged(inPip, cfg);
        pipActive = inPip;
        if (inPip) {
            controls.setVisibility(View.GONE); controlsShown = false;
            osdBox.setVisibility(View.GONE); msgBox.setVisibility(View.GONE);
            if (soundPanel != null) soundPanel.setVisibility(View.GONE);
        } else if (stoppedNow) {
            finishWithResult();               // the small window was closed (dragged to ✕)
        } else {
            showControls();                   // tapped "full screen" in the small window
        }
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c);
        root.post(this::adaptLayout);
    }

    /** upright tablet: tighter bar, hide what does not fit (aspect + volume slider stay in ⚙ / swipe) */
    void adaptLayout() {
        if (root == null || panelView == null) return;
        boolean portrait = root.getHeight() > root.getWidth();
        FrameLayout.LayoutParams bl = (FrameLayout.LayoutParams) panelView.getLayoutParams();
        bl.leftMargin = bl.rightMargin = dp(portrait ? 10 : 60);
        panelView.setLayoutParams(bl);
        vol.setVisibility(portrait ? View.GONE : View.VISIBLE);
        aspectBtn.setVisibility(portrait ? View.GONE : View.VISIBLE);
        if (soundPanel != null) {
            FrameLayout.LayoutParams pl = (FrameLayout.LayoutParams) soundPanel.getLayoutParams();
            pl.width = dp(portrait ? 330 : 360);
            soundPanel.setLayoutParams(pl);
        }
    }

    float currentBrightness() {
        float b = getWindow().getAttributes().screenBrightness;
        if (b < 0) {
            try { b = android.provider.Settings.System.getInt(getContentResolver(), android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255f; } catch (Exception e) { b = 0.5f; }
        }
        return b;
    }

    // ------------------------------------------------------------------ UI (same layout as the Windows app, glass look)
    int dp(float v) { return Math.round(v * density); }

    /** frosted-glass panel: dark see-through fill, thin light border, soft top highlight */
    GradientDrawable glass(float radiusDp, int alpha) {
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{Color.argb(alpha, 70, 72, 84), Color.argb(alpha, 28, 29, 36)});
        g.setCornerRadius(dp(radiusDp));
        g.setStroke(Math.max(1, dp(1)), Color.argb(70, 255, 255, 255));
        return g;
    }

    RippleDrawable ripple(Drawable content, boolean oval) {
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(Color.WHITE);
        if (oval) mask.setShape(GradientDrawable.OVAL); else mask.setCornerRadius(dp(24));
        return new RippleDrawable(ColorStateList.valueOf(Color.argb(90, 255, 255, 255)), content, mask);
    }

    ImageView iconBtn(int res, int sizeDp, int iconDp, String desc) {
        ImageView v = new ImageView(this);
        v.setImageResource(res);
        v.setScaleType(ImageView.ScaleType.FIT_CENTER);
        int pad = dp((sizeDp - iconDp) / 2f);
        v.setPadding(pad, pad, pad, pad);
        v.setBackground(ripple(null, true));
        v.setContentDescription(desc);
        v.setClickable(true);
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)));
        return v;
    }

    /** round arrow with "10"/"30" written inside, like the Windows player */
    FrameLayout skipBtn(int res, String secs) {
        FrameLayout f = new FrameLayout(this);
        ImageView i = new ImageView(this);
        i.setImageResource(res);
        i.setScaleType(ImageView.ScaleType.FIT_CENTER);
        f.addView(i, new FrameLayout.LayoutParams(dp(34), dp(34), Gravity.CENTER));
        TextView t = new TextView(this);
        t.setText(secs); t.setTextColor(Color.WHITE); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9); t.setTypeface(Typeface.DEFAULT_BOLD);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER); tl.topMargin = dp(3);
        f.addView(t, tl);
        f.setBackground(ripple(null, true));
        f.setClickable(true);
        f.setLayoutParams(new LinearLayout.LayoutParams(dp(50), dp(50)));
        return f;
    }

    /** glass pill with icon + text (top bar: Link, Download, Open in…) */
    GlassView chip(int res, String text) {
        GlassView g = new GlassView(this, blur, -1);
        g.setForeground(ripple(null, false));
        g.setClickable(true);
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.HORIZONTAL);
        c.setGravity(Gravity.CENTER_VERTICAL);
        c.setPadding(dp(14), 0, dp(16), 0);
        g.addView(c, new FrameLayout.LayoutParams(-2, -1));
        ImageView i = new ImageView(this); i.setImageResource(res);
        c.addView(i, new LinearLayout.LayoutParams(dp(18), dp(18)));
        TextView t = new TextView(this); t.setText(text); t.setTextColor(Color.WHITE); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14); t.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(-2, -2); tl.leftMargin = dp(8);
        c.addView(t, tl);
        return g;
    }

    LinearLayout.LayoutParams lpm(int l, int r) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.leftMargin = dp(l); p.rightMargin = dp(r); p.gravity = Gravity.CENTER_VERTICAL;
        return p;
    }
    LinearLayout.LayoutParams sized(View v, int l, int r) {
        ViewGroup.LayoutParams o = v.getLayoutParams();
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(o != null ? o.width : -2, o != null ? o.height : -2);
        p.leftMargin = dp(l); p.rightMargin = dp(r); p.gravity = Gravity.CENTER_VERTICAL;
        return p;
    }

    void tintSeek(SeekBar s, int color) {
        s.setProgressTintList(ColorStateList.valueOf(color));
        s.setThumbTintList(ColorStateList.valueOf(Color.WHITE));
        s.setProgressBackgroundTintList(ColorStateList.valueOf(Color.argb(70, 255, 255, 255)));
        s.setSecondaryProgressTintList(ColorStateList.valueOf(Color.argb(190, 210, 210, 215))); // buffered part
    }

    void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        videoLayout = new VLCVideoLayout(this);
        root.addView(videoLayout, new FrameLayout.LayoutParams(-1, -1));

        spinner = new ProgressBar(this);
        root.addView(spinner, new FrameLayout.LayoutParams(dp(56), dp(56), Gravity.CENTER));

        controls = new FrameLayout(this);
        root.addView(controls, new FrameLayout.LayoutParams(-1, -1));

        // ---- top bar: ← title ........ [Link] [Download] [Open in…]
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(18), dp(16), dp(18), dp(36));
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{Color.argb(160, 0, 0, 0), Color.TRANSPARENT}));
        backBtn = iconBtn(R.drawable.ic_back, 48, 24, "Back");
        GlassView backGlass = new GlassView(this, blur, -1);
        backGlass.addView(backBtn, new FrameLayout.LayoutParams(dp(48), dp(48)));
        top.addView(backGlass, sized(backBtn, 0, 14));
        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        title = new TextView(this); title.setTextColor(Color.WHITE); title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19); title.setTypeface(Typeface.DEFAULT_BOLD); title.setSingleLine(true); title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        subtitle = new TextView(this); subtitle.setTextColor(Color.argb(200, 255, 255, 255)); subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13); subtitle.setSingleLine(true);
        titles.addView(title); titles.addView(subtitle);
        top.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        linkBtn = chip(R.drawable.ic_link, "Link");
        dlBtn = chip(R.drawable.ic_download, "Download");
        openBtn = chip(R.drawable.ic_open, "Open in…");
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(-2, dp(44)); cl.leftMargin = dp(10);
        top.addView(linkBtn, cl);
        top.addView(dlBtn, new LinearLayout.LayoutParams(cl));
        top.addView(openBtn, new LinearLayout.LayoutParams(cl));
        controls.addView(top, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        // ---- bottom glass panel (same order as the Windows player)
        bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.VERTICAL);
        bottomBar.setPadding(dp(20), dp(8), dp(20), dp(4));

        bottomBar.setClickable(true); // taps on the panel don't hide the controls

        // row 1: time  ━━━━━●───  duration / LIVE
        row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        row1.setGravity(Gravity.CENTER_VERTICAL);
        curTime = new TextView(this); curTime.setTextColor(Color.WHITE); curTime.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14); curTime.setTypeface(Typeface.MONOSPACE);
        durTime = new TextView(this); durTime.setTextColor(Color.WHITE); durTime.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14); durTime.setTypeface(Typeface.MONOSPACE);
        liveBadge = new TextView(this); liveBadge.setText("● LIVE"); liveBadge.setTextColor(Color.rgb(255, 80, 80)); liveBadge.setTypeface(Typeface.DEFAULT_BOLD); liveBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        seek = new SeekBar(this);
        tintSeek(seek, Color.rgb(229, 57, 53));
        row1.addView(curTime, lpm(0, 8));
        row1.addView(seek, new LinearLayout.LayoutParams(0, dp(30), 1f));
        row1.addView(liveBadge, lpm(8, 0));
        row1.addView(durTime, lpm(8, 0));
        bottomBar.addView(row1, new LinearLayout.LayoutParams(-1, -2));

        // row 2: [mute ─vol─]      [aspect ⏮ ⟲30 ▶ 30⟳ ⏭ CC audio ⚙]      [123]
        FrameLayout row2 = new FrameLayout(this);
        LinearLayout left = new LinearLayout(this); left.setGravity(Gravity.CENTER_VERTICAL);
        muteBtn = iconBtn(R.drawable.ic_vol, 44, 24, "Mute");
        vol = new SeekBar(this); tintSeek(vol, Color.WHITE);
        vol.setMax(200); // 0–100 % tablet volume, 100–200 % boost
        left.addView(muteBtn, sized(muteBtn, 0, 2));
        left.addView(vol, new LinearLayout.LayoutParams(dp(140), dp(36)));
        liveBadge2 = new TextView(this); liveBadge2.setText("● LIVE"); liveBadge2.setTextColor(Color.rgb(255, 80, 80)); liveBadge2.setTypeface(Typeface.DEFAULT_BOLD); liveBadge2.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        left.addView(liveBadge2, lpm(10, 0));
        row2.addView(left, new FrameLayout.LayoutParams(-2, -2, Gravity.START | Gravity.CENTER_VERTICAL));

        LinearLayout mid = new LinearLayout(this); mid.setGravity(Gravity.CENTER_VERTICAL);
        ImageView aspect = iconBtn(R.drawable.ic_aspect, 46, 24, "Aspect ratio");
        prevBtn = iconBtn(R.drawable.ic_prev, 50, 28, "Previous");
        rwBtn = skipBtn(R.drawable.ic_rew, "30");
        playBtn = iconBtn(R.drawable.ic_pause, 62, 30, "Play / Pause");
        GradientDrawable pbg = new GradientDrawable(); pbg.setShape(GradientDrawable.OVAL); pbg.setColor(Color.argb(235, 255, 255, 255));
        playBtn.setBackground(ripple(pbg, true));
        playBtn.setColorFilter(Color.rgb(20, 20, 28));
        ffBtn = skipBtn(R.drawable.ic_fwd, "30");
        nextBtn = iconBtn(R.drawable.ic_next, 50, 28, "Next");
        ImageView subs = iconBtn(R.drawable.ic_subs, 46, 24, "Subtitles");
        ImageView aud = iconBtn(R.drawable.ic_audio, 46, 24, "Audio track");
        ImageView set = iconBtn(R.drawable.ic_settings, 46, 24, "Settings");
        View[] row = {aspect, prevBtn, rwBtn, playBtn, ffBtn, nextBtn, subs, aud, set};
        for (View v : row) mid.addView(v, sized(v, 6, 6));
        row2.addView(mid, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));

        numBtn = iconBtn(R.drawable.ic_dialpad, 46, 22, "Channel number");
        row2.addView(numBtn, new FrameLayout.LayoutParams(dp(46), dp(46), Gravity.END | Gravity.CENTER_VERTICAL));
        bottomBar.addView(row2, new LinearLayout.LayoutParams(-1, dp(58)));
        aspectBtn = aspect;

        FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        bl.leftMargin = dp(60); bl.rightMargin = dp(60); bl.bottomMargin = dp(22);
        GlassView panel = new GlassView(this, blur, dp(24));
        panelView = panel;
        panel.addView(bottomBar, new FrameLayout.LayoutParams(-1, -2));
        controls.addView(panel, bl);

        // ---- OSD + message (glass too)
        osd = new TextView(this);
        osd.setTextColor(Color.WHITE); osd.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22); osd.setTypeface(Typeface.DEFAULT_BOLD);
        osd.setPadding(dp(22), dp(12), dp(22), dp(12));
        osdBox = new GlassView(this, blur, dp(18)); osdBox.addView(osd); osdBox.setVisibility(View.GONE);
        FrameLayout.LayoutParams ol = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL | Gravity.TOP); ol.topMargin = dp(100);
        root.addView(osdBox, ol);
        msg = new TextView(this);
        msg.setTextColor(Color.WHITE); msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16); msg.setGravity(Gravity.CENTER);
        msg.setPadding(dp(26), dp(20), dp(26), dp(20));
        msgBox = new GlassView(this, blur, dp(18)); msgBox.addView(msg); msgBox.setVisibility(View.GONE);
        msgBox.tint = Color.argb(140, 18, 18, 24); // text must stay readable
        root.addView(msgBox, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));

        setContentView(root);
        root.post(this::adaptLayout);

        // ---- actions
        backBtn.setOnClickListener(v -> backOrMinimise());
        playBtn.setOnClickListener(v -> togglePlay());
        rwBtn.setOnClickListener(v -> seekBy(-30));
        ffBtn.setOnClickListener(v -> seekBy(30));
        prevBtn.setOnClickListener(v -> zap(-1));
        nextBtn.setOnClickListener(v -> zap(1));
        aud.setOnClickListener(v -> audioMenu());
        subs.setOnClickListener(v -> subsMenu());
        aspect.setOnClickListener(v -> cycleScale());
        set.setOnClickListener(v -> settingsMenu());
        numBtn.setOnClickListener(v -> numberPad());
        muteBtn.setOnClickListener(v -> toggleMute());
        linkBtn.setOnClickListener(v -> showLink());
        dlBtn.setOnClickListener(v -> askDownload());
        openBtn.setOnClickListener(v -> openInOtherApp());
        msg.setOnClickListener(v -> { msgBox.setVisibility(View.GONE); retries = 0; start(cur().url, isLive() ? 0 : Math.max(0, cur().lastPos * 1000)); });
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean user) { if (user) curTime.setText(fmt(p)); }
            @Override public void onStartTrackingTouch(SeekBar s) { seeking = true; h.removeCallbacks(hideCtl); }
            @Override public void onStopTrackingTouch(SeekBar s) { seeking = false; aheadSmooth = 0; mp.setTime(s.getProgress() * 1000L); showControls(); }
        });
        vol.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean user) {
                if (!user) return;
                if (capBar && p > 150) { p = 150; s.setProgress(150); osd(WARN_STOP.replace("ફરી ઉપર swipe કરો", "slider ફરી ખેંચો"), 2500); }
                setLevel(p);
                if (!(capBar && p == 150)) volOsd(p);
            }
            @Override public void onStartTrackingTouch(SeekBar s) { h.removeCallbacks(hideCtl); capBar = level() < 150; }
            @Override public void onStopTrackingTouch(SeekBar s) { showControls(); }
        });

        gd = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onSingleTapConfirmed(MotionEvent e) {
                if (soundPanel != null && soundPanel.getVisibility() == View.VISIBLE) { closeSoundPanel(); return true; } // tap on the video closes the panel
                if (controlsShown) hideControls(); else showControls(); return true;
            }
            @Override public boolean onDoubleTap(MotionEvent e) {
                if (isLive()) return false;
                float w = root.getWidth();
                if (e.getX() < w / 3f) seekBy(-10); else if (e.getX() > w * 2 / 3f) seekBy(10); else togglePlay();
                return true;
            }
            @Override public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                // horizontal fling on a live channel = change channel
                if (e1 != null && isLive() && Math.abs(vx) > Math.abs(vy) * 1.5 && Math.abs(e2.getX() - e1.getX()) > 120 * density) { zap(vx < 0 ? 1 : -1); return true; }
                return false;
            }
        });
        View touch = new View(this);
        root.addView(touch, 1, new FrameLayout.LayoutParams(-1, -1)); // above video, below controls
        touch.setOnTouchListener((v, ev) -> handleTouch(ev));
        controls.setOnTouchListener((v, ev) -> handleTouch(ev));
    }

    void setPlayIcon(boolean playing) { playBtn.setImageResource(playing ? R.drawable.ic_pause : R.drawable.ic_play); }

    // ------------------------------------------------------------------ volume: 0–100 % = tablet volume, 100–200 % = extra boost
    static final String WARN = "⚠ 150% થી વધારે: અવાજ ફાટી શકે અને કાન માટે નુકસાનકારક છે";
    static final String WARN_STOP = "🔊 150%\n" + WARN + "\nવધારે કરવું હોય તો ફરી ઉપર swipe કરો";
    int maxVol() { return audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC); }
    int level() {
        int sys = audio.getStreamVolume(AudioManager.STREAM_MUSIC), max = maxVol();
        if (sys >= max && boost > 100) return boost;
        return Math.round(sys * 100f / max);
    }
    void setLevel(int lvl) {
        lvl = Math.max(0, Math.min(200, lvl));
        int max = maxVol();
        if (lvl <= 100) { audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(lvl * max / 100f), 0); setBoost(100); }
        else { if (audio.getStreamVolume(AudioManager.STREAM_MUSIC) < max) audio.setStreamVolume(AudioManager.STREAM_MUSIC, max, 0); setBoost(lvl); }
        syncVolume();
    }
    void setBoost(int b) {
        b = Math.max(100, Math.min(200, b));
        if (b < 150) warned150 = false;
        if (b == boost) return;
        boost = b;
        if (mp != null) mp.setVolume(boost);
        Sound.save(this, boost, Sound.auto(this));
    }
    void volOsd(int lvl) {
        if (lvl > 150) osd("🔊 " + lvl + "%\n" + WARN, 2000);
        else osd((lvl == 0 ? "🔇 " : "🔊 ") + lvl + "%");
    }
    /** volume keys: at the tablet's maximum they keep going (boost), with a stop + warning at 150 % */
    boolean volumeKey(boolean up) {
        int max = maxVol(), sys = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
        if (up) {
            if (sys < max) return false;                       // normal: the tablet handles it
            if (boost >= 200) { volOsd(200); return true; }
            int nb = Math.min(200, boost + 10);
            if (boost < 150 && nb >= 150) { setLevel(150); osd(WARN_STOP.replace("ફરી ઉપર swipe કરો", "ફરી + બટન દબાવો"), 2500); return true; } // stop at 150 once
            setLevel(nb);
            volOsd(nb);
            return true;
        } else {
            if (boost <= 100) return false;
            setLevel(boost - 10 <= 100 ? 100 : boost - 10);
            volOsd(level());
            return true;
        }
    }
    int volBeforeMute = -1;
    void toggleMute() {
        int l = level();
        if (l > 0) { volBeforeMute = l; setLevel(0); osd("🔇 Mute"); }
        else { int back = volBeforeMute > 0 ? Math.min(volBeforeMute, 100) : 50; setLevel(back); volOsd(back); }
        showControls();
    }
    void syncVolume() { if (vol != null) vol.setProgress(level()); updateMuteIcon(); }
    void updateMuteIcon() { if (muteBtn != null) muteBtn.setImageResource(level() == 0 ? R.drawable.ic_mute : R.drawable.ic_vol); }

    // ------------------------------------------------------------------ settings: speed + aspect
    static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f};
    void settingsMenu() {
        String al = "Auto-level (same loudness on every channel): " + (Sound.auto(this) ? "ON" : "OFF");
        String[] opts = isLive() ? new String[]{"Aspect ratio: " + SCALE_NAMES[scaleMode], al}
                : new String[]{"Speed: " + speedName(mp.getRate()), "Aspect ratio: " + SCALE_NAMES[scaleMode], al};
        new AlertDialog.Builder(this).setTitle("Settings").setItems(opts, (d, w) -> {
            int k = isLive() ? w + 1 : w;
            if (k == 0) speedMenu(); else if (k == 1) scaleMenu(); else toggleAutoLevel();
        }).show();
    }
    void toggleAutoLevel() {
        boolean on = !Sound.auto(this);
        Sound.save(this, boost, on);
        osd("Auto-level " + (on ? "ON" : "OFF") + " …", 1500);
        restartEngine();
    }
    static String speedName(float r) { return (Math.abs(r - 1f) < 0.01f ? "Normal" : (r == (int) r ? String.valueOf((int) r) : String.valueOf(r)) + "×"); }
    void speedMenu() {
        String[] n = new String[SPEEDS.length]; int sel = 0;
        for (int i = 0; i < SPEEDS.length; i++) { n[i] = speedName(SPEEDS[i]); if (Math.abs(SPEEDS[i] - mp.getRate()) < 0.01f) sel = i; }
        new AlertDialog.Builder(this).setTitle("Speed").setSingleChoiceItems(n, sel, (d, w) -> { mp.setRate(SPEEDS[w]); osd("Speed " + n[w]); d.dismiss(); }).show();
    }
    void scaleMenu() {
        new AlertDialog.Builder(this).setTitle("Aspect ratio").setSingleChoiceItems(SCALE_NAMES, scaleMode, (d, w) -> { scaleMode = w; applyScale(); osd("⤢ " + SCALE_NAMES[w]); d.dismiss(); }).show();
    }

    // ------------------------------------------------------------------ Link / Download / Open in other app
    void showLink() {
        String url = cur().url;
        TextView t = new TextView(this);
        t.setText(url); t.setTextIsSelectable(true); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setPadding(dp(24), dp(12), dp(24), dp(4));
        new AlertDialog.Builder(this).setTitle("Stream link").setView(t)
                .setPositiveButton("Copy", (d, w) -> {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("Stream link", url));
                    osd("✓ Link copied");
                })
                .setNeutralButton("Share", (d, w) -> {
                    Intent i = new Intent(Intent.ACTION_SEND); i.setType("text/plain"); i.putExtra(Intent.EXTRA_TEXT, url);
                    startActivity(Intent.createChooser(i, "Share link"));
                })
                .setNegativeButton("Close", null).show();
    }

    void askDownload() {
        Item it = cur();
        new AlertDialog.Builder(this).setTitle("Download")
                .setMessage("\"" + it.name + "\" will be saved in Downloads/AlnurIPTV.\n\nYour IPTV account allows only 1 connection, so playback stops while the file downloads. You can watch it offline later from the Files app.")
                .setPositiveButton("Download", (d, w) -> startDownload(it))
                .setNegativeButton("Cancel", null).show();
    }

    void startDownload(Item it) {
        try {
            savePos();
            try { mp.stop(); } catch (Exception ignored) { }
            stoppedForOther = true;
            String path = Uri.parse(it.url).getLastPathSegment();
            String ext = path != null && path.lastIndexOf('.') > 0 ? path.substring(path.lastIndexOf('.')) : ".mp4";
            if (ext.length() > 6) ext = ".mp4";
            String base = it.sub != null && !it.sub.isEmpty() && "episode".equals(it.kind) ? it.sub + " - " + it.name : it.name;
            String[] err = new String[1];
            if (Downloads.start(this, it.url, base + ext, ua, err) < 0) throw new Exception(err[0]);
            Toast.makeText(this, "Download started – see ⬇ at the top of the app", Toast.LENGTH_LONG).show();
            setPlayIcon(false);
            showMsg("⬇ Downloading \"" + it.name + "\".\nProgress: ⬇ at the top of the app, or the notification bar.\nTap here to play again (this stops the download\u2019s connection).");
        } catch (Exception e) {
            showMsg("Download could not start:\n" + e.getMessage());
        }
    }

    void openInOtherApp() {
        Item it = cur();
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(it.url), "video/*");
            i.putExtra("title", it.name);
            savePos();
            try { mp.stop(); } catch (Exception ignored) { } // free the 1 allowed connection for the other app
            stoppedForOther = true;
            setPlayIcon(false);
            startActivity(Intent.createChooser(i, "Open with"));
        } catch (Exception e) {
            toast("No video app found");
        }
    }

    void closeSoundPanel() { }

    final Runnable glassTick = new Runnable() {
        @Override public void run() {
            if (controlsShown || (soundPanel != null && soundPanel.getVisibility() == View.VISIBLE) || (osdBox != null && osdBox.getVisibility() == View.VISIBLE) || (msgBox != null && msgBox.getVisibility() == View.VISIBLE))
                blur.refresh(videoLayout);
            h.postDelayed(this, 66);
        }
    };

    final Runnable hideCtl = this::hideControls;
    void showControls() {
        controls.setVisibility(View.VISIBLE); controlsShown = true;
        syncVolume();
        h.removeCallbacks(hideCtl);
        h.postDelayed(hideCtl, 4500);
    }
    void hideControls() {
        if (seeking) return;
        controls.setVisibility(View.GONE); controlsShown = false;
        hideSystemBars();
    }

    final Runnable hideOsd = () -> osdBox.setVisibility(View.GONE);
    void osd(String t) { osd(t, 1000); }
    void osd(String t, int ms) { osd.setText(t); osdBox.setVisibility(View.VISIBLE); h.removeCallbacks(hideOsd); h.postDelayed(hideOsd, ms); }
    void toast(String t) { osd(t); }

    void hideSystemBars() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) hideSystemBars(); }

    // remote / keyboard keys
    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        switch (code) {
            case KeyEvent.KEYCODE_CHANNEL_UP: case KeyEvent.KEYCODE_DPAD_UP: case KeyEvent.KEYCODE_PAGE_UP:
                if (isLive()) { zap(1); return true; } break;
            case KeyEvent.KEYCODE_CHANNEL_DOWN: case KeyEvent.KEYCODE_DPAD_DOWN: case KeyEvent.KEYCODE_PAGE_DOWN:
                if (isLive()) { zap(-1); return true; } break;
            case KeyEvent.KEYCODE_DPAD_LEFT: case KeyEvent.KEYCODE_MEDIA_REWIND: seekBy(-10); return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT: case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: seekBy(10); return true;
            case KeyEvent.KEYCODE_VOLUME_UP:
                if (volumeKey(true)) return true;
                h.postDelayed(this::syncVolume, 150); break;
            case KeyEvent.KEYCODE_VOLUME_DOWN:
                if (volumeKey(false)) return true;
                h.postDelayed(this::syncVolume, 150); break;
            case KeyEvent.KEYCODE_SPACE: case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: case KeyEvent.KEYCODE_DPAD_CENTER: togglePlay(); return true;
            default: break;
        }
        return super.onKeyDown(code, e);
    }

    /** Back = small floating window (like YouTube); close it from there. Without picture-in-picture: close. */
    @Override public void onBackPressed() { backOrMinimise(); }
    void backOrMinimise() {
        if (!pipActive && Build.VERSION.SDK_INT >= 26 && getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            if (minimise()) return;
        }
        finishWithResult();
    }

    String buildResult(String gotoNum) {
        try {
            savePos();
            JSONObject o = new JSONObject();
            o.put("index", index);
            if (gotoNum != null) o.put("gotoNum", gotoNum);
            JSONArray pr = new JSONArray();
            for (int i = 0; i < items.size(); i++) {
                Item it = items.get(i);
                if (it.lastPos >= 0) { JSONObject p = new JSONObject(); p.put("i", i); p.put("pos", it.lastPos); p.put("dur", it.lastDur); p.put("key", it.key); pr.put(p); }
            }
            o.put("progress", pr);
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    void finishWithResult() {
        result = buildResult(null);
        setResult(RESULT_OK);
        finish();
    }

    @Override
    protected void onPause() {
        super.onPause();
        boolean pip = Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode();
        if (!pip && mp != null && !isLive() && mp.isPlaying()) mp.pause(); // keeps playing in the small window
    }

    @Override
    protected void onStop() {
        super.onStop();
        stoppedNow = true;
        if (pipActive) { finishWithResult(); return; } // small window closed
        if (mp != null && isLive()) mp.stop(); // free the server connection (only 1 allowed)
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        stoppedNow = false;
        if (mp != null && isLive() && !stoppedForOther) start(cur().url, 0);
        syncVolume();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        h.removeCallbacksAndMessages(null);
        if (result == null && !items.isEmpty()) result = buildResult(null);
        if (current == this) current = null;
        MainActivity.deliverPlayerResult(); // also works when the player was minimised (own window/task)
        if (mp != null) {
            try { mp.stop(); mp.detachViews(); mp.release(); } catch (Exception ignored) { }
            mp = null;
        }
        if (vlc != null) { vlc.release(); vlc = null; }
        if (sound != null) { sound.close(); sound = null; }
    }
}
