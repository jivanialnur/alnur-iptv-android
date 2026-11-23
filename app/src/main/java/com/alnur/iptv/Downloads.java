package com.alnur.iptv;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Movie / episode downloads through Android's DownloadManager (keeps going in the background, shows a notification).
 * Files go to Downloads/AlnurIPTV. Our download ids are remembered so the ⬇ menu can list them.
 */
final class Downloads {
    static final String PREF = "downloads", KEY = "ids";

    static DownloadManager dm(Context c) { return (DownloadManager) c.getSystemService(Context.DOWNLOAD_SERVICE); }

    static String safeName(String name) {
        String s = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]+", " ").replaceAll("\\s+", " ").trim();
        if (s.isEmpty()) s = "video.mp4";
        if (s.length() > 120) {
            int dot = s.lastIndexOf('.');
            String ext = dot > 0 && s.length() - dot <= 6 ? s.substring(dot) : "";
            s = s.substring(0, 120 - ext.length()).trim() + ext;
        }
        return s;
    }

    /** @return download id, or -1 (error text in err[0]) */
    static long start(Context c, String url, String name, String ua, String[] err) { return start(c, url, name, ua, err, 0); }

    static long start(Context c, String url, String name, String ua, String[] err, int attempt) {
        try {
            String file = safeName(name);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.addRequestHeader("User-Agent", ua == null || ua.isEmpty() ? "VLC/3.0.21 LibVLC/3.0.21" : ua);
            r.setTitle(file);
            r.setDescription("Alnur IPTV");
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "AlnurIPTV/" + file);
            r.setAllowedOverMetered(true);
            r.setAllowedOverRoaming(true);
            long id = dm(c).enqueue(r);
            SharedPreferences p = c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            String ids = p.getString(KEY, "");
            p.edit().putString(KEY, ids.isEmpty() ? String.valueOf(id) : ids + "," + id).apply();
            ATTEMPT.put(id, attempt);
            watch(c.getApplicationContext(), id, url, name, ua, attempt);
            return id;
        } catch (Exception e) {
            if (err != null && err.length > 0) err[0] = e.getClass().getSimpleName() + ": " + e.getMessage();
            return -1;
        }
    }

    static final java.util.HashMap<Long, Integer> ATTEMPT = new java.util.HashMap<>();
    static boolean retriable(int why) { return why == 401 || why == 403 || why == 503 || why == 502 || why == DownloadManager.ERROR_UNHANDLED_HTTP_CODE; }
    static final android.os.Handler H = new android.os.Handler(android.os.Looper.getMainLooper());

    /** The account allows 1 connection: right after playback stops the server still says "busy" (401) for a moment.
     *  If the download fails like that, quietly start it again (up to 4 tries, a few seconds apart). */
    static void watch(Context c, long id, String url, String name, String ua, int attempt) {
        H.postDelayed(() -> {
            Cursor q = null;
            try {
                q = dm(c).query(new DownloadManager.Query().setFilterById(id));
                if (q == null || !q.moveToFirst()) return;
                int st = q.getInt(q.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                int why = q.getInt(q.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                if (st == DownloadManager.STATUS_FAILED && retriable(why) && attempt < 3) {
                    try { dm(c).remove(id); } catch (Exception ignored) { }
                    forget(c, id);
                    start(c, url, name, ua, null, attempt + 1);
                } else if (st == DownloadManager.STATUS_PENDING) {
                    watch(c, id, url, name, ua, attempt); // still connecting: look again a bit later
                }
            } catch (Exception ignored) {
            } finally { if (q != null) q.close(); }
        }, 3000L + attempt * 2000L);
    }

    static long[] ids(Context c) {
        String s = c.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, "");
        if (s.isEmpty()) return new long[0];
        String[] a = s.split(",");
        long[] r = new long[a.length];
        int n = 0;
        for (String x : a) try { r[n++] = Long.parseLong(x.trim()); } catch (Exception ignored) { }
        return java.util.Arrays.copyOf(r, n);
    }

    static void forget(Context c, long id) {
        StringBuilder b = new StringBuilder();
        for (long x : ids(c)) if (x != id) { if (b.length() > 0) b.append(','); b.append(x); }
        c.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString(KEY, b.toString()).apply();
    }

    static String reason(int code) {
        switch (code) {
            case 401: case 403: return "Server refused (busy – the account allows 1 connection; stop playback and try again)";
            case 404: return "File not found on the server";
            case 503: return "Server busy (HTTP 503) – try again in a few minutes";
            case DownloadManager.ERROR_INSUFFICIENT_SPACE: return "Not enough storage space";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS: return "Too many redirects";
            case DownloadManager.ERROR_HTTP_DATA_ERROR: return "Connection broke";
            case DownloadManager.ERROR_CANNOT_RESUME: return "Connection broke and could not resume";
            case DownloadManager.ERROR_FILE_ERROR: case DownloadManager.ERROR_DEVICE_NOT_FOUND: return "Could not save the file";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE: return "Server answered with an error";
            default: return code >= 100 && code < 600 ? "Server error HTTP " + code : "Error " + code;
        }
    }

    /** JSON list for the web ⬇ menu: [{id,name,state,got,total,error,file}] newest last */
    static String list(Context c) {
        JSONArray out = new JSONArray();
        long[] ids = ids(c);
        if (ids.length == 0) return out.toString();
        Cursor q = null;
        try {
            q = dm(c).query(new DownloadManager.Query().setFilterById(ids));
            java.util.HashMap<Long, JSONObject> byId = new java.util.HashMap<>();
            while (q != null && q.moveToNext()) {
                long id = q.getLong(q.getColumnIndexOrThrow(DownloadManager.COLUMN_ID));
                int st = q.getInt(q.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                int why = q.getInt(q.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                JSONObject o = new JSONObject();
                o.put("id", id);
                o.put("name", q.getString(q.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)));
                o.put("got", q.getLong(q.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
                long tot = q.getLong(q.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                o.put("total", tot > 0 ? tot : 0);
                o.put("file", String.valueOf(id));
                String state;
                switch (st) {
                    case DownloadManager.STATUS_PENDING: state = "starting"; break;
                    case DownloadManager.STATUS_RUNNING: state = "downloading"; break;
                    case DownloadManager.STATUS_PAUSED: state = "waiting"; break;
                    case DownloadManager.STATUS_SUCCESSFUL: state = "done"; break;
                    default:
                        Integer at = ATTEMPT.get(id);
                        if (retriable(why) && at != null && at < 3) state = "waiting"; // will be started again in a moment
                        else { state = "error"; o.put("error", reason(why)); }
                }
                o.put("state", state);
                byId.put(id, o);
            }
            for (long id : ids) { JSONObject o = byId.get(id); if (o != null) out.put(o); }
        } catch (Exception ignored) {
        } finally { if (q != null) q.close(); }
        return out.toString();
    }

    static void cancel(Context c, long id) {
        try { dm(c).remove(id); } catch (Exception ignored) { }
        forget(c, id);
    }

    /** open a finished file in a video app, or the Downloads screen when id <= 0 */
    static void show(Context c, long id) {
        try {
            if (id > 0) {
                Uri u = dm(c).getUriForDownloadedFile(id);
                if (u != null) {
                    String mime = dm(c).getMimeTypeForDownloadedFile(id);
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(u, mime == null || mime.isEmpty() || mime.equals("application/octet-stream") ? "video/*" : mime);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(Intent.createChooser(i, "Play with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    return;
                }
            }
            c.startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            try { c.startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
        }
    }
}
