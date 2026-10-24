package io.github.ekotov.openwetter;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
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
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(12,23,40));
        getWindow().setNavigationBarColor(Color.rgb(16,28,46));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(16,28,46));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(webView);
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
