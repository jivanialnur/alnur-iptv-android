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
