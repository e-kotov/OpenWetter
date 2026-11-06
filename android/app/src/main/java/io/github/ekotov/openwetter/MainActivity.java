package io.github.ekotov.openwetter;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.os.Bundle;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
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
 * Minimal dependency-free native shell for OpenWetter's installable web UI.
 * It does not request unrestricted file URL access and allows only HTTPS.
 */
public class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final int GEO_REQUEST = 410;
    private WebView webView;
    private FrameLayout appContent;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 15+ draws apps behind the status / navigation bars when targeting 35.
        // Make this explicit across supported versions and apply real system insets below;
        // do not rely on CSS safe-area values inside an Android WebView.
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        appContent = new FrameLayout(this);
        appContent.setBackgroundColor(Color.rgb(12, 23, 40));
        appContent.setOnApplyWindowInsetsListener((view, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom;
                // Keep the location search visible above the on-screen keyboard too.
                if (insets.isVisible(WindowInsets.Type.ime())) {
                    bottom = Math.max(bottom, insets.getInsets(WindowInsets.Type.ime()).bottom);
                }
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                    left = Math.max(left, insets.getDisplayCutout().getSafeInsetLeft());
                    top = Math.max(top, insets.getDisplayCutout().getSafeInsetTop());
                    right = Math.max(right, insets.getDisplayCutout().getSafeInsetRight());
                    bottom = Math.max(bottom, insets.getDisplayCutout().getSafeInsetBottom());
                }
            }
            view.setPadding(left, top, right, bottom);
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(16,28,46));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        appContent.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(appContent);
        appContent.requestApplyInsets();
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString()+" OpenWetterWeather/0.1");
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url=request.getUrl();
                if (!"https".equalsIgnoreCase(url.getScheme()) || !APP_HOST.equals(url.getHost())) return null;
                String file = url.getPath();
                if (file == null || file.equals("/")) file="/index.html";
                file=file.substring(1);
                // Reject path traversal and hidden files. Only bundled local assets are served.
                if (file.contains("..") || file.startsWith(".")) return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",new HashMap<>(),null);
                String mime = file.endsWith(".html") ? "text/html" :
                    file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript" :
                    file.endsWith(".css") ? "text/css" :
                    file.endsWith(".json") || file.endsWith(".webmanifest") ? "application/json" :
                    file.endsWith(".png") ? "image/png" :
                    file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
                try {
                    InputStream stream = getAssets().open(file);
                    Map<String,String> headers = new HashMap<>();
                    headers.put("Cache-Control","public, max-age=3600");
                    return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,stream);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",new HashMap<>(),null);
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url=request.getUrl();
                if ("https".equals(url.getScheme()) && APP_HOST.equals(url.getHost())) return false;
                // Open external credit/provider links in the user's browser.
                if ("https".equals(url.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,url)); } catch (Exception ignored) { }
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!origin.startsWith("https://"+APP_HOST)) { callback.invoke(origin,false,false);return; }
                if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED ||
                    checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin,true,false);
                } else {
                    pendingGeoOrigin=origin;
                    pendingGeoCallback=callback;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION},GEO_REQUEST);
                }
            }
        });
        webView.loadUrl("https://"+APP_HOST+"/index.html?no-sw=1");
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode,permissions,grants);
        if (requestCode == GEO_REQUEST && pendingGeoCallback != null) {
            boolean granted=false;
            for(int result:grants)if(result==PackageManager.PERMISSION_GRANTED)granted=true;
            pendingGeoCallback.invoke(pendingGeoOrigin,granted,false);
            pendingGeoCallback=null;pendingGeoOrigin=null;
        }
    }
    @Override public void onBackPressed() {
        if(webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        webView.destroy();super.onDestroy();
    }
}
