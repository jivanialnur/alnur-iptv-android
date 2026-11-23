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
