package com.casabatik.recorder;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RecorderTest {
  @Test public void storagePreflightBudgetsOneLiveBrandedFile() {
    assertEquals(1_105_840_000L,Engine.requiredRecordingBytes(900));
    assertTrue(Engine.requiredRecordingBytes(900,32_000_000)>Engine.requiredRecordingBytes(900));
    assertTrue(Engine.requiredRecordingBytes(1500)>Engine.requiredRecordingBytes(1200));
    assertTrue(Engine.requiredRecordingBytes(7200)>Integer.MAX_VALUE);
    for(int invalid:new int[]{0,-1,7201})try{Engine.requiredRecordingBytes(invalid);fail();}catch(IllegalArgumentException expected){}
  }
  @Test
  public void sourceClockDoesNotStretchDelayedVideo() throws Exception {
    var clock = new RecordingAccuracy.Timeline();
    assertEquals(0, clock.observe(9_000_000, 1_000_000_000L));
    assertEquals(1_000_000, clock.observe(10_000_000, 3_000_000_000L));
    try { clock.observe(11_000_000, 7_000_000_000L); fail("Backlog must fail, not stretch video"); }
    catch (RecordingAccuracy.Failure expected) {}
    try { clock.observe(1, 7_000_000_000L); fail("Clock reset must fail"); }
    catch (RecordingAccuracy.Failure expected) {}
  }

  @Test public void sharedValidationRejectsStretchedVideoAndShortAudio() throws Exception {
    RecordingAccuracy.duration(120_050_000, 120_000_000, "Video");
    for (long actual : new long[] {74_900_000, 180_000_000}) {
      try { RecordingAccuracy.duration(actual, 121_550_000, "Video/audio"); fail(); }
      catch (RecordingAccuracy.Failure expected) {}
    }
  }

  @Test public void cameraPreviewRequiresTheFullThreeSeconds() throws Exception {
    VideoBranding.requirePreviewDuration(2_750, 3_000);
    VideoBranding.requirePreviewDuration(3_500, 3_000);
    for (long actual : new long[] {2_749, 3_501}) {
      try {
        VideoBranding.requirePreviewDuration(actual, 3_000);
        fail("Incomplete or overlong previews must be rejected.");
      } catch (RecordingAccuracy.Failure expected) {
      }
    }
  }

  @Test public void deviceCameraUsesSupportedFrameRate() throws Exception {
    android.util.Range<Integer>[] ranges = new android.util.Range[] {
      new android.util.Range<>(15, 15), new android.util.Range<>(15, 30), new android.util.Range<>(30, 30)
    };
    assertEquals(Integer.valueOf(15), DeviceCameraRecorder.recordingRate(ranges, 66_666_666).getUpper());
    assertEquals(Integer.valueOf(30), DeviceCameraRecorder.recordingRate(ranges, 33_333_333).getLower());
  }

  @Test
  public void playerScreenAndForegroundService() throws Exception {
    android.app.Instrumentation i = InstrumentationRegistry.getInstrumentation();
    if (android.os.Build.VERSION.SDK_INT >= 33)
      i.getUiAutomation()
          .grantRuntimePermission(
              i.getTargetContext().getPackageName(),
              android.Manifest.permission.POST_NOTIFICATIONS);
    MainActivity activity =
        (MainActivity)
            i.startActivitySync(
                new android.content.Intent(i.getTargetContext(), MainActivity.class)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
    int systemUi = activity.getWindow().getDecorView().getSystemUiVisibility();
    assertTrue((systemUi & android.view.View.SYSTEM_UI_FLAG_FULLSCREEN) != 0);
    assertTrue((systemUi & android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION) != 0);
    assertTrue((systemUi & android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY) != 0);
    Engine engine = Engine.get(activity);
    engine.busy = true;
    try {
      i.runOnMainSync(
          () ->
              activity.startForegroundService(
                  new android.content.Intent(activity, RecorderService.class)));
      Thread.sleep(2000);
      assertTrue(RecorderService.holdsCpuWakeLock());
      java.util.concurrent.CountDownLatch loaded = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> result =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "document.getElementById('begin').textContent.trim()==='TAP ANYWHERE TO START' &&"
                    + " document.getElementById('begin').getAttribute('aria-label')==='Tap anywhere to start' &&"
                    + " document.querySelector('#begin svg')!==null &&"
                    + " document.querySelector('.backdrop') !== null &&"
                    + " document.querySelectorAll('.brand img').length===1 &&"
                    + " document.querySelectorAll('.watermark').length===0 &&"
                    + " document.getElementById('setup')===null &&"
                    + " document.getElementById('reenroll')!==null &&"
                    + " getComputedStyle(document.querySelector('.backdrop')).backgroundImage.includes(innerWidth<=700&&innerHeight>innerWidth?'Kiosk-Background-Phone.png':'Kiosk-Background-Tablet.png') &&"
                    + " document.getElementById('queue-indicator') === null &&"
                    + " document.getElementById('camera-test-video') !== null &&"
                    + " document.getElementById('camera-test-confirm').textContent.includes('see and hear') &&"
                    + " document.getElementById('camera-test-retry').textContent.includes('another test')",
                v -> {
                  result.set(v);
                  loaded.countDown();
                });
          });
      assertTrue(loaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", result.get());

      java.util.concurrent.CountDownLatch backLoaded = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> backResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "show('form');"
                    + "const input=document.querySelector('.email-add-row').getBoundingClientRect();"
                    + "const submit=document.querySelector('#email-form .record').getBoundingClientRect();"
                    + "const centered=Math.abs((input.left+input.right)/2-innerWidth/2)<2 &&"
                    + " Math.abs((submit.left+submit.right)/2-innerWidth/2)<2;"
                    + "centered && !document.getElementById('form').hidden",
                value -> {
                  backResult.set(value);
                  backLoaded.countDown();
                });
          });
      assertTrue(backLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", backResult.get());

      java.util.concurrent.CountDownLatch recipientsLoaded =
          new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> recipientsResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "(()=>{"
                    + "const original=state;state={...state,enabled:true,tested:true,cameraMode:'device',busy:false};"
                    + "const input=document.getElementById('player-email');"
                    + "const manual=input.autocomplete==='off'&&input.autocapitalize==='none'&&input.spellcheck===false;"
                    + "input.value='First.Player@GMAIL.COM';const first=addEmail();"
                    + "const normalized=emails.length===1&&emails[0]==='first.player@gmail.com';"
                    + "document.getElementById('email-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));"
                    + "const saved=[...document.querySelectorAll('#confirmation-recipients span')].map(e=>e.textContent).join(',')==='first.player@gmail.com';"
                    + "show('form');emails=[];renderEmails();input.value='first.player@gmail.com';const reused=addEmail();"
                    + "input.value='wrong.address@gmail.com';const wrong=addEmail();"
                    + "document.querySelector('[aria-label=\"Remove wrong.address@gmail.com\"]').click();"
                    + "input.value='correct.address@gmail.com';const corrected=addEmail();"
                    + "const finalState=emails.join(',')==='first.player@gmail.com,correct.address@gmail.com';"
                    + "emails=[];renderEmails();state=original;return manual&&first&&normalized&&saved&&reused&&wrong&&corrected&&finalState;"
                    + "})()",
                value -> {
                  recipientsResult.set(value);
                  recipientsLoaded.countDown();
                });
          });
      assertTrue(recipientsLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", recipientsResult.get());

      java.util.concurrent.CountDownLatch durationLoaded =
          new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> durationResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "formatRecordingTime(900,0)==='00:00'&&"
                    + "formatRecordingTime(1200,1200000)==='20:00'&&"
                    + "formatRecordingTime(1500,1500000)==='25:00'",
                value -> {
                  durationResult.set(value);
                  durationLoaded.countDown();
                });
          });
      assertTrue(durationLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", durationResult.get());
      android.graphics.Bitmap formImage = i.getUiAutomation().takeScreenshot();
      if (formImage != null)
        try (java.io.FileOutputStream out =
            new java.io.FileOutputStream(new File(activity.getCacheDir(), "player-form.png"))) {
          formImage.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        }
      java.util.concurrent.CountDownLatch backNavigationLoaded =
          new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> backNavigationResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "document.getElementById('back').click();"
                    + "!document.getElementById('welcome').hidden &&"
                    + " document.getElementById('form').hidden",
                value -> {
                  backNavigationResult.set(value);
                  backNavigationLoaded.countDown();
                });
          });
      assertTrue(backNavigationLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", backNavigationResult.get());

      java.util.concurrent.CountDownLatch modalLoaded = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> modalResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "window.showNativeModal({kind:'enrollment',replace:false});"
                    + " const m=document.getElementById('modal'),r=m.getBoundingClientRect();"
                    + " !m.hidden && document.getElementById('modal-title').textContent.includes('Register') &&"
                    + " m.querySelectorAll('img').length===0 &&"
                    + " r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1 &&"
                    + " document.documentElement.scrollWidth<=innerWidth+1 &&"
                    + " document.documentElement.scrollHeight<=innerHeight+1",
                value -> {
                  modalResult.set(value);
                  modalLoaded.countDown();
                });
          });
      assertTrue(modalLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", modalResult.get());

      java.util.concurrent.CountDownLatch modalStatesLoaded = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> modalStatesResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "window.showNativeModal({kind:'camera-ready-device'});"
                    + " document.getElementById('modal-title').textContent.includes('USB') &&"
                    + " document.querySelectorAll('.modal-card img').length===0 &&"
                    + " document.documentElement.scrollHeight<=innerHeight+1 &&"
                    + " ['saved-enrollment','camera-ready-device','permission','discard','leave'].every(kind=>{"
                    + "window.showNativeModal({kind});const m=document.getElementById('modal'),r=m.getBoundingClientRect();"
                    + "return !m.hidden&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&"
                    + "m.querySelectorAll('img').length===0&&document.documentElement.scrollWidth<=innerWidth+1&&"
                    + "document.documentElement.scrollHeight<=innerHeight+1;}) &&"
                    + "window.setNativeKeyboardVisible===undefined &&"
                    + "document.documentElement.scrollTop===0",
                value -> {
                  modalStatesResult.set(value);
                  modalStatesLoaded.countDown();
                });
          });
      assertTrue(modalStatesLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", modalStatesResult.get());
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript("window.dismissNativeModal()", null);
          });

      java.util.concurrent.CountDownLatch timerUiLoaded =
          new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> timerUiResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "document.getElementById('queue-indicator')===null &&"
                    + " typeof renderUploadStatus==='undefined' &&"
                    + " [0,1000,2000,3000].map(value=>formatRecordingTime(5,value)).join(',')==='00:00,00:01,00:02,00:03' &&"
                    + " getComputedStyle(document.getElementById('timer')).fontVariantNumeric.includes('tabular-nums')",
                value -> {
                  timerUiResult.set(value);
                  timerUiLoaded.countDown();
                });
          });
      assertTrue(timerUiLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", timerUiResult.get());

      engine.cameraTestReady = true;
      engine.cameraTestHasAudio = true;
      engine.cameraTestRevision = "test-revision";
      engine.cameraTestCamera = "{\"type\":\"device\"}";
      engine.cameraTestToken = "test-token";
      Thread.sleep(1000);
      java.util.concurrent.CountDownLatch reviewLoaded = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> reviewResult =
          new java.util.concurrent.atomic.AtomicReference<>();
      i.runOnMainSync(
          () -> {
            android.webkit.WebView w =
                (android.webkit.WebView)
                    ((android.view.ViewGroup) activity.findViewById(android.R.id.content))
                        .getChildAt(0);
            w.evaluateJavascript(
                "!document.getElementById('camera-test').hidden &&"
                    + " document.getElementById('camera-test-video').src.includes('/camera-test/clip.mp4') &&"
                    + " document.getElementById('camera-test-confirm').textContent.includes('see and hear')",
                v -> {
                  reviewResult.set(v);
                  reviewLoaded.countDown();
                });
          });
      assertTrue(reviewLoaded.await(5, java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("true", reviewResult.get());
      android.graphics.Bitmap image = i.getUiAutomation().takeScreenshot();
      if (image != null)
        try (java.io.FileOutputStream out =
            new java.io.FileOutputStream(new File(activity.getCacheDir(), "player-test.png"))) {
          image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        }

      long notificationDeadline = System.nanoTime() + 12_000_000_000L;
      while (i.getTargetContext().getSystemService(android.app.NotificationManager.class)
          .getActiveNotifications().length == 0 && System.nanoTime() < notificationDeadline)
        Thread.sleep(100);
      assertEquals(
          1,
          i.getTargetContext()
              .getSystemService(android.app.NotificationManager.class)
              .getActiveNotifications()
              .length);
      RecorderService.updateUploadProgress(42);
      Thread.sleep(250);
      android.service.notification.StatusBarNotification active =
          i.getTargetContext()
              .getSystemService(android.app.NotificationManager.class)
              .getActiveNotifications()[0];
      assertTrue(
          String.valueOf(active.getNotification().extras.getCharSequence("android.text"))
              .contains("42%"));
      i.runOnMainSync(
          () -> activity.stopService(new android.content.Intent(activity, RecorderService.class)));
    } finally {
      engine.cameraTestReady = false;
      engine.cameraTestHasAudio = false;
      engine.cameraTestRevision = "";
      engine.cameraTestCamera = "";
      engine.cameraTestToken = "";
      engine.busy = false;
      i.runOnMainSync(
          () -> activity.stopService(new android.content.Intent(activity, RecorderService.class)));
      i.runOnMainSync(activity::finish);
    }
  }

  @Test
  public void managedCameraRequiresMatchingRevision() throws Exception {
    android.content.Context c = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Engine engine = Engine.get(c);
    engine.heartbeat.shutdownNow();
    engine.vault.put("camera", "{}");
    engine.vault.put("camera-revision", "revision-1");
    org.json.JSONObject d =
        new org.json.JSONObject()
            .put("recorder_mode", "android_rtsp")
            .put("video_device", "android-camera-v1")
            .put("tested_at", "2026-10-06")
            .put("config_revision", "revision-1")
            .put("tested_revision", "revision-1");
    engine.requireCameraCheck();
    assertFalse("A saved server test must not bypass the launch camera check", engine.cameraReady(d));
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    instrumentation.getUiAutomation().grantRuntimePermission(c.getPackageName(), android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(c.getPackageName(), android.Manifest.permission.RECORD_AUDIO);
    engine.cameraCheckedThisLaunch = true;
    engine.confirmedCameraConnection = UvcCameraRecorder.connectionKey(c);
    assertTrue(engine.cameraReady(d));
    engine.requireCameraCheck();
    assertFalse("A reconnect must invalidate the test", engine.cameraReady(d));
    engine.cameraCheckedThisLaunch = true;
    engine.confirmedCameraConnection = "another USB connection";
    assertFalse(engine.cameraReady(d));
    engine.confirmedCameraConnection = UvcCameraRecorder.connectionKey(c);
    d.put("config_revision", "revision-2");
    assertFalse(engine.cameraReady(d));
    d.put("config_revision", "revision-1").put("tested_revision", org.json.JSONObject.NULL);
    assertFalse(engine.cameraReady(d));
    engine.vault.put("camera", "");
    engine.vault.put("camera-revision", "");
    engine.requireCameraCheck();
  }

  @Test
  public void deviceCameraSourceIsSelectedFromManagedConfiguration() throws Exception {
    Engine engine = Engine.get(InstrumentationRegistry.getInstrumentation().getTargetContext());
    JSONObject original = engine.server;
    try {
      engine.server =
          new JSONObject()
              .put("device", new JSONObject().put("video_device", "android-camera-v1"));
      assertTrue(engine.usesDeviceCamera());
      engine.server =
          new JSONObject()
              .put("device", new JSONObject().put("video_device", "unsupported-source"));
      assertFalse(engine.usesDeviceCamera());
      engine.server =
          new JSONObject()
              .put("device", new JSONObject().put("video_device", "unexpected-source"));
      assertFalse(engine.usesDeviceCamera());
    } finally {
      engine.server = original;
    }
  }

  @Test
  public void audioExpectationMatchesCameraMode() throws Exception {
    Engine engine = Engine.get(InstrumentationRegistry.getInstrumentation().getTargetContext());
    assertTrue(engine.expectsAudio(new JSONObject().put("type", "device")));
    assertFalse(
        engine.expectsAudio(new JSONObject().put("type", "unsupported")));
  }

  @Test
  public void corruptRecordingIsRejected() throws Exception {
    File f =
        new File(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),
            "missing.mp4");
    try {
      RecordedVideo.validate(f);
      fail();
    } catch (Exception expected) {
    }
  }

  @Test
  public void vaultPersistsEncryptedData() throws Exception {
    android.content.Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String preferenceName = "vault-test-" + java.util.UUID.randomUUID();
    android.content.Context c =
        new android.content.ContextWrapper(base) {
          public android.content.Context getApplicationContext() {
            return this;
          }

          public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
            return base.getSharedPreferences(preferenceName, mode);
          }
        };
    Vault v = new Vault(c);
    try {
      v.put("test-secret", "fixture-password");
      assertEquals("fixture-password", new Vault(c).get("test-secret"));
      assertFalse(
          c.getSharedPreferences("vault", 0).getAll().toString().contains("fixture-password"));
    } finally {
      base.getSharedPreferences(preferenceName, 0).edit().clear().commit();
    }
  }
}
