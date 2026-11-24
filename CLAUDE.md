# Alnur IPTV – Android tablet app (Xiaomi Pad 8)

Owner: Alnur (writes romanized Gujarati / Gujarati; answer in the same, short and clear). Always test before claiming something works.

## What this is
- Plain Android app (Java, minSdk 26, arm64 + armv7). No local Android SDK is reachable from Claude's sandbox:
  **GitHub Actions builds the APK** on every push to `main` (`.github/workflows/build.yml`), then force-pushes the APK to the
  **`apk` branch** (artifact downloads are blocked by the sandbox proxy; `git fetch --depth 1 origin apk` works).
- `MainActivity` = WebView showing the SAME web UI as the Windows app, served from `app/src/main/assets/www` at `https://app.alnur/`.
  `https://app.alnur/proxy?u=URL&ua=UA&h={json headers}` fetches from the IPTV server in Java (UA + redirects, no CORS).
- `PlayerActivity` = native full-screen player on **libVLC 3.6.0** (`org.videolan.android:libvlc-all`), touch controls
  (tap, swipe right=volume / left=brightness, double-tap ±10s, fling=channel, 123 number pad, audio/CC/aspect), resume, auto-next episode.
  Web → player: `AndroidNative.play(json {items,index,ua,autoNext})`; player → web: `window.__onPlayerResult(json {index, progress[], gotoNum})`.
- `web/android.js` (window.native shim: proxy, localStorage, IndexedDB lists), `web/android-post.js` (playFull override, back button),
  `web/android.css` (hides PC-only features: recording, downloads, online subtitles, EPG grid, diagnostics, backup).
- `sync-web.sh <windows-renderer-dir>` copies app.js / styles.css / index.html from the Windows app repo and injects the Android files.
  When the shared UI changes on Windows, re-sync here.
- Signing key `app/alnur-release.jks` (password in app/build.gradle) – every update MUST use the same key or Android refuses to update.
- Bump `versionCode` + `versionName` in `app/build.gradle` (and `BuildConfigHolder.VERSION`) for each release.

## IPTV server facts (same account as Windows app)
- Xtream Codes, http://toxicplay1.com:8080, account allows **1 connection at a time** (PC and tablet share it).
- API needs MAG/Dalvik-like UA; streams need VLC UA (`VLC/3.0.21 LibVLC/3.0.21`). nginx returns 503 when hammered.
- Many live channels are interlaced 1080i with AC3/MP2 audio (fine in VLC). No EPG programmes on this server.

## Delivery
Stable download link (always newest): https://github.com/jivanialnur/alnur-iptv-android/raw/apk/AlnurIPTV-Tablet.apk
APK goes to the user via SendUserFile + `C:\Users\HP\Downloads` (device_commit_files). Install: allow unknown apps, install over the old one.

## Status
- 1.0.0 installed on the tablet 2026-11-23; M3U login works.
- 1.0.1: Xtream login form forgives https/missing :8080, no auto-capitalize on login inputs (android-post.js).
- 1.1.0: player controls redesigned like the Windows player (bottom glass panel: seek row + mute/volume | aspect ⏮ ⟲30 ▶ 30⟳ ⏭ CC audio ⚙ | 123),
  top glass chips Link (copy/share) · Download (VOD, DownloadManager → Downloads/AlnurIPTV, stops playback: 1 connection) · Open in… (other app).
  Icons = vector drawables made from the Windows SVG paths (res/drawable/ic_*.xml).
- 2026-11-23: repo made PUBLIC (Actions were blocked by billing on private). 1.1.0 built OK, not yet tested on the tablet.
- 1.2.0: REAL glass: video drawn on a TextureView; `Blur` grabs a 1/10-size frame ~15×/s while controls/OSD are visible, box-blurs it,
  `GlassView` draws its part of that blurred frame + tint + highlight + border (bottom panel, chips, back button, OSD, message).
  Downloads work: `Downloads.java` (DownloadManager → Downloads/AlnurIPTV, VLC UA header, auto-retry 3× on 401/403/503 "busy"),
  bridge dlStart/dlList/dlCancel/dlShow, android.js polls every 1 s for the web ⬇ menu. Before 1.2.0 the web ⬇ buttons did nothing.
