package com.casabatik.recorder;

import static org.junit.Assert.*;

import android.content.Intent;
import android.webkit.*;
import android.widget.FrameLayout;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.WebViewAssetLoader;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SavedVideosUiTest {
  public static final class FakeBridge {
    volatile String snapshot;
    volatile boolean acknowledgeStarts=true;
    final List<String> actions = Collections.synchronizedList(new ArrayList<>());
    @JavascriptInterface public String state() { return snapshot; }
    @JavascriptInterface public void action(String action, String value) {
      actions.add(action + ":" + value);
      if(action.equals("start")&&acknowledgeStarts)try{
        snapshot=new JSONObject(snapshot).put("phase","connecting").put("busy",true).toString();
      }catch(JSONException malformed){throw new IllegalStateException(malformed);}
    }
  }

  private String evaluate(WebView web, String script) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<String> result = new AtomicReference<>();
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script,
        value -> { result.set(value); done.countDown(); }));
    assertTrue(done.await(5, TimeUnit.SECONDS));
    return result.get();
  }

  private void capture(MainActivity activity, String label) throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    android.graphics.Bitmap bitmap = instrumentation.getUiAutomation().takeScreenshot();
    if (bitmap == null || android.os.Build.VERSION.SDK_INT < 29) return;
    String name = "kiosk-" + label + "-" + UUID.randomUUID() + ".png";
    android.content.ContentValues values = new android.content.ContentValues();
    values.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name);
    values.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png");
    values.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/DinkVisionTests");
    var uri = activity.getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
    try (OutputStream output = activity.getContentResolver().openOutputStream(uri)) {
      bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
    }
    System.out.println("Theme screenshot: Pictures/DinkVisionTests/" + name);
    bitmap.recycle();
  }

  @Test public void savedVideoControlsFitAndSendTheSelectedVideoToNative() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    if (android.os.Build.VERSION.SDK_INT >= 33)
      instrumentation.getUiAutomation().grantRuntimePermission(
          instrumentation.getTargetContext().getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
    MainActivity activity = (MainActivity) instrumentation.startActivitySync(
        new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    Engine engine = Engine.get(activity);
    boolean oldBusy = engine.busy; engine.busy = true;
    AtomicReference<WebView> testingView = new AtomicReference<>();
    instrumentation.runOnMainSync(() -> {
      WebView original = (WebView)((android.view.ViewGroup)activity.findViewById(android.R.id.content)).getChildAt(0);
      original.stopLoading();
      WebView replacement = new WebView(activity);
      replacement.getSettings().setJavaScriptEnabled(true);
      replacement.getSettings().setAllowFileAccess(false);
      activity.setContentView(replacement);
      testingView.set(replacement);
    });
    WebView web = testingView.get();
    FakeBridge bridge = new FakeBridge();
    String first = UUID.randomUUID().toString(), second = UUID.randomUUID().toString();
    JSONObject snapshot = new JSONObject().put("enabled", true).put("enrolled", true).put("initialized", true)
        .put("tested", true).put("cameraMode", "device").put("court", "Court 1").put("phase", "idle").put("version", "0.5.32")
        .put("localVideoSession", first).put("localVideoMessage", "Copy saved to Movies/DinkVision. Find it in Gallery or Files.")
        .put("savedVideos", new JSONArray()
          .put(new JSONObject().put("id", first).put("status", "failed").put("retryCount", 8).put("exportReportPending", true)
              .put("bytes", 5000000).put("createdAt", 2000).put("durationMs", 300000).put("lastError", "Connection was lost."))
          .put(new JSONObject().put("id", second).put("status", "failed").put("retryCount", 1)
              .put("bytes", 5000000).put("createdAt", 1000).put("validationFailed", true)
              .put("brandingState", "failed").put("lastError", "Saved audio and video do not end together. The original remains on this tablet.")));
    bridge.snapshot = snapshot.toString();
    CountDownLatch loaded = new CountDownLatch(1);
    try {
      instrumentation.runOnMainSync(() -> {
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(activity)).build();
        web.removeJavascriptInterface("CasaNative");
        web.addJavascriptInterface(bridge, "CasaNative");
        web.setWebViewClient(new WebViewClient() {
          public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (request.getUrl().getPath().startsWith("/saved-video/") || request.getUrl().getPath().startsWith("/camera-test/")) {
              try { return new WebResourceResponse("video/mp4", null,
                  instrumentation.getContext().getAssets().open("recording-one-second.mp4")); }
              catch (Exception unavailable) { return null; }
            }
            return loader.shouldInterceptRequest(request.getUrl());
          }
          public void onPageFinished(WebView view, String url) { loaded.countDown(); }
        });
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
      });
      assertTrue(loaded.await(8, TimeUnit.SECONDS));
      String ready = "false";
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
      while (!"true".equals(ready) && System.nanoTime() < deadline) {
        ready = evaluate(web, "typeof show==='function'&&typeof renderSavedVideos==='function'&&typeof window.dismissNativeModal==='function'&&document.fonts.status==='loaded'&&document.fonts.check('italic 700 16px BarlowSport')");
        if (!"true".equals(ready)) Thread.sleep(100);
      }
      assertEquals("Player JavaScript did not load: " + evaluate(web, "document.readyState"), "true", ready);
      float density = activity.getResources().getDisplayMetrics().density;
      for (int[] size : new int[][]{{320,480},{360,640},{384,832},{568,320},{600,960},{768,1024},{800,1280},{1024,600},{1024,768},{1280,800},{1600,2560},{2560,1600}}) {
        CountDownLatch laidOut = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> {
          web.setLayoutParams(new FrameLayout.LayoutParams(Math.round(size[0]*density), Math.round(size[1]*density)));
          web.postDelayed(laidOut::countDown, 250);
        });
        assertTrue(laidOut.await(3, TimeUnit.SECONDS));
        String result = evaluate(web,
            "window.dismissNativeModal();show('welcome');tick();document.getElementById('saved-open').click();renderSavedVideos();"
            + "(()=>{const ids=['saved-save','saved-retry','saved-previous','saved-next','saved-back','saved-details'];const panel=document.getElementById('saved-panel').getBoundingClientRect();"
            + "const bad=ids.filter(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width<44||r.height<44||r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1||(id!=='saved-back'&&(r.bottom>panel.bottom-4||r.top<panel.top));}).map(id=>({id,...document.getElementById(id).getBoundingClientRect().toJSON()}));"
            + "return JSON.stringify({bad,w:innerWidth,h:innerHeight,panelRect:panel.toJSON(),info:document.querySelector('.saved-info').getBoundingClientRect().toJSON(),header:document.querySelector('header').getBoundingClientRect().toJSON(),main:document.querySelector('main').getBoundingClientRect().toJSON(),heading:document.querySelector('.saved-heading').getBoundingClientRect().toJSON(),rows:getComputedStyle(document.querySelector('.saved-info')).gridTemplateRows,body:document.body.className,scroll:document.documentElement.scrollHeight>innerHeight+1||document.documentElement.scrollWidth>innerWidth+1,panel:panel.bottom>innerHeight+1});})()");
        JSONObject bounds = new JSONObject(new JSONTokener(result).nextValue().toString());
        assertEquals(bounds.toString(), size[0], bounds.getDouble("w"), 2);
        assertEquals(bounds.toString(), size[1], bounds.getDouble("h"), 2);
        assertEquals(Arrays.toString(size)+" "+bounds, 0, bounds.getJSONArray("bad").length());
        assertFalse(bounds.toString(), bounds.getBoolean("scroll"));
        assertFalse(bounds.toString(), bounds.getBoolean("panel"));
        String notifications=evaluate(web,
            "show('welcome');(()=>{const e=document.getElementById('error'),n=document.getElementById('notice'),r=document.getElementById('recover');const old={e:e.hidden,n:n.hidden,r:r.hidden,text:n.textContent};"
            +"try{e.hidden=true;n.hidden=true;const ids=['welcome','begin'],before=ids.map(id=>document.getElementById(id).getBoundingClientRect().toJSON());"
            +"const heading=document.querySelector('.hero h1').getBoundingClientRect().toJSON();e.hidden=false;r.hidden=false;n.hidden=false;n.textContent='Video and audio confirmed. This tablet is ready for player mode.';"
            +"const moved=ids.filter((id,i)=>{const b=document.getElementById(id).getBoundingClientRect();return Math.abs(b.top-before[i].top)>.5||Math.abs(b.height-before[i].height)>.5;});"
            +"const after=document.querySelector('.hero h1').getBoundingClientRect();if(Math.abs(after.top-heading.top)>.5||Math.abs(after.height-heading.height)>.5)moved.push('headline');"
            +"const top=document.querySelector('.hero .eyebrow').getBoundingClientRect().top,header=document.querySelector('header').getBoundingClientRect().bottom;"
            +"if(top<header-1)moved.push({issue:'heading behind header',top,header,main:document.querySelector('main').getBoundingClientRect().toJSON(),hero:document.querySelector('.hero').getBoundingClientRect().toJSON(),welcome:document.getElementById('welcome').getBoundingClientRect().toJSON(),font:getComputedStyle(document.querySelector('.hero h1')).fontSize,body:getComputedStyle(document.body).gridTemplateRows});for(const id of ['error','notice']){const b=document.getElementById(id).getBoundingClientRect();if(b.top<0||b.bottom>innerHeight||b.left<0||b.right>innerWidth)moved.push(id+' outside viewport');}"
            +"return JSON.stringify(moved);}finally{e.hidden=old.e;n.hidden=old.n;r.hidden=old.r;n.textContent=old.text;}})()");
        assertEquals(Arrays.toString(size)+" notifications must float without moving or clipping the welcome screen "+notifications,"[]",new JSONTokener(notifications).nextValue().toString());
        assertEquals(Arrays.toString(size), "true", evaluate(web,
            "document.getElementById('saved-details').click();"
            + "(()=>{const r=document.querySelector('.modal-card').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&getComputedStyle(document.getElementById('modal-copy')).display!=='none';})()"));
        evaluate(web, "window.dismissNativeModal();true");
        snapshot.put("updateRequired",true).put("update",new JSONObject().put("versionName","0.5.36").put("downloadUrl","https://example.com/recorder.apk"));
        bridge.snapshot=snapshot.toString();
        assertEquals(Arrays.toString(size)+" update prompt must cover and disable every player screen", "true", evaluate(web,
            "tick();(()=>{const card=document.querySelector('#required-update .modal-card'),r=card.getBoundingClientRect(),button=document.getElementById('update-install').getBoundingClientRect();return !document.getElementById('required-update').hidden&&document.querySelector('main').inert&&document.querySelector('.device-tools').inert&&r.top>=0&&r.bottom<=innerHeight+1&&card.scrollHeight<=card.clientHeight+1&&button.height>=44&&document.documentElement.scrollHeight<=innerHeight+1;})()"));
        snapshot.remove("updateRequired");snapshot.remove("update");bridge.snapshot=snapshot.toString();
        evaluate(web,"tick();true");
        String journeys = evaluate(web,
            "(()=>{const bad=[];const check=(screen,ids)=>{show(screen);for(const id of ids){const e=document.getElementById(id),r=e.getBoundingClientRect();"
            + "if(r.width<44||r.height<44||r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1)bad.push({screen,id,r:r.toJSON()});}};"
            + "check('welcome',['begin']);const bg=getComputedStyle(document.querySelector('.backdrop')).backgroundImage;"
            + "const expected=innerWidth<=700&&innerHeight>innerWidth?'Kiosk-Background-Phone.png':'Kiosk-Background-Tablet.png';if(!bg.includes(expected))bad.push({background:bg,expected});"
            + "emails=['one.player@gmail.com','two.player@gmail.com','three.player@gmail.com','four.player@gmail.com'];renderEmails();"
            + "check('form',['back','player-email','add-email']);const submit=document.querySelector('#email-form .record').getBoundingClientRect();"
            + "const form=document.getElementById('form').getBoundingClientRect();if(submit.bottom>form.bottom+1)bad.push({screen:'form',submit:submit.toJSON(),form:form.toJSON()});"
            + "document.getElementById('email-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));check('confirm',['edit','record']);"
            + "document.getElementById('stop').hidden=false;check('session',['stop']);check('camera-test',['camera-test-confirm','camera-test-retry']);"
            + "show('saved-videos');renderSavedVideos();return JSON.stringify(bad);})()");
        assertEquals(Arrays.toString(size) + " " + journeys, "[]", new JSONTokener(journeys).nextValue().toString());
        snapshot.put("testReady",true).put("testToken","layout-check").put("testHasAudio",true)
            .put("testAudioInput","Camera microphone: USB-Audio - EMEET SmartCam C60E 4K")
            .put("recordingProfile","1920 × 1080 · 60 fps target · test 59.9 fps")
            .put("recordingModes",new JSONArray().put(new JSONObject().put("key","1920x1080@60").put("width",1920).put("height",1080).put("fps",60).put("supported",false))
                .put(new JSONObject().put("key","1280x720@60").put("width",1280).put("height",720).put("fps",60).put("supported",true)));
        bridge.snapshot=snapshot.toString();
        assertEquals(Arrays.toString(size)+" camera details must leave the tablet/phone controls reachable","true",evaluate(web,
            "tick();(()=>{const ids=['camera-test-confirm','camera-test-retry'];return ids.every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.height>=44&&r.top>=0&&r.bottom<=innerHeight+1;})&&document.documentElement.scrollHeight<=innerHeight+1;})()"));
        assertEquals("Quality changes require another test; unsupported options stay disabled","true",evaluate(web,
            "(()=>{const q=document.getElementById('camera-quality');q.value='1280x720@60';q.dispatchEvent(new Event('change'));return document.getElementById('camera-test-confirm').disabled&&[...q.options].find(o=>o.value==='1920x1080@60').disabled;})()"));
        evaluate(web,"document.getElementById('camera-test-retry').click();document.getElementById('camera-quality').value='auto';true");
        assertTrue(bridge.actions.contains("retry-camera-test:1280x720@60"));
        snapshot.remove("testReady");snapshot.remove("recordingProfile");bridge.snapshot=snapshot.toString();evaluate(web,"tick();true");
        String modals = evaluate(web,
            "JSON.stringify(['enrollment','saved-enrollment','session-recovery','camera-ready-device','permission','discard','leave','remove-saved-video'].filter(kind=>{showNativeModal({kind,id:'"+first+"'});const e=document.querySelector('.modal-card'),r=e.getBoundingClientRect();"
            + "return r.top<0||r.bottom>innerHeight+1||e.scrollHeight>e.clientHeight+1||[...document.querySelectorAll('#modal .modal-actions button')].some(b=>b.getBoundingClientRect().height<44);}));");
        assertEquals(Arrays.toString(size) + " " + modals, "[]", new JSONTokener(modals).nextValue().toString());
        evaluate(web, "window.dismissNativeModal();true");
        JSONObject processingItem=snapshot.getJSONArray("savedVideos").getJSONObject(0);
        processingItem.put("status","saved_locally").put("brandingState","processing").put("brandingProgress",42);
        bridge.snapshot=snapshot.toString();
        assertEquals(Arrays.toString(size)+" processing progress must fit its media panel "+evaluate(web,"JSON.stringify({bar:document.getElementById('saved-processing-progress').getBoundingClientRect().toJSON(),media:document.querySelector('.saved-media').getBoundingClientRect().toJSON()})"), "true", evaluate(web,
            "tick();show('saved-videos');savedSelection='"+first+"';renderSavedVideos();"
            +"(()=>{const p=document.getElementById('saved-processing-progress'),r=p.getBoundingClientRect(),m=document.querySelector('.saved-media').getBoundingClientRect();return p.value===42&&r.height>=4&&r.top>=m.top-1&&r.bottom<=m.bottom+1&&r.left>=m.left-1&&r.right<=m.right+1;})()"));
        processingItem.put("status","failed");processingItem.remove("brandingState");processingItem.remove("brandingProgress");bridge.snapshot=snapshot.toString();
      }
      CountDownLatch restored = new CountDownLatch(1);
      instrumentation.runOnMainSync(() -> {
        web.setLayoutParams(new FrameLayout.LayoutParams(-1,-1));
        web.postDelayed(restored::countDown, 300);
      });
      assertTrue(restored.await(3, TimeUnit.SECONDS));
      evaluate(web,"tick();show('welcome');document.getElementById('begin').click();emails=[];renderEmails();document.getElementById('player-email').value='manual.player@gmail.com';addEmail();document.getElementById('email-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));true");
      long startsBefore=bridge.actions.stream().filter(action->action.startsWith("start:")).count();
      assertEquals("A pending start must preserve the reviewed group", "true", evaluate(web,
          "document.getElementById('record').click();document.getElementById('record').click();emails.length===1&&emails[0]==='manual.player@gmail.com'&&document.getElementById('record').disabled"));
      assertEquals("Repeated taps must not submit another start",startsBefore+1,bridge.actions.stream().filter(action->action.startsWith("start:")).count());
      snapshot.put("phase","connecting").put("busy",true);bridge.snapshot=snapshot.toString();
      assertEquals("Addresses remain available while connecting", "true",evaluate(web,"tick();view==='session'&&emails.length===1"));
      snapshot.put("phase","error").put("busy",false).put("recoverable",true).put("startHasRecoverableFootage",false).put("error","Controlled start failure")
          .put("session",new JSONObject().put("id",UUID.randomUUID().toString()).put("status","requested"));bridge.snapshot=snapshot.toString();
      assertEquals("An older failed clip must not block a failed start retry for the next group", "true",evaluate(web,"tick();view==='confirm'&&emails.length===1&&!document.getElementById('record').disabled"));
      evaluate(web,"document.getElementById('record').click();true");
      snapshot.put("phase","recording").put("busy",true).put("elapsedMs",1000);bridge.snapshot=snapshot.toString();
      assertEquals("Recipients clear only once capture has actually started", "true",evaluate(web,"tick();view==='session'&&emails.length===0"));
      snapshot.put("phase","error").put("busy",false).put("recoverable",true).put("startHasRecoverableFootage",true).put("recoveryKind","partial")
          .put("message","Video and audio confirmed. This tablet is ready for player mode.")
          .put("session",new JSONObject().put("id",first).put("status","recording"));bridge.snapshot=snapshot.toString();
      assertEquals("A stale server state must not trap local capture recovery", "true",evaluate(web,"tick();view==='welcome'&&!document.getElementById('recover').hidden"));
      assertEquals("Local footage errors direct players to Saved videos without exposing a raw failure","true",evaluate(web,
          "document.getElementById('error-message').textContent.includes('Your recording is in Saved videos')&&!document.getElementById('error-message').textContent.includes('Controlled start failure')"));
      assertEquals("Only one notification is shown at a time with a 30-second lifetime","true",evaluate(web,
          "errorNoticeExpiresAt-performance.now()>29000&&errorNoticeExpiresAt-performance.now()<=30000&&document.getElementById('notice').hidden"));
      Thread.sleep(30_500);
      assertEquals("Polling must not revive expired error or success notices","true",evaluate(web,
          "tick();tick();document.getElementById('error').hidden&&document.getElementById('notice').hidden"));
      snapshot.put("startHasRecoverableFootage",false).put("error","Camera connection changed. Record another test.");bridge.snapshot=snapshot.toString();
      assertEquals("A different new error remains visible after the previous notice expired","true",evaluate(web,
          "tick();!document.getElementById('error').hidden&&document.getElementById('error-message').textContent.includes('Camera connection changed')"));
      assertEquals("Starting again must direct staff to the unfinished clip", "true",evaluate(web,
          "document.getElementById('begin').click();!document.getElementById('modal').hidden&&document.getElementById('modal-title').textContent.includes('Previous recording')"));
      snapshot.put("previousCaptureReleased",true);bridge.snapshot=snapshot.toString();
      assertEquals("An acknowledged finished capture must not block the next group's form because of cached server status","true",evaluate(web,
          "window.dismissNativeModal();clearRecipientDraft();show('welcome');tick();document.getElementById('begin').click();view==='form'&&document.getElementById('modal').hidden"));
      snapshot.remove("previousCaptureReleased");
      snapshot.remove("session");snapshot.put("phase","idle").put("error","").put("message","").put("recoverable",false);bridge.snapshot=snapshot.toString();
      bridge.acknowledgeStarts=false;
      assertEquals("An unaccepted native start must remain retryable", "true", evaluate(web,
          "window.dismissNativeModal();tick();show('form');emails=['manual.player@gmail.com'];document.getElementById('player-email').value='';renderEmails();document.getElementById('email-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));document.getElementById('record').click();emails.length===1&&!document.getElementById('record').disabled"));
      bridge.acknowledgeStarts=true;
      assertEquals("Cancelling the form clears its private draft and validation", "true",evaluate(web,
          "window.dismissNativeModal();tick();show('form');emails=['manual.player@gmail.com'];document.getElementById('player-email').value='invalid';addEmail();document.getElementById('back').click();tick();view==='welcome'&&emails.length===0&&document.getElementById('player-email').value===''&&document.getElementById('error').hidden"));
      snapshot.put("enabled",false).put("error","Connection timed out.");bridge.snapshot=snapshot.toString();
      assertEquals("An offline registered device keeps a recovery dialog instead of requesting another code","true",evaluate(web,
          "tick();showNativeModal({kind:'saved-enrollment'});!document.getElementById('modal').hidden&&document.getElementById('modal-copy').textContent.includes('a new enrollment code is not needed')"));
      snapshot.put("enabled",true).put("error","");bridge.snapshot=snapshot.toString();
      assertEquals("Successful reconnection automatically closes only the stale enrollment-recovery dialog","true",evaluate(web,
          "tick();document.getElementById('modal').hidden"));
      assertEquals("An intentional replacement form must not be dismissed by a healthy state poll","true",evaluate(web,
          "showNativeModal({kind:'enrollment',replace:true});document.querySelector('#modal-content input').value='staff-entered-code';tick();!document.getElementById('modal').hidden&&document.querySelector('#modal-content input').value==='staff-entered-code'"));
      snapshot.put("enabled",false).put("initialized",true);bridge.snapshot=snapshot.toString();
      assertEquals("A server-rejected registration is distinguished from an internet outage","true",evaluate(web,
          "tick();showNativeModal({kind:'saved-enrollment'});document.getElementById('modal-title').textContent==='Registration needs attention'"));
      snapshot.put("enabled",true);bridge.snapshot=snapshot.toString();evaluate(web,"tick();true");
      snapshot.put("tested", false); bridge.snapshot = snapshot.toString();
      assertEquals("Gmail entry must wait for camera confirmation", "true", evaluate(web,
          "tick();show('welcome');document.getElementById('begin').click();view==='welcome'&&document.getElementById('form').hidden"));
      assertTrue(bridge.actions.contains("setup:"));
      assertEquals("Submitting a stale Gmail form must also be blocked", "true", evaluate(web,
          "show('form');document.getElementById('email-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));view==='welcome'"));
      snapshot.put("tested", true); bridge.snapshot = snapshot.toString();
      assertEquals("A confirmed test permits the next player group", "true", evaluate(web,
          "tick();show('welcome');document.getElementById('begin').click();view==='form'"));
      snapshot.put("tested", false); bridge.snapshot = snapshot.toString();
      assertEquals("Camera reconnect must return a stale form to setup", "true", evaluate(web,
          "tick();view==='welcome'&&document.getElementById('form').hidden"));
      snapshot.put("tested", true); bridge.snapshot = snapshot.toString();
      evaluate(web, "show('welcome');tick();true");
      Thread.sleep(200);
      capture(activity, "welcome");
      assertEquals("true", evaluate(web, "document.getElementById('camera-status').textContent==='Camera ready'"));
      snapshot.put("tested", false); bridge.snapshot = snapshot.toString();
      assertEquals("true", evaluate(web, "tick();document.getElementById('camera-status').textContent==='Camera check'&&!document.getElementById('camera-status').classList.contains('ready')"));
      snapshot.put("tested", true); bridge.snapshot = snapshot.toString();
      evaluate(web, "tick();show('form');true");
      Thread.sleep(200);
      capture(activity, "form");
      evaluate(web, "window.showNativeModal({kind:'enrollment'});true");
      Thread.sleep(200);
      capture(activity, "enrollment");
      evaluate(web, "window.dismissNativeModal();show('saved-videos');renderSavedVideos();true");
      android.graphics.Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
      if (image != null && android.os.Build.VERSION.SDK_INT >= 29) {
        String name = "saved-videos-" + UUID.randomUUID() + ".png";
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/DinkVisionTests");
        android.net.Uri uri = activity.getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        try (OutputStream output = activity.getContentResolver().openOutputStream(uri)) {
          image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        }
        System.out.println("Saved UI test screenshot: Pictures/DinkVisionTests/" + name);
      }
      evaluate(web, "document.getElementById('saved-save').click();document.getElementById('saved-retry').click();true");
      assertTrue(bridge.actions.contains("save-local-video:"+first));
      assertTrue(bridge.actions.contains("retry-upload:"+first));
      JSONObject currentVideo=snapshot.getJSONArray("savedVideos").getJSONObject(0);
      assertEquals("A failed video still exposes manual retry after all eight automatic attempts","true",evaluate(web,
          "!document.getElementById('saved-retry').hidden&&!document.getElementById('saved-retry').disabled&&document.getElementById('saved-retry').textContent==='Retry upload'"));
      currentVideo.put("status","retrying").put("retryCount",7);bridge.snapshot=snapshot.toString();
      assertEquals("Scheduled retries also expose Retry now","true",evaluate(web,
          "tick();!document.getElementById('saved-retry').hidden&&document.getElementById('saved-retry').textContent==='Retry now'"));
      currentVideo.put("status","failed").put("retryCount",8);bridge.snapshot=snapshot.toString();
      currentVideo.put("exported",true).put("canRemove",true);bridge.snapshot=snapshot.toString();
      assertEquals("Removal requires confirmation and identifies the app copy only","true",evaluate(web,
          "tick();document.getElementById('saved-save').click();document.getElementById('modal-title').textContent==='Remove the app copy?'&&getComputedStyle(document.getElementById('modal-copy')).display!=='none'&&document.getElementById('modal-copy').textContent.includes('Gallery / Files')"));
      evaluate(web,"document.querySelector('#modal-actions .quiet').click();true");
      assertFalse(bridge.actions.contains("remove-local-video:"+first));
      evaluate(web,"document.getElementById('saved-save').click();document.querySelector('#modal-actions .primary').click();true");
      assertTrue(bridge.actions.contains("remove-local-video:"+first));
      assertEquals("The preview uses a proportion-preserving poster","true",evaluate(web,
          "document.getElementById('saved-player').getAttribute('poster')==='video-placeholder.svg'&&getComputedStyle(document.getElementById('saved-player')).objectFit==='contain'"));
      currentVideo.put("exported",false).put("canRemove",false);bridge.snapshot=snapshot.toString();
      currentVideo.put("status","saved_locally").put("brandingState","processing").put("brandingProgress",42);bridge.snapshot=snapshot.toString();
      assertEquals("Preview must not open the raw video during logo processing", "true", evaluate(web,
          "tick();renderSavedVideos();document.getElementById('saved-player').hidden&&!document.getElementById('saved-player').hasAttribute('src')&&!document.getElementById('saved-processing').hidden&&document.getElementById('saved-processing-progress').value===42&&document.getElementById('saved-processing-label').textContent.includes('42%')"));
      currentVideo.put("brandingState","complete");bridge.snapshot=snapshot.toString();
      assertEquals("The completed branded video becomes previewable", "true", evaluate(web,
          "tick();renderSavedVideos();!document.getElementById('saved-player').hidden&&document.getElementById('saved-player').hasAttribute('src')&&document.getElementById('saved-processing').hidden"));
      assertEquals("true", evaluate(web,
          "document.getElementById('saved-previous').click();"
          + "document.getElementById('saved-details').click();"
          + "document.getElementById('saved-retry').textContent==='Retry processing'&&!document.getElementById('modal').hidden&&"
          + "document.getElementById('modal-copy').textContent.includes('do not end together')"));
      snapshot.put("exportingSession", second).put("exportPercent", 42); bridge.snapshot = snapshot.toString();
      assertEquals("true", evaluate(web, "window.dismissNativeModal();tick();document.getElementById('saved-save').disabled&&document.getElementById('saved-save').textContent.includes('42%')"));
      snapshot.put("savedVideos", new JSONArray()); bridge.snapshot = snapshot.toString();
      assertEquals("true", evaluate(web, "tick();!document.getElementById('saved-empty').hidden&&document.getElementById('saved-panel').hidden&&handlePlayerBack()&&!document.getElementById('welcome').hidden"));
    } finally {
      engine.busy = oldBusy;
      instrumentation.runOnMainSync(() -> { web.removeJavascriptInterface("CasaNative"); web.destroy(); activity.finish(); });
    }
  }
}
