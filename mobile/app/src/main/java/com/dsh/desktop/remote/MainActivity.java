package com.dsh.desktop.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.Toast;

/**
 * DSH 遥控器 —— 手机端 WebView 壳，连接电脑上 DSH Desktop 已开启的
 * 「手机 / 局域网访问」地址。首次使用粘贴完整地址（含 token），之后自动记住。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "dsh_remote";
    private static final String KEY_URL = "server_url";

    private WebView web;
    private View setup;
    private EditText urlInput;
    private SharedPreferences prefs;
    private String serverUrl = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        web = findViewById(R.id.web);
        setup = findViewById(R.id.setup);
        urlInput = findViewById(R.id.inp_url);
        ImageButton menu = findViewById(R.id.btn_menu);

        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 全部留在应用内展示；dsh 页面本身会带 token 跳转
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }
        });

        menu.setOnClickListener(v -> showMenu());
        findViewById(R.id.btn_connect).setOnClickListener(v -> connect());

        serverUrl = prefs.getString(KEY_URL, "");
        if (serverUrl.isEmpty()) {
            showSetup();
        } else {
            web.loadUrl(serverUrl);
        }
    }

    private void showSetup() {
        setup.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
        if (!serverUrl.isEmpty()) urlInput.setText(serverUrl);
    }

    private void connect() {
        String raw = urlInput.getText().toString().trim();
        if (raw.isEmpty()) {
            Toast.makeText(this, "请先粘贴电脑端显示的完整地址", Toast.LENGTH_SHORT).show();
            return;
        }
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
            raw = "http://" + raw;
        }
        try {
            Uri u = Uri.parse(raw);
            if (u.getHost() == null || u.getHost().isEmpty()) throw new IllegalArgumentException();
        } catch (Exception e) {
            Toast.makeText(this, "地址格式不对，请核对后重试", Toast.LENGTH_SHORT).show();
            return;
        }
        serverUrl = raw;
        prefs.edit().putString(KEY_URL, raw).apply();
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(serverUrl);
    }

    private void showMenu() {
        new AlertDialog.Builder(this)
                .setItems(new CharSequence[]{ "刷新页面", "更换服务器地址" }, (d, which) -> {
                    if (which == 0) {
                        web.reload();
                    } else {
                        showSetup();
                    }
                })
                .show();
    }

    private void showOffline() {
        String html = "<html><body style='font-family:sans-serif;background:#f6f7fb;"
                + "display:flex;align-items:center;justify-content:center;height:90%;margin:0'>"
                + "<div style='text-align:center;color:#6b7280'>"
                + "<p style='font-size:18px;color:#1a1f36'>连不上电脑上的 DSH</p>"
                + "<p style='font-size:13px;line-height:1.8'>请确认：电脑端服务正在运行、<br/>手机与电脑在同一网络 / VPN 已连接。</p>"
                + "<a href=\"" + serverUrl + "\" style='color:#4d6bfe;font-size:15px'>点此重试</a>"
                + "</div></body></html>";
        web.loadData(html, "text/html; charset=utf-8", "utf-8");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 返回键先让页面回退（dsh 页面内部有导航），退无可退再退出应用
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()
                && web.getVisibility() == View.VISIBLE) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