- Quality (480p/720p/1080p) of the Windows app only changes the PC's own re-encode (FFmpeg); the server sends one quality per stream
  (no HLS variants, m3u8 = 405) → not added on the tablet (VLC hardware-decodes 1080p/4K, nothing to gain).
- 1.2.1: glass v2 – BitmapShader (CLAMP: black bars show stretched video edge), saturation 1.7 + lift, 1/8 frame, radius 4,
  top sheen + gradient rim; floating panel (60dp side margins). Seek bar grey = buffered: secondaryProgress = time + 3 s cache +
  (readBytes − demuxReadBytes) / demuxBitrate from IMedia.Stats (estimate, smoothed).
- 1.2.2: portrait (CSS width ≈784 on the Pad 8) fixed in web/android.css @media (max-width:900px): narrower side list, search box shrinks,
  clock hidden, pager wraps, details modal stacked. "Open in VLC" → bridge openVlc (VLC app, else chooser).
  Layout test: /home/claude/pt/shot.js (Playwright, 784×1175 / 1175×784) + windows repo test/mock.js + test/android/srv.js.
- 1.3.0: "📺 Free Channels" card on the login/users screen (android-post.js + android.css, Android-only so sync-web.sh keeps it):
  one tap adds + opens a legal free M3U (iptv-org gh-pages via raw.githubusercontent: Gujarati, Hindi, India, South Africa,
  Mozambique, News, All world; Free-TV/IPTV playlist.m3u8). Doesn't use the Xtream account. User asked for pirated paid-channel
  links too – declined; only legal free playlists. Sandbox can't reach the stream hosts, so playback is only tested on the tablet.
- 1.4.0: 🔊 Sound – volume boost 100–200 % + Auto-level (default off), via Android DynamicsProcessing (API 28+) on VLC's own audio
  session (`--aout=android_audiotrack --audiotrack-session-id=<generateAudioSessionId>`), `Sound.java`: input gain (boost) →
  1-band MBC (auto-level: thr −30 dB, 4:1, attack 60 ms, release 1.2 s, +9 dB makeup, gate −70 dB) → limiter −1.5 dB (always on).
  Targets glide (~1.5 s). Saved in SharedPreferences "sound" (boost, auto). Player: 🔊 button after Next opens a glass panel from
  the right (video keeps playing). Web Settings: injected "🔊 Sound" section (android-post.js, bridge soundGet/soundSet).
  Removed `--no-stats` (it made the buffered-bar estimate dead). libVLC also has compressor/normvol/gain filters but they can't be
  changed live, hence DynamicsProcessing. Not yet tested on the tablet.
- 1.5.0 (user: "boost / auto-level did nothing, remove the 🔊 button"): 🔊 button + panel REMOVED. Volume is now one scale 0–200 %:
  0–100 = tablet volume, 100–200 = VLC `mp.setVolume(boost)` (audiotrack aout turns >100 into gain). Right-side swipe, bar slider
  (max 200) and the hardware + key stop at 150 % with a Gujarati warning; a new swipe / press goes on to 200 %. Boost saved (pref "sound").
  Auto-level = VLC `--audio-filter=normvol:compressor` (norm-max-level 1.6, compressor −24 dB 3:1, attack 50, release 800, makeup 7),
  fixed per engine → toggle in player ⚙ restarts the engine (`restartEngine`), or in web Settings (next video).
  `Sound.java` now only = DynamicsProcessing limiter (−1 dB) on the session (clipping protection).
  Player: compact bar (live = no seek row, ● LIVE beside volume), rotates (fullUser) with portrait layout (`adaptLayout`),
  Back / ← = minimise to picture-in-picture (close it from the small window), swipe DOWN in the middle third = minimise too.
  Result to the web goes via static `MainActivity.deliverPlayerResult()` (PiP runs in its own task). A new play closes the old player.
  Home: iOS-style glass theme in web/android.css (blur only on rail/side/topbar/pop-ups for speed; cards just see-through), dark variant.
- 1.5.1: jumping inside the grey (buffered) part reconnected + grey bar lied after jumps. Now VOD media get
  `:stream-filter=prefetch` (128 MB ring buffer, 1 MB reads, forward seek threshold 128 MB) → jumps inside it play from memory.
  Grey bar = (readBytes − demuxReadBytes − value at the last jump) ÷ smoothed demuxBitrate + 3 s; resets to 0 on every jump/new media
  (`markSeek`), so it never shows more than is really there. Not yet tested on the tablet.
