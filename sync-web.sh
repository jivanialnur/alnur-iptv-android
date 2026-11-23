#!/bin/bash
# copies the shared web UI from the Windows app and adds the Android parts
set -e
SRC=${1:-/home/claude/iptv/renderer}
DST=$(dirname "$0")/app/src/main/assets/www
mkdir -p "$DST"
cp "$SRC/app.js" "$SRC/styles.css" "$DST/"
cp "$(dirname "$0")"/web/android.js "$(dirname "$0")"/web/android-post.js "$(dirname "$0")"/web/android.css "$DST/"
python3 - "$SRC/index.html" "$DST/index.html" <<'PY'
import sys,re
s=open(sys.argv[1]).read()
s=s.replace('<meta charset="UTF-8">','<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">')
s=re.sub(r'<script src="\.\./node_modules/[^"]+"></script>\n?','',s)
s=s.replace('<link rel="stylesheet" href="styles.css">','<link rel="stylesheet" href="styles.css">\n<link rel="stylesheet" href="android.css">')
s=s.replace('<script src="app.js"></script>','<script src="android.js"></script>\n<script src="app.js"></script>\n<script src="android-post.js"></script>')
open(sys.argv[2],'w').write(s)
PY
ls -la "$DST"
