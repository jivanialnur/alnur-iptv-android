package com.alnur.iptv;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * The browsing UI is the same web UI as the Windows app, served from the APK at https://app.alnur/.
 * https://app.alnur/proxy?u=URL&ua=UA&h={headers} fetches anything from the IPTV server with the right
 * User-Agent (no CORS problems). Playing a channel opens PlayerActivity (VLC engine).
 */
public class MainActivity extends Activity {
    static final String HOST = "app.alnur";
    static final int REQ_PLAY = 7;
    WebView web;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F3F5FA"));
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Bridge(), "AndroidNative");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) { android.util.Log.i("AlnurWeb", m.message() + " @" + m.lineNumber()); return true; }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null; // logos etc. load normally
                String path = u.getPath() == null ? "/" : u.getPath();
                if (path.equals("/proxy")) return proxy(u);
                return asset(path);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        if (b != null) web.restoreState(b);
        else web.loadUrl("https://" + HOST + "/index.html");
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    WebResourceResponse asset(String path) {
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        String file = "www" + path;
        String mime = "text/plain";
        if (path.endsWith(".html")) mime = "text/html";
        else if (path.endsWith(".js")) mime = "application/javascript";
        else if (path.endsWith(".css")) mime = "text/css";
        else if (path.endsWith(".png")) mime = "image/png";
        else if (path.endsWith(".svg")) mime = "image/svg+xml";
        else if (path.endsWith(".json")) mime = "application/json";
        try {
            InputStream in = getAssets().open(file);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime, "utf-8", 200, "OK", h, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
        }
    }

    WebResourceResponse proxy(Uri u) {
        String target = u.getQueryParameter("u");
        String ua = u.getQueryParameter("ua");
        String hj = u.getQueryParameter("h");
        Map<String, String> out = new HashMap<>();
        out.put("Access-Control-Allow-Origin", "*");
        out.put("Access-Control-Expose-Headers", "X-Error");
        out.put("Cache-Control", "no-store");
        HttpURLConnection c = null;
        try {
            String cur = target;
            for (int hop = 0; hop < 6; hop++) {
                URL url = new URL(cur);
                c = (HttpURLConnection) url.openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                c.setRequestProperty("User-Agent", ua == null || ua.isEmpty() ? "VLC/3.0.21 LibVLC/3.0.21" : ua);
                c.setRequestProperty("Accept", "*/*");
                c.setRequestProperty("Accept-Encoding", "gzip");
                if (hj != null && !hj.isEmpty()) {
                    JSONObject h = new JSONObject(hj);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, h.getString(k)); }
                }
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                    cur = new URL(url, c.getHeaderField("Location")).toString();
                    c.disconnect();
                    continue;
                }
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                if (in == null) in = new ByteArrayInputStream(new byte[0]);
                if ("gzip".equalsIgnoreCase(c.getContentEncoding())) in = new GZIPInputStream(in);
                String ct = c.getContentType();
                String mime = ct == null ? "application/octet-stream" : ct.split(";")[0].trim();
                int st = (code >= 200 && code < 300) || (code >= 400 && code < 600) ? code : 502;
                String reason = c.getResponseMessage();
                if (reason == null || reason.isEmpty()) reason = "Status";
                return new WebResourceResponse(mime, "utf-8", st, reason, out, in);
            }
            return err(out, "Too many redirects");
        } catch (Exception e) {
            if (c != null) c.disconnect();
            String m = e.getClass().getSimpleName() + ": " + e.getMessage();
            if (e instanceof java.net.SocketTimeoutException) m = "Timeout - server not responding";
            else if (e instanceof java.net.UnknownHostException) m = "Server not found (check internet / URL)";
            return err(out, m);
        }
    }

    WebResourceResponse err(Map<String, String> h, String msg) {
        h.put("X-Error", msg.replaceAll("[\\r\\n]", " "));
        return new WebResourceResponse("text/plain", "utf-8", 599, "Network Error", h, new ByteArrayInputStream(msg.getBytes(StandardCharsets.UTF_8)));
    }

    void js(String code) { runOnUiThread(() -> web.evaluateJavascript(code, null)); }

    class Bridge {
        @JavascriptInterface public String platform() { return "android"; }
        @JavascriptInterface public String version() { return BuildConfigHolder.VERSION; }
        @JavascriptInterface public void play(String json) {
            PlayerActivity.pending = json;
            runOnUiThread(() -> startActivityForResult(new Intent(MainActivity.this, PlayerActivity.class), REQ_PLAY));
        }
        @JavascriptInterface public void copy(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("text", text));
            });
        }
        @JavascriptInterface public void openUrl(String url) {
            runOnUiThread(() -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { } });
        }
        @JavascriptInterface public void toast(String t) { runOnUiThread(() -> Toast.makeText(MainActivity.this, t, Toast.LENGTH_SHORT).show()); }
        @JavascriptInterface public void exit() { runOnUiThread(() -> moveTaskToBack(true)); }
        @JavascriptInterface public void keepAwake(boolean on) {
            runOnUiThread(() -> { if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); });
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PLAY) {
            String r = PlayerActivity.result;
            PlayerActivity.result = null;
            if (r != null) js("window.__onPlayerResult && window.__onPlayerResult(" + JSONObject.quote(r) + ")");
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.__androidBack && window.__androidBack()) ? 1 : 0", v -> {
            if (!"1".equals(v)) moveTaskToBack(true);
        });
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
}
