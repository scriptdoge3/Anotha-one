package com.loadbank.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Load Bank — Android shell.
 *
 * The whole game is a static web app in assets/. It is NOT loaded over
 * file:// , because that would break it twice over:
 *
 *   1. ES module imports are subject to CORS, and a file:// document has an
 *      opaque origin, so every `import` would be blocked.
 *   2. localStorage is unreliable-to-unavailable on file:// origins, which
 *      would silently lose the player's career.
 *
 * Instead the assets are served through shouldInterceptRequest under a real
 * https origin. The WebView never actually touches the network — every request
 * for this host is answered from the APK — but the page gets a proper secure
 * origin, so modules load and storage persists.
 */
public class MainActivity extends Activity {

    /** Synthetic origin. Nothing is ever fetched from the real internet. */
    private static final String HOST = "loadbank.localhost";
    private static final String ORIGIN = "https://" + HOST;
    private static final String START_URL = ORIGIN + "/index.html";

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("woff2", "font/woff2");
        MIME.put("ico", "image/x-icon");
    }

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // It is a simulation you sit and watch; do not let the screen sleep.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the save file lives here
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // The manifest requests no INTERNET permission at all, so the OS itself
        // makes off-device loads impossible. That is a stronger guarantee than
        // setBlockNetworkLoads(), and it cannot interfere with the interceptor.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        web.setBackgroundColor(0xFF1A1613);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new AssetClient(getAssets()));

        setContentView(web);
        goImmersive();

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
    }

    /** Edge-to-edge, with the system bars swiped back in on demand. */
    private void goImmersive() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    /**
     * Back steps out of an open dialog first; only then does it leave the app,
     * so a stray tap never drops you out of a running job.
     */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){var m=document.getElementById('modal');"
                        + "if(m&&!m.classList.contains('hidden')){m.classList.add('hidden');return 'handled';}"
                        + "return 'exit';})()",
                value -> {
                    if (value == null || !value.contains("handled")) {
                        finish();
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Flush the save; the web layer persists on visibilitychange.
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Answers every request for our synthetic origin out of the APK's assets. */
    private static class AssetClient extends WebViewClient {
        private final AssetManager assets;

        AssetClient(AssetManager assets) {
            this.assets = assets;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!HOST.equals(request.getUrl().getHost())) {
                return null;
            }
            String path = request.getUrl().getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            // Never let a crafted path climb out of the assets directory.
            if (path.contains("..")) {
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, null);
            }
            String rel = path.startsWith("/") ? path.substring(1) : path;

            Map<String, String> headers = new HashMap<>();
            // The page is fully self-contained; forbid it reaching anywhere else.
            headers.put("Content-Security-Policy",
                    "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                            + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'");

            try {
                InputStream in = assets.open(rel);
                return new WebResourceResponse(mimeOf(rel), "utf-8", 200, "OK", headers, in);
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
            }
        }

        /** Keep every navigation inside the app. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !HOST.equals(request.getUrl().getHost());
        }

        private static String mimeOf(String path) {
            int dot = path.lastIndexOf('.');
            String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase();
            String mime = MIME.get(ext);
            return mime != null ? mime : "application/octet-stream";
        }
    }
}
