package cn.diandian.counter;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.RenderProcessGoneDetail;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** A fully offline WebView with a fixed origin, private storage and SAF exports. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int EXPORT_REQUEST = 10;
    // 0 idle, 1 preparing, 2 waiting for the document picker, 3 writing.
    private static final AtomicInteger EXPORT_STATE = new AtomicInteger(0);
    private WebView web;
    private FrameLayout root;
    private File pendingFile;
    private boolean backPending;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        pendingFile = new File(getFilesDir(), "pending-export.json");
        if (saved != null && saved.getBoolean("exporting") && pendingFile.isFile())
            EXPORT_STATE.compareAndSet(0, 2);
        else if (EXPORT_STATE.get() == 0) {
            pendingFile.delete();
            new File(getFilesDir(), "pending-export.tmp").delete();
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(247, 248, 250));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        createWebView();
        String restored = saved == null ? null : saved.getString("pageUrl");
        if (restored != null && isLocal(Uri.parse(restored)) && "/index.html".equals(Uri.parse(restored).getPath())) web.loadUrl(restored);
        else web.loadUrl(START_URL);
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(247, 248, 250));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        if (root.getParent() == null) setContentView(root);
        root.requestApplyInsets();
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new ExportBridge(), "DiandianAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!isLocal(uri)) return errorResponse(403, "Forbidden");
                String path = uri.getPath();
                String asset;
                String mime;
                if ("/index.html".equals(path)) { asset = "index.html"; mime = "text/html"; }
                else if ("/styles.css".equals(path)) { asset = "styles.css"; mime = "text/css"; }
                else if ("/store.js".equals(path)) { asset = "store.js"; mime = "application/javascript"; }
                else if ("/persistence.js".equals(path)) { asset = "persistence.js"; mime = "application/javascript"; }
                else if ("/app.js".equals(path)) { asset = "app.js"; mime = "application/javascript"; }
                else return errorResponse(404, "Not Found");
                try { return new WebResourceResponse(mime, "UTF-8", getAssets().open(asset)); }
                catch (Exception e) { return errorResponse(404, "Not Found"); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocal(request.getUrl()) || !"/index.html".equals(request.getUrl().getPath());
            }
            @Override public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript("(typeof BigInt==='function' && typeof document.body.replaceChildren==='function' && typeof HTMLDialogElement!=='undefined' && typeof HTMLDialogElement.prototype.showModal==='function')", result -> {
                    if ("false".equals(result) && !isFinishing() && !isDestroyed() && web == view) new AlertDialog.Builder(MainActivity.this)
                        .setTitle("请更新系统 WebView")
                        .setMessage("此手机的网页组件版本较旧。请更新 Android System WebView 或 Chrome，再打开点点计数。")
                        .setPositiveButton("知道了", null).show();
                });
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (view.getParent() == root) root.removeView(view);
                view.destroy();
                if (web == view) {
                    web = null;
                    backPending = false;
                    if (!isFinishing() && !isDestroyed()) {
                        createWebView();
                        web.loadUrl(START_URL);
                        notifyExport("页面已重新加载");
                    }
                }
                return true;
            }
        });
    }

    private static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }
    private static WebResourceResponse errorResponse(int code, String message) {
        return new WebResourceResponse("text/plain", "UTF-8", code, message, null, new ByteArrayInputStream(new byte[0]));
    }
    private void notifyExport(String message) {
        runOnUiThread(() -> Toast.makeText(getApplicationContext(), message, Toast.LENGTH_LONG).show());
    }
    public final class ExportBridge {
        @JavascriptInterface public void exportJson(String json, String filename) {
            if (json == null || json.length() > 16 * 1024 * 1024) { notifyExport("导出内容过大，未保存"); return; }
            if (!EXPORT_STATE.compareAndSet(0, 1)) { notifyExport("请先完成正在进行的导出"); return; }
            try {
                new JSONObject(json);
                String safeName = filename == null ? "点点计数.json" : filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                if (safeName.length() > 120) safeName = safeName.substring(0, 115) + ".json";
                if (!safeName.endsWith(".json")) safeName += ".json";
                File temporary = new File(getFilesDir(), "pending-export.tmp");
                try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(json.getBytes(StandardCharsets.UTF_8)); }
                if (pendingFile.exists() && !pendingFile.delete()) throw new java.io.IOException("Cannot replace pending export");
                if (!temporary.renameTo(pendingFile)) throw new java.io.IOException("Cannot prepare pending export");
                final String title = safeName;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) { clearExport(); return; }
                    try {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/json");
                        intent.putExtra(Intent.EXTRA_TITLE, title);
                        startActivityForResult(intent, EXPORT_REQUEST);
                        EXPORT_STATE.compareAndSet(1, 2);
                    } catch (Exception e) { clearExport(); notifyExport("无法打开文件保存窗口，请稍后重试"); }
                });
            } catch (Exception e) { clearExport(); notifyExport("导出准备失败，未保存文件"); }
        }
    }
    private void clearExport() {
        pendingFile.delete();
        new File(getFilesDir(), "pending-export.tmp").delete();
        EXPORT_STATE.set(0);
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != EXPORT_REQUEST) return;
        if (!EXPORT_STATE.compareAndSet(2, 3)) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) { clearExport(); notifyExport("已取消导出"); return; }
        final Uri uri = data.getData();
        new Thread(() -> {
            try (InputStream in = new FileInputStream(pendingFile); OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new java.io.IOException("No output stream");
                byte[] buffer = new byte[8192]; int size;
                while ((size = in.read(buffer)) != -1) out.write(buffer, 0, size);
                out.flush();
            } catch (Exception e) { clearExport(); notifyExport("文件保存失败，请重新导出"); return; }
            clearExport();
            notifyExport("记录已保存到所选文件");
        }, "counter-export").start();
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out); out.putString("pageUrl", web == null ? START_URL : web.getUrl()); out.putBoolean("exporting", EXPORT_STATE.get() == 2);
    }
    @Override public void onBackPressed() {
        if (backPending || web == null || isFinishing() || isDestroyed()) return;
        backPending = true;
        final WebView current = web;
        current.evaluateJavascript("(function(){var d=document.querySelector('dialog[open]');if(d){d.close();return true;}return false;})()", result -> {
            backPending = false;
            if (isFinishing() || isDestroyed() || web != current) return;
            if ("true".equals(result)) return;
            if (current.canGoBack()) current.goBack(); else finish();
        });
    }
    @Override protected void onDestroy() {
        if (isFinishing() && EXPORT_STATE.get() == 2) clearExport();
        if (web != null) { root.removeView(web); web.removeJavascriptInterface("DiandianAndroid"); web.destroy(); web = null; }
        super.onDestroy();
    }
}
