package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.WebViewAssetLoader;
import java.util.ArrayList;

public final class MainActivity extends androidx.activity.ComponentActivity {
  private Engine engine;
  private WebView web;

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    try {
      engine = Engine.get(this);
    } catch (Exception e) {
      new AlertDialog.Builder(this)
          .setMessage(e.getMessage())
          .setPositiveButton("Close", (d, w) -> finish())
          .show();
      return;
    }
    getOnBackPressedDispatcher()
        .addCallback(
            this,
            new androidx.activity.OnBackPressedCallback(true) {
              @Override
              public void handleOnBackPressed() {
                leavePlayer();
              }
            });
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(252, 252, 248));
    setContentView(web);
    web.setOnApplyWindowInsetsListener(
        (v, insets) -> {
          if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets i =
                insets.getInsets(android.view.WindowInsets.Type.systemBars());
            v.setPadding(i.left, i.top, i.right, i.bottom);
          } else
            v.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom());
          return insets;
        });
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    WebViewAssetLoader loader =
        new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            if ("appassets.androidplatform.net".equals(u.getHost())
                && "https".equals(u.getScheme())) return loader.shouldInterceptRequest(u);
            return new WebResourceResponse(
                "text/plain", "UTF-8", new java.io.ByteArrayInputStream(new byte[0]));
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            return true;
          }
        });
    web.addJavascriptInterface(new Bridge(), "CasaNative");
    web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    ArrayList<String> permissions = new ArrayList<>();
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            != android.content.pm.PackageManager.PERMISSION_GRANTED)
      permissions.add(android.Manifest.permission.POST_NOTIFICATIONS);
    if (!permissions.isEmpty()) requestPermissions(permissions.toArray(new String[0]), 1);
  }

  private final class Bridge {
    @JavascriptInterface
    public String state() {
      return engine.snapshot();
    }

    @JavascriptInterface
    public void action(String action, String value) {
      if (value == null || value.length() > ("start".equals(action) ? 1200 : 254)) return;
      switch (action) {
        case "setup":
          runOnUiThread(() -> setup());
          break;
        case "start":
          engine.start(value.trim());
          break;
        case "stop":
          engine.requestStop();
          break;
        case "recover":
          engine.recover();
          break;
        case "retry-upload":
          engine.retryUpload(value.trim());
          break;
        case "reset":
          engine.reset();
          break;
        case "discard":
          runOnUiThread(
              () ->
                  new AlertDialog.Builder(MainActivity.this)
                      .setTitle("Discard saved footage?")
                      .setMessage(
                          "This permanently deletes the unsent video from this tablet. Try Recover"
                              + " first.")
                      .setPositiveButton("Delete video", (d, w) -> engine.discard())
                      .setNegativeButton("Keep video", null)
                      .show());
          break;
      }
    }
  }

  private LinearLayout panel() {
    LinearLayout p = new LinearLayout(this);
    p.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (20 * getResources().getDisplayMetrics().density);
    p.setPadding(pad, pad, pad, pad);
    return p;
  }

  private EditText field(LinearLayout p, String label, String value, boolean secret) {
    TextView title = new TextView(this);
    title.setText(label);
    p.addView(title);
    EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setText(value);
    input.setInputType(secret ? 129 : 1);
    p.addView(input);
    return input;
  }

  private void setup() {
    if (engine.busy) {
      Toast.makeText(this, "Finish the current operation first.", Toast.LENGTH_SHORT).show();
      return;
    }
    if (!engine.server.optBoolean("enabled")) {
      LinearLayout p = panel();
      TextView help = new TextView(this);
      help.setText(
          "Use a code created for the Android device’s own camera or an external Wi-Fi camera"
              + " in Admin / Devices & cameras.");
      p.addView(help);
      EditText code = field(p, "Enrollment code from Admin / Devices & cameras", "", false);
      new AlertDialog.Builder(this)
          .setTitle("Register this tablet")
          .setView(p)
          .setPositiveButton("Enroll", (d, w) -> engine.enroll(code.getText().toString()))
          .setNegativeButton("Cancel", null)
          .show();
      return;
    }
    boolean deviceCamera = engine.usesDeviceCamera();
    boolean wifiCamera = engine.usesWifiCamera();
    if (deviceCamera && !DeviceCameraRecorder.hasPermissions(this))
      requestPermissions(
          new String[] {
            android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO
          },
          2);
    new AlertDialog.Builder(this)
        .setTitle(
            deviceCamera
                ? "Android camera mode"
                : wifiCamera ? "Tapo Wi-Fi camera mode" : "Camera setup incomplete")
        .setMessage(
            deviceCamera
                ? "Uses this Android device’s rear camera and microphone. Allow both permissions, then test the camera."
                : wifiCamera
                    ? "Uses the external Tapo stream on the same Wi-Fi. This Android camera and microphone are not used."
                    : "Choose Android camera or Tapo Wi-Fi camera in Admin / Devices & cameras, then return here.")
        .setPositiveButton(
            wifiCamera ? "Test Tapo camera" : deviceCamera ? "Test Android camera" : "Check again",
            (d, w) -> engine.syncCamera())
        .setNegativeButton("Close", null)
        .show();
  }

  @Override
  public void onResume() {
    super.onResume();
    if (engine != null) engine.visible = true;
  }

  @Override
  public void onPause() {
    if (engine != null) engine.visible = false;
    super.onPause();
  }

  private void leavePlayer() {
    if (engine != null && engine.busy)
      new AlertDialog.Builder(this)
          .setMessage("Recording or upload will continue in the background.")
          .setPositiveButton("Leave app", (d, w) -> moveTaskToBack(true))
          .setNegativeButton("Stay", null)
          .show();
    else finish();
  }

  @Override
  public void onDestroy() {
    if (web != null) {
      web.removeJavascriptInterface("CasaNative");
      web.destroy();
    }
    super.onDestroy();
  }
}
