package com.alnur.iptv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.net.Uri;
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
    TextView title, subtitle, playBtn, prevBtn, nextBtn, backBtn, rwBtn, ffBtn, curTime, durTime, osd, msg, liveBadge, numBtn;
    LinearLayout bottomBar;
    SeekBar seek;
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
        buildUi();
        hideSystemBars();
        ArrayList<String> opts = new ArrayList<>();
        opts.add("--http-reconnect");
        opts.add("--deinterlace=-1");
        opts.add("--deinterlace-mode=yadif");
        opts.add("--audio-time-stretch");
        opts.add("--no-stats");
        vlc = new LibVLC(this, opts);
        mp = new MediaPlayer(vlc);
        mp.attachViews(videoLayout, null, true, false);
        mp.setEventListener(this::onVlcEvent);
        playIndex(index, true);
        h.post(ticker);
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

    Item cur() { return items.get(index); }
    boolean isLive() { String k = cur().kind; return "live".equals(k); }

    // ------------------------------------------------------------------ playback
    void playIndex(int i, boolean first) {
        if (!first) savePos();
        index = i;
        ended = false; retries = 0;
        Item it = cur();
        title.setText((isLive() && !it.num.isEmpty() ? it.num + "  ·  " : "") + it.name);
        subtitle.setText(it.sub);
        boolean live = isLive();
        rwBtn.setVisibility(live ? View.GONE : View.VISIBLE);
        ffBtn.setVisibility(live ? View.GONE : View.VISIBLE);
        seek.setVisibility(live ? View.INVISIBLE : View.VISIBLE);
        liveBadge.setVisibility(live ? View.VISIBLE : View.GONE);
        numBtn.setVisibility(live ? View.VISIBLE : View.GONE);
        boolean many = items.size() > 1;
        prevBtn.setAlpha(many ? 1f : 0.3f); nextBtn.setAlpha(many ? 1f : 0.3f);
        curTime.setText(""); durTime.setText("");
        msg.setVisibility(View.GONE);
        start(it.url, live ? 0 : it.start);
        showControls();
    }

    void start(String url, long startMs) {
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
                spinner.setVisibility(View.GONE);
                playBtn.setText("❚❚");
                msg.setVisibility(View.GONE);
                break;
            case MediaPlayer.Event.Paused:
                playBtn.setText("▶");
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
            playBtn.setText("▶");
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

    void showMsg(String t) { msg.setText(t + "\n\n⟳  Retry"); msg.setVisibility(View.VISIBLE); showControls(); }

    final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (mp != null && !isLive()) {
                long t = mp.getTime(), d = mp.getLength();
                if (d > 0) {
                    if (!seeking) { seek.setMax((int) (d / 1000)); seek.setProgress((int) (t / 1000)); }
                    curTime.setText(fmt(t / 1000)); durTime.setText(fmt(d / 1000));
                    Item it = cur();
                    if (!ended && t > 0) { it.lastPos = t / 1000; it.lastDur = d / 1000; }
                }
            }
            h.postDelayed(this, 500);
        }
    };

    static String fmt(long s) {
        if (s < 0) s = 0;
        long hh = s / 3600, mm = (s % 3600) / 60, ss = s % 60;
        return hh > 0 ? String.format(Locale.US, "%d:%02d:%02d", hh, mm, ss) : String.format(Locale.US, "%02d:%02d", mm, ss);
    }

    void togglePlay() {
        if (ended) { playIndex(index, false); return; }
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

    // ------------------------------------------------------------------ gestures: right half volume, left half brightness
    float downX, downY, startVal; boolean swiping; int swipeSide;
    GestureDetector gd;

    boolean handleTouch(MotionEvent ev) {
        if (gd.onTouchEvent(ev)) return true;
        int w = root.getWidth(), hgt = root.getHeight();
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = ev.getX(); downY = ev.getY(); swiping = false;
                swipeSide = downX > w / 2f ? 1 : 0;
                startVal = swipeSide == 1 ? audio.getStreamVolume(AudioManager.STREAM_MUSIC) / (float) audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC) : currentBrightness();
                return true;
            case MotionEvent.ACTION_MOVE:
                float dy = downY - ev.getY();
                if (!swiping && Math.abs(dy) > 24 * density && Math.abs(dy) > Math.abs(ev.getX() - downX)) swiping = true;
                if (swiping) {
                    float v = Math.max(0f, Math.min(1f, startVal + dy / (hgt * 0.6f)));
                    if (swipeSide == 1) {
                        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                        audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(v * max), 0);
                        osd("🔊 " + Math.round(v * 100) + "%");
                    } else {
                        WindowManager.LayoutParams lp = getWindow().getAttributes();
                        lp.screenBrightness = Math.max(0.02f, v);
                        getWindow().setAttributes(lp);
                        osd("☀ " + Math.round(v * 100) + "%");
                    }
                }
                return true;
            default:
                return true;
        }
    }

    float currentBrightness() {
        float b = getWindow().getAttributes().screenBrightness;
        if (b < 0) {
            try { b = android.provider.Settings.System.getInt(getContentResolver(), android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255f; } catch (Exception e) { b = 0.5f; }
        }
        return b;
    }

    // ------------------------------------------------------------------ UI
    int dp(float v) { return Math.round(v * density); }

    TextView btn(String text, float sp, int sizeDp, boolean round) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.WHITE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.CENTER);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(round ? 70 : 60, 255, 255, 255));
        if (round) bg.setShape(GradientDrawable.OVAL); else bg.setCornerRadius(dp(10));
        t.setBackground(bg);
        t.setPadding(dp(12), 0, dp(12), 0);
        t.setMinWidth(dp(sizeDp));
        t.setMinHeight(dp(round ? sizeDp : 40));
        if (round) { t.setWidth(dp(sizeDp)); t.setHeight(dp(sizeDp)); t.setPadding(0, 0, 0, 0); }
        return t;
    }

    LinearLayout.LayoutParams lpm(int l, int r) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.leftMargin = dp(l); p.rightMargin = dp(r); p.gravity = Gravity.CENTER_VERTICAL;
        return p;
    }

    void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        videoLayout = new VLCVideoLayout(this);
        root.addView(videoLayout, new FrameLayout.LayoutParams(-1, -1));

        spinner = new ProgressBar(this);
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(dp(56), dp(56), Gravity.CENTER);
        root.addView(spinner, sp);

        controls = new FrameLayout(this);
        root.addView(controls, new FrameLayout.LayoutParams(-1, -1));

        // top bar
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(16), dp(14), dp(16), dp(30));
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{Color.argb(170, 0, 0, 0), Color.TRANSPARENT}));
        backBtn = btn("←", 22, 46, true);
        top.addView(backBtn, lpm(0, 14));
        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        title = new TextView(this); title.setTextColor(Color.WHITE); title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18); title.setTypeface(Typeface.DEFAULT_BOLD); title.setSingleLine(true);
        subtitle = new TextView(this); subtitle.setTextColor(Color.argb(190, 255, 255, 255)); subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13); subtitle.setSingleLine(true);
        titles.addView(title); titles.addView(subtitle);
        LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        top.addView(titles, tl);
        numBtn = btn("123", 15, 56, false);
        TextView aud = btn("Audio", 15, 64, false), sub = btn("CC", 15, 52, false), scale = btn("⤢", 18, 52, false);
        top.addView(numBtn, lpm(8, 0)); top.addView(aud, lpm(8, 0)); top.addView(sub, lpm(8, 0)); top.addView(scale, lpm(8, 0));
        controls.addView(top, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        // centre row
        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.HORIZONTAL);
        mid.setGravity(Gravity.CENTER);
        prevBtn = btn("⏮", 22, 60, true);
        rwBtn = btn("⟲30", 15, 60, true);
        playBtn = btn("❚❚", 26, 84, true);
        ffBtn = btn("30⟳", 15, 60, true);
        nextBtn = btn("⏭", 22, 60, true);
        mid.addView(prevBtn, lpm(14, 14)); mid.addView(rwBtn, lpm(14, 14)); mid.addView(playBtn, lpm(14, 14)); mid.addView(ffBtn, lpm(14, 14)); mid.addView(nextBtn, lpm(14, 14));
        controls.addView(mid, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));

        // bottom bar
        bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.HORIZONTAL);
        bottomBar.setGravity(Gravity.CENTER_VERTICAL);
        bottomBar.setPadding(dp(20), dp(30), dp(20), dp(18));
        bottomBar.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, new int[]{Color.argb(170, 0, 0, 0), Color.TRANSPARENT}));
        liveBadge = new TextView(this); liveBadge.setText("● LIVE"); liveBadge.setTextColor(Color.rgb(255, 90, 90)); liveBadge.setTypeface(Typeface.DEFAULT_BOLD); liveBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        curTime = new TextView(this); curTime.setTextColor(Color.WHITE); curTime.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        durTime = new TextView(this); durTime.setTextColor(Color.WHITE); durTime.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        seek = new SeekBar(this);
        bottomBar.addView(liveBadge, lpm(0, 10));
        bottomBar.addView(curTime, lpm(0, 6));
        bottomBar.addView(seek, new LinearLayout.LayoutParams(0, dp(40), 1f));
        bottomBar.addView(durTime, lpm(6, 0));
        controls.addView(bottomBar, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));

        // OSD + message
        osd = new TextView(this);
        osd.setTextColor(Color.WHITE); osd.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22); osd.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable ob = new GradientDrawable(); ob.setColor(Color.argb(170, 0, 0, 0)); ob.setCornerRadius(dp(14));
        osd.setBackground(ob); osd.setPadding(dp(18), dp(10), dp(18), dp(10)); osd.setVisibility(View.GONE);
        FrameLayout.LayoutParams ol = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL | Gravity.TOP); ol.topMargin = dp(90);
        root.addView(osd, ol);
        msg = new TextView(this);
        msg.setTextColor(Color.WHITE); msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16); msg.setGravity(Gravity.CENTER);
        GradientDrawable mb = new GradientDrawable(); mb.setColor(Color.argb(200, 20, 20, 30)); mb.setCornerRadius(dp(14));
        msg.setBackground(mb); msg.setPadding(dp(24), dp(18), dp(24), dp(18)); msg.setVisibility(View.GONE);
        root.addView(msg, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));

        setContentView(root);

        // actions
        backBtn.setOnClickListener(v -> finishWithResult());
        playBtn.setOnClickListener(v -> togglePlay());
        rwBtn.setOnClickListener(v -> seekBy(-30));
        ffBtn.setOnClickListener(v -> seekBy(30));
        prevBtn.setOnClickListener(v -> zap(-1));
        nextBtn.setOnClickListener(v -> zap(1));
        aud.setOnClickListener(v -> audioMenu());
        sub.setOnClickListener(v -> subsMenu());
        scale.setOnClickListener(v -> cycleScale());
        numBtn.setOnClickListener(v -> numberPad());
        msg.setOnClickListener(v -> { msg.setVisibility(View.GONE); retries = 0; start(cur().url, isLive() ? 0 : Math.max(0, cur().lastPos * 1000)); });
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean user) { if (user) curTime.setText(fmt(p)); }
            @Override public void onStartTrackingTouch(SeekBar s) { seeking = true; h.removeCallbacks(hideCtl); }
            @Override public void onStopTrackingTouch(SeekBar s) { seeking = false; mp.setTime(s.getProgress() * 1000L); showControls(); }
        });

        gd = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onSingleTapConfirmed(MotionEvent e) { if (controlsShown) hideControls(); else showControls(); return true; }
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

    final Runnable hideCtl = this::hideControls;
    void showControls() {
        controls.setVisibility(View.VISIBLE); controlsShown = true;
        h.removeCallbacks(hideCtl);
        h.postDelayed(hideCtl, 4500);
    }
    void hideControls() {
        if (seeking) return;
        controls.setVisibility(View.GONE); controlsShown = false;
        hideSystemBars();
    }

    final Runnable hideOsd = () -> osd.setVisibility(View.GONE);
    void osd(String t) { osd.setText(t); osd.setVisibility(View.VISIBLE); h.removeCallbacks(hideOsd); h.postDelayed(hideOsd, 1000); }
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
            case KeyEvent.KEYCODE_SPACE: case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: case KeyEvent.KEYCODE_DPAD_CENTER: togglePlay(); return true;
            default: break;
        }
        return super.onKeyDown(code, e);
    }

    @Override public void onBackPressed() { finishWithResult(); }

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
        if (mp != null && !isLive() && mp.isPlaying()) mp.pause();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (mp != null && isLive()) mp.stop(); // free the server connection (only 1 allowed)
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        if (mp != null && isLive()) start(cur().url, 0);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        h.removeCallbacksAndMessages(null);
        if (result == null && !items.isEmpty()) result = buildResult(null);
        if (mp != null) {
            try { mp.stop(); mp.detachViews(); mp.release(); } catch (Exception ignored) { }
            mp = null;
        }
        if (vlc != null) { vlc.release(); vlc = null; }
    }
}
