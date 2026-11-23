# Alnur IPTV – Android tablet app

Same browsing UI as the Windows app (shared web code in `app/src/main/assets/www`, synced with `sync-web.sh`),
with a native VLC player screen (`PlayerActivity`). GitHub Actions builds a signed APK on every push to `main`
(Actions → Build APK → artifact `apk`).
