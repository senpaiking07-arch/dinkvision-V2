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
import org.json.JSONObject;

public final class MainActivity extends androidx.activity.ComponentActivity {
  private Engine engine;
  private WebView web;
  private boolean configureDeviceCameraAfterPermission;

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
                handleBackPressed();
              }
            });
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(252, 252, 248));
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    web.setVerticalScrollBarEnabled(false);
    web.setHorizontalScrollBarEnabled(false);
    web.setOnScrollChangeListener(
        (view, scrollX, scrollY, oldScrollX, oldScrollY) -> {
          if (scrollX != 0 || scrollY != 0) web.scrollTo(0, 0);
        });
    setContentView(web);
    hideSystemUi();
    web.post(this::hideSystemUi);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    WebViewAssetLoader loader =
        new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler(
                "/camera-test/",
                new WebViewAssetLoader.InternalStoragePathHandler(
                    this, engine.cameraTestDirectory()))
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

  private void hideSystemUi() {
    if (Build.VERSION.SDK_INT >= 30) {
      getWindow().setDecorFitsSystemWindows(false);
      android.view.WindowInsetsController controller =
          getWindow().getDecorView().getWindowInsetsController();
      if (controller != null) {
        controller.hide(
            android.view.WindowInsets.Type.statusBars()
                | android.view.WindowInsets.Type.navigationBars());
        controller.setSystemBarsBehavior(
            android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    }
    getWindow()
        .getDecorView()
        .setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemUi();
  }

  private final class Bridge {
    @JavascriptInterface
    public String state() {
      return engine.snapshot();
    }

    @JavascriptInterface
    public void action(String action, String value) {
      int maxLength = "start".equals(action) ? 1200 : 500;
      if (value == null || value.length() > maxLength) return;
      switch (action) {
        case "setup":
          runOnUiThread(() -> setup());
          break;
        case "setup-reenroll":
          runOnUiThread(() -> enrollment(true));
          break;
        case "enroll":
          try {
            JSONObject request = new JSONObject(value);
            String code = request.optString("code").trim();
            if (code.isEmpty() || code.length() > 120) return;
            engine.enroll(code, request.optBoolean("replace"));
          } catch (Exception ignored) {
            return;
          }
          break;
        case "refresh":
          engine.refreshConfiguration();
          break;
        case "choose-camera":
          runOnUiThread(() -> configureDeviceCamera());
          break;
        case "choose-device":
          runOnUiThread(() -> configureDeviceCamera());
          break;
        case "sync-camera":
          engine.syncCamera();
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
        case "confirm-camera-test":
          engine.confirmCameraTest(true, false);
          break;
        case "retry-camera-test":
          engine.confirmCameraTest(false, true);
          break;
        case "reset":
          engine.reset();
          break;
        case "discard":
          runOnUiThread(() -> showModal("discard"));
          break;
        case "discard-confirmed":
          engine.discard();
          break;
        case "leave-confirmed":
          runOnUiThread(() -> moveTaskToBack(true));
          break;
      }
    }
  }

  private JSONObject cameraConfiguration(Object... entries) {
    JSONObject result = new JSONObject();
    try {
      for (int index = 0; index < entries.length; index += 2)
        result.put(String.valueOf(entries[index]), entries[index + 1]);
      return result;
    } catch (Exception impossible) {
      throw new IllegalStateException("Could not prepare camera settings.", impossible);
    }
  }

  private void setup() {
    if (engine.busy) {
      Toast.makeText(this, "Finish the current operation first.", Toast.LENGTH_SHORT).show();
      return;
    }
    if (!engine.server.optBoolean("enabled")) {
      if (engine.hasStoredEnrollment()) {
        showModal("saved-enrollment");
      } else enrollment(false);
      return;
    }
    boolean deviceCamera = engine.usesDeviceCamera();
    if (!deviceCamera) {
      configureDeviceCamera();
      return;
    }
    if (deviceCamera && !DeviceCameraRecorder.hasPermissions(this)) {
      configureDeviceCameraAfterPermission = true;
      requestPermissions(
          new String[] {
            android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO
          },
          2);
      return;
    }
    showModal("camera-ready-device");
  }

  private void configureDeviceCamera() {
    if (!DeviceCameraRecorder.hasPermissions(this)) {
      configureDeviceCameraAfterPermission = true;
      requestPermissions(
          new String[] {
            android.Manifest.permission.CAMERA, android.Manifest.permission.RECORD_AUDIO
          },
          2);
      return;
    }
    engine.configureCamera(cameraConfiguration("recorder_mode", "android_camera"));
  }

  private void showModal(String kind) {
    try {
      showModal(new JSONObject().put("kind", kind));
    } catch (Exception impossible) {
      throw new IllegalStateException("Could not open setup.", impossible);
    }
  }

  private void showModal(JSONObject data) {
    if (web == null) return;
    String payload = JSONObject.quote(data.toString());
    web.evaluateJavascript("window.showNativeModal && window.showNativeModal(" + payload + ")", null);
  }

  @Override
  public void onRequestPermissionsResult(
      int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode != 2 || !configureDeviceCameraAfterPermission) return;
    configureDeviceCameraAfterPermission = false;
    if (DeviceCameraRecorder.hasPermissions(this)) configureDeviceCamera();
    else showModal("permission");
  }

  private void enrollment(boolean replace) {
    if (engine.busy) {
      Toast.makeText(this, "Finish the current operation first.", Toast.LENGTH_SHORT).show();
      return;
    }
    try {
      showModal(new JSONObject().put("kind", "enrollment").put("replace", replace));
    } catch (Exception impossible) {
      throw new IllegalStateException("Could not open enrollment.", impossible);
    }
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

  private void handleBackPressed() {
    if (web == null) {
      finish();
      return;
    }
    web.evaluateJavascript("window.handlePlayerBack ? window.handlePlayerBack() : false", result -> {
      if (!"true".equals(result)) leavePlayer();
    });
  }

  private void leavePlayer() {
    if (engine != null && engine.busy) showModal("leave");
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
