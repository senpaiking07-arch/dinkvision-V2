package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import java.util.ArrayList;
import org.json.JSONObject;

public final class MainActivity extends androidx.activity.ComponentActivity {
  private Engine engine;
  private WebView web;
  private boolean configureDeviceCameraAfterPermission;
  private String pendingExportSession = "";
  private volatile String pendingEnrollmentInvite = "";
  private boolean pendingEnrollmentReplace;
  private boolean replaceAfterScan;
  private boolean usbReceiverRegistered;
  private final BroadcastReceiver usbChanges = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      android.hardware.usb.UsbDevice device = intent.getParcelableExtra(android.hardware.usb.UsbManager.EXTRA_DEVICE);
      if (engine != null && UvcCameraRecorder.isUvcDevice(device)) engine.cameraConnectionChanged();
    }
  };
  private final androidx.activity.result.ActivityResultLauncher<Intent> saveVideoPicker =
      registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(), result -> {
        String session = pendingExportSession;
        pendingExportSession = "";
        if (engine == null) return;
        if (result.getResultCode() != RESULT_OK || result.getData() == null || result.getData().getData() == null) {
          engine.localVideoSession = session;
          engine.localVideoMessage = "Save cancelled. The original remains in the app.";
          return;
        }
        Uri destination = result.getData().getData();
        try {
          int flags = result.getData().getFlags() &
              (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
          getContentResolver().takePersistableUriPermission(destination, flags);
        } catch (SecurityException unsupported) { }
        engine.exportLocalVideo(session, destination);
      });
  private final androidx.activity.result.ActivityResultLauncher<ScanOptions> enrollmentScanner =
      registerForActivityResult(new ScanContract(), result -> {
        String scanned = result.getContents();
        String invite = EnrollmentLink.scanned(scanned);
        if (invite.isEmpty()) {
          String scanError = scanned == null ? "" : EnrollmentLink.forAnotherServer(scanned)
              ? "This QR is for a different server. Open Admin at " + Api.ORIGIN + " to create an invitation."
              : "Scan the enrollment QR from Devices & cameras in DinkVision Admin.";
          showModal(cameraConfiguration("kind", "enrollment", "replace", replaceAfterScan, "scanError", scanError));
        } else {
          pendingEnrollmentReplace = replaceAfterScan;
          pendingEnrollmentInvite = invite;
        }
      });

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    if (b != null) pendingExportSession = b.getString("pending-export-session", "");
    if (b != null) replaceAfterScan = b.getBoolean("replace-after-scan");
    try {
      engine = Engine.get(this);
      // Engine owns approval for this process. A new Engine starts unapproved;
      // recreating an Activity during background work must preserve that state.
      // USB reconnects and configuration changes explicitly invalidate it.
    } catch (Exception e) {
      new AlertDialog.Builder(this)
          .setMessage(e.getMessage())
          .setPositiveButton("Close", (d, w) -> finish())
          .show();
      return;
    }
    readEnrollmentIntent(getIntent());
    IntentFilter usbFilter = new IntentFilter(android.hardware.usb.UsbManager.ACTION_USB_DEVICE_ATTACHED);
    usbFilter.addAction(android.hardware.usb.UsbManager.ACTION_USB_DEVICE_DETACHED);
    androidx.core.content.ContextCompat.registerReceiver(this, usbChanges, usbFilter,
        androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
    usbReceiverRegistered = true;
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
    web.setBackgroundColor(Color.rgb(4, 29, 56));
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    web.setVerticalScrollBarEnabled(false);
    web.setHorizontalScrollBarEnabled(false);
    web.setOnScrollChangeListener(
        (view, scrollX, scrollY, oldScrollX, oldScrollY) -> {
          if (scrollX != 0 || scrollY != 0) web.scrollTo(0, 0);
        });
    attachRecipientInsets(web);
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
                && "https".equals(u.getScheme())) {
              if (u.getPath() != null && u.getPath().startsWith("/saved-video/")) {
                String range = null;
                for (var header : req.getRequestHeaders().entrySet())
                  if ("range".equalsIgnoreCase(header.getKey())) range = header.getValue();
                return LocalVideoResponse.open(engine, u.getPath().substring("/saved-video/".length()), range);
              }
              return loader.shouldInterceptRequest(u);
            }
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

  static void attachRecipientInsets(WebView web) {
    ViewCompat.setOnApplyWindowInsetsListener(web, (view, insets) -> {
      int keyboardBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
      web.evaluateJavascript("window.setRecipientKeyboardInset?.(" + keyboardBottom + ")", null);
      return ViewCompat.onApplyWindowInsets(view, insets);
    });
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    readEnrollmentIntent(intent);
  }

  private void readEnrollmentIntent(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
    String invite = EnrollmentLink.handoff(intent.getData());
    // Consume the intent even when the activity is recreated.
    intent.setData(null);
    if (invite.isEmpty() || engine == null) return;
    if (engine.busy) {
      Toast.makeText(this, "Finish the current operation, then scan the enrollment QR again.", Toast.LENGTH_LONG).show();
      return;
    }
    pendingEnrollmentReplace = engine.hasStoredEnrollment();
    pendingEnrollmentInvite = invite;
  }

  private void showEnrollmentPin(String invite, boolean replace) {
    showModal(cameraConfiguration("kind", "enrollment-pin", "invite", invite, "replace", replace));
  }

  private void openPendingEnrollmentInvite() {
    if (pendingEnrollmentInvite.isEmpty() || engine.busy || engine.updateBlocksPlayer()) return;
    String invite = pendingEnrollmentInvite;
    pendingEnrollmentInvite = "";
    if (EnrollmentLink.pairingCode(invite))
      showModal(cameraConfiguration("kind", "enrollment-pairing", "code", invite, "replace", pendingEnrollmentReplace));
    else
      showEnrollmentPin(invite, pendingEnrollmentReplace);
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
      if (!pendingEnrollmentInvite.isEmpty()) runOnUiThread(MainActivity.this::openPendingEnrollmentInvite);
      return engine.snapshot();
    }

    @JavascriptInterface
    public String emailHistory(String prefix) {
      if (prefix == null || prefix.length() > 254 || !canUseEmailHistory()) return "{}";
      try { return engine.emailHistory.find(prefix.trim()).toString(); }
      catch (Exception unavailable) { return "{}"; }
    }

    @JavascriptInterface
    public boolean removeSavedEmail(String email) {
      if (email == null || email.length() > 254 || !canUseEmailHistory()) return false;
      try {
        engine.emailHistory.remove(email);
        return true;
      } catch (Exception unavailable) { return false; }
    }

    private boolean canUseEmailHistory() {
      return !engine.busy && engine.server.optBoolean("enabled") && !engine.updateBlocksPlayer();
    }

    @JavascriptInterface
    public void action(String action, String value) {
      long receivedNanos = System.nanoTime();
      if ("retry-connection".equals(action)) { engine.retryConnection(); return; }
      if ("check-update".equals(action)) { engine.checkForUpdate(); return; }
      if ("install-update".equals(action)) {
        final String url = engine.vault.object("android-release").optString("downloadUrl");
        if (engine.updateRequired() && AppUpdate.safeDownloadUrl(url)) runOnUiThread(() -> {
          try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
          catch (ActivityNotFoundException noBrowser) { engine.releaseError = "No browser is available to download the APK. Ask your administrator to install it."; }
        });
        return;
      }
      // Background uploads and current capture finalization continue; player actions are gated.
      if (engine.updateBlocksPlayer() && !"stop".equals(action)) return;
      int maxLength = "start".equals(action) ? 1200 : 500;
      if (value == null || value.length() > maxLength) return;
      switch (action) {
        case "setup":
          runOnUiThread(() -> setup());
          break;
        case "setup-reenroll":
          runOnUiThread(() -> enrollment(true));
          break;
        case "tablet-pairing":
          engine.openTabletPairing("replace".equals(value) || "renew-replace".equals(value), value.startsWith("renew"));
          break;
        case "tablet-pairing-poll":
          engine.pollTabletPairing();
          break;
        case "scan-enrollment":
          runOnUiThread(() -> {
            if (engine.busy || engine.updateBlocksPlayer()) return;
            replaceAfterScan = "replace".equals(value);
            enrollmentScanner.launch(new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("Scan the DinkVision enrollment QR").setBeepEnabled(false).setOrientationLocked(false));
          });
          break;
        case "enroll-qr":
          try {
            JSONObject request = new JSONObject(value);
            engine.enrollQr(request.optString("invite"), request.optString("pin"), request.optBoolean("replace"));
          } catch (org.json.JSONException ignored) { }
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
          if (engine.selectRecordingMode(value.trim())) engine.syncCamera();
          break;
        case "start":
          engine.start(value.trim(), receivedNanos);
          break;
        case "repeat-start":
          engine.noteRepeatedStart();
          break;
        case "repeat-stop":
          engine.noteRepeatedStop(value);
          break;
        case "stop":
          engine.requestStop(value);
          break;
        case "recover":
          engine.recover();
          break;
        case "retry-upload":
          engine.retryUpload(value.trim());
          break;
        case "save-local-video":
          runOnUiThread(() -> saveLocalVideo(value.trim()));
          break;
        case "remove-local-video":
          engine.removeLocalVideo(value.trim());
          break;
        case "recover-failed":
          engine.retryLatestFailedUpload();
          break;
        case "confirm-camera-test":
          engine.confirmCameraTestRequest(value);
          break;
        case "select-recording-mode":
          engine.selectRecordingMode(value.trim());
          break;
        case "retry-camera-test":
          if (engine.selectRecordingMode(value.trim())) {
            if (engine.cameraTestReady) engine.confirmCameraTest(false, true);
            else engine.syncCamera();
          }
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

  private void saveLocalVideo(String session) {
    try {
      engine.localVideoSession = session;
      engine.localVideoError = "";
      String name = engine.localVideoName(session);
      if (Build.VERSION.SDK_INT >= 29) engine.exportLocalVideo(session, null);
      else if (pendingExportSession.isEmpty() && !engine.exportWorkerRunning.get()) {
        pendingExportSession = session;
        saveVideoPicker.launch(new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE).setType("video/mp4")
            .putExtra(Intent.EXTRA_TITLE, name));
      }
    } catch (Exception failure) {
      pendingExportSession = "";
      engine.localVideoError = "Could not open Save to device. Check that the original video is still available.";
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle saved) {
    saved.putString("pending-export-session", pendingExportSession);
    saved.putBoolean("replace-after-scan", replaceAfterScan);
    super.onSaveInstanceState(saved);
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
    if (engine != null) { engine.visible = true; engine.resumeBackgroundTransfers(); }
  }

  @Override
  public void onPause() {
    if (engine != null) engine.visible = false;
    super.onPause();
  }

  private void handleBackPressed() {
    if (engine.updateBlocksPlayer() && !engine.busy) return;
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
    if (usbReceiverRegistered) unregisterReceiver(usbChanges);
    if (web != null) {
      web.removeJavascriptInterface("CasaNative");
      web.destroy();
    }
    super.onDestroy();
  }
}
