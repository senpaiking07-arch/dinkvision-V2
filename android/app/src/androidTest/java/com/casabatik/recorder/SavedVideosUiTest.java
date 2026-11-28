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
    final List<String> savedEmails = new CopyOnWriteArrayList<>();
    @JavascriptInterface public String state() { return snapshot; }
    @JavascriptInterface public String emailHistory(String prefix) throws JSONException {
      JSONArray matches = new JSONArray();
      if (prefix.length() >= 3)
        for (String email : savedEmails) if (email.startsWith(prefix)) matches.put(email);
      return new JSONObject().put("hasEntries", !savedEmails.isEmpty()).put("suggestions", matches).toString();
    }
    @JavascriptInterface public boolean removeSavedEmail(String email) {
      if (email.isEmpty()) savedEmails.clear();
      else savedEmails.remove(email);
      return true;
    }
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
    String packageName = instrumentation.getTargetContext().getPackageName();
    instrumentation.getUiAutomation().grantRuntimePermission(packageName, android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(packageName, android.Manifest.permission.RECORD_AUDIO);
    if (android.os.Build.VERSION.SDK_INT >= 33)
      instrumentation.getUiAutomation().grantRuntimePermission(packageName, android.Manifest.permission.POST_NOTIFICATIONS);
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
      MainActivity.attachRecipientInsets(replacement);
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
    bridge.savedEmails.add("saved.player@gmail.com");
    bridge.savedEmails.add("other.player@gmail.com");
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
      assertEquals("Welcome background opens email entry; header and dismissing settings stay on welcome", "true", evaluate(web,
          "(()=>{tick();show('welcome');$('header-court').click();if(view!=='welcome')return false;"
          + "$('settings-toggle').click();$('welcome').click();if(view!=='welcome'||!$('settings-actions').hidden)return false;"
          + "for(const el of [$('welcome').querySelector('h1'),$('welcome'),document.querySelector('footer')]){"
          + "el.click();if(view!=='form')return false;handlePlayerBack();}return true;})()"));
      assertEquals("The welcome screen opens re-enrollment on a registered tablet", "true", evaluate(web,
          "tick();show('welcome');$('reenroll').click();!$('reenroll').hidden"));
      assertTrue(bridge.actions.contains("setup-reenroll:"));
      assertEquals("Enrollment and replacement offer a single QR action with an optional code", "true", evaluate(web,
          "(()=>{for(const replace of [false,true]){showNativeModal({kind:'enrollment',replace});"
              + "const actions=[...$('modal-actions').children];"
              + "if(actions[0].textContent!=='Scan enrollment QR'||!actions[0].classList.contains('primary')"
              + "||actions.some(button=>button.textContent==='Show pairing QR')||$('modal-content').querySelector('input'))return false;"
              + "actions.find(button=>button.textContent==='Enter code instead').click();"
              + "if(!$('modal-content').querySelector('input[name=code]'))return false;"
              + "[...$('modal-actions').children].find(button=>button.textContent==='Back').click();"
              + "if($('modal').dataset.kind!=='enrollment')return false;}"
              + "$('modal-actions').querySelector('.primary').click();return $('modal').hidden;})()"));
      assertTrue(bridge.actions.contains("scan-enrollment:replace"));
      assertEquals("The scanned pairing code confirms once and uses the typed code action", "true", evaluate(web,
          "(()=>{showNativeModal({kind:'enrollment-pairing',code:'Abc012_de-Fg',replace:true});"
              + "const submit=$('modal-actions').querySelector('.primary'),replacement=submit.textContent==='Confirm replacement';"
              + "submit.click();submit.click();return replacement&&submit.disabled;})()"));
      assertEquals(1, bridge.actions.stream().filter(a -> a.startsWith("enroll:") && a.contains("Abc012_de-Fg")
          && a.contains("\"replace\":true")).count());
      assertEquals("A scanned replacement requires explicit PIN verification", "true", evaluate(web,
          "(()=>{showNativeModal({kind:'enrollment-pin',invite:'R'.repeat(24),replace:true});"
              + "const submit=$('modal-actions').querySelector('.primary'),replacement=submit.textContent==='Verify and replace';"
              + "$('modal-content').querySelector('input').value='654321';submit.click();return replacement&&submit.disabled;})()"));
      assertTrue(bridge.actions.stream().anyMatch(a -> a.startsWith("enroll-qr:") && a.contains("654321") && a.contains("\"replace\":true")));
      evaluate(web, "window.dismissNativeModal();true");
      System.out.println("Verified QR replacement from the Android welcome screen.");
      float density = activity.getResources().getDisplayMetrics().density;
      for (int[] size : new int[][]{{320,480},{360,640},{384,832},{568,320},{600,960},{768,1024},{800,1280},{1024,600},{1024,768},{1280,800},{1600,2560},{2560,1600}}) {
        CountDownLatch laidOut = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> {
          web.setLayoutParams(new FrameLayout.LayoutParams(Math.round(size[0]*density), Math.round(size[1]*density)));
          web.postDelayed(laidOut::countDown, 250);
        });
        assertTrue(laidOut.await(3, TimeUnit.SECONDS));
        String result = evaluate(web,
            "window.dismissNativeModal();show('welcome');tick();document.getElementById('settings-toggle').click();document.getElementById('saved-open').click();renderSavedVideos();"
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
            +"const top=after.top,header=document.querySelector('header').getBoundingClientRect().bottom;"
            +"positionNotifications();if(getComputedStyle($('notifications')).pointerEvents!=='none'||getComputedStyle(n).pointerEvents!=='none'||getComputedStyle(r).pointerEvents!=='auto'||n.getBoundingClientRect().top<header+7)moved.push('notification blocks touches or header');"
            +"const nr=n.getBoundingClientRect(),hit=document.elementFromPoint(nr.left+nr.width/2,nr.top+nr.height/2);if(hit?.closest('#notifications'))moved.push('notification intercepts welcome touch');"
            +"const rr=r.getBoundingClientRect();if(document.elementFromPoint(rr.left+rr.width/2,rr.top+rr.height/2)!==r)moved.push('recovery action not tappable');"
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
            "(()=>{const bad=[];const check=(screen,ids)=>{show(screen);for(const id of ids){const e=document.getElementById(id);if(screen==='form')e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();"
            + "if(r.width<44||r.height<44||r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1)bad.push({screen,id,r:r.toJSON()});}};"
            + "check('welcome',['begin']);const bg=getComputedStyle(document.querySelector('.backdrop')).backgroundImage;"
            + "const expected=innerWidth<=700&&innerHeight>innerWidth?'Kiosk-Background-Phone.png':'Kiosk-Background-Tablet.png';if(!bg.includes(expected))bad.push({background:bg,expected});"
            + "emails=['one.player@gmail.com','two.player@gmail.com','three.player@gmail.com','four.player@gmail.com'];renderEmails();"
            + "check('form',['back','player-email','add-email']);$('record').scrollIntoView({block:'nearest'});check('form',['record']);"
            + "if($('record').getBoundingClientRect().height<80||$('player-email').getBoundingClientRect().height<64||$('add-email').getBoundingClientRect().height<64||document.querySelectorAll('.record-steps span').length!==3)bad.push({screen:'form',issue:'missing large one-step controls'});"
            + "document.getElementById('stop').hidden=false;check('session',['stop']);check('camera-test',['camera-test-confirm','camera-test-retry']);"
            + "show('saved-videos');renderSavedVideos();return JSON.stringify(bad);})()");
        assertEquals(Arrays.toString(size) + " " + journeys, "[]", new JSONTokener(journeys).nextValue().toString());
        String headers = evaluate(web, """
            (() => {
              const header = document.querySelector('header');
              const logo = header.querySelector('.brand img');
              const status = header.querySelector('.header-status');
              const notice = $('connection-notice');
              const bounds = element => element.getBoundingClientRect().toJSON();
              const layout = () => JSON.stringify({
                header: bounds(header), logo: bounds(logo), status: bounds(status),
                divider: getComputedStyle(header).borderBottomColor,
                background: getComputedStyle(header, '::before').backgroundColor
              });
              show('welcome');
              const expected = layout();
              const title = $('welcome').querySelector('h1');
              const words = document.createRange();
              words.selectNodeContents(title);
              const titleBounds = bounds($('welcome'));
              const clipped = [...words.getClientRects()].some(rect =>
                rect.left < titleBounds.left || rect.right > titleBounds.right);
              const mismatched = ['form', 'session', 'camera-test', 'saved-videos'].filter(screen => {
                show(screen);
                return layout() !== expected;
              });
              if (clipped) mismatched.push('welcome title clipped');
              const previouslyHidden = notice.hidden;
              notice.hidden = false;
              if (bounds(notice).top < bounds(header).bottom || layout() !== expected)
                mismatched.push('connection notice');
              notice.hidden = previouslyHidden;
              if (bounds(logo).right > bounds(status).left) mismatched.push('logo overlaps status');
              return JSON.stringify(mismatched);
            })()
            """);
        assertEquals(Arrays.toString(size) + " header changes between screens " + headers, "[]",
            new JSONTokener(headers).nextValue().toString());
        String keyboardLayout = evaluate(web,
            "(()=>{show('form');clearRecipientDraft();const input=$('player-email');input.value='sav';input.dispatchEvent(new Event('input'));const backdrop=document.querySelector('.backdrop');"
            + "const original=backdrop.getBoundingClientRect().toJSON();const keyboard=Math.round(innerHeight*.63);"
            + "setRecipientKeyboardInset(keyboard*devicePixelRatio);"
            + "const bad=[$('player-email'),$('add-email')].flatMap(el=>{const r=el.getBoundingClientRect();"
            + "return r.width>=44&&r.height>=44&&r.top>=0&&r.bottom<=innerHeight-keyboard+1?[]:[{text:el.textContent,r:r.toJSON()}];});"
            + "const anchored=JSON.stringify(original)===JSON.stringify(backdrop.getBoundingClientRect().toJSON());"
            + "setRecipientKeyboardInset(0);clearRecipientDraft();return JSON.stringify({bad,anchored,restored:!document.body.classList.contains('recipient-ime')});})()");
        JSONObject keyboard = new JSONObject(new JSONTokener(keyboardLayout).nextValue().toString());
        assertEquals(Arrays.toString(size) + " keyboard bounds " + keyboard, 0, keyboard.getJSONArray("bad").length());
        assertTrue(keyboard.toString(), keyboard.getBoolean("anchored") && keyboard.getBoolean("restored"));
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
            "JSON.stringify(['enrollment','enrollment-code','enrollment-pin','saved-enrollment','session-recovery','camera-ready-device','permission','discard','leave','remove-saved-video'].filter(kind=>{showNativeModal({kind,id:'"+first+"'});const e=document.querySelector('.modal-card'),r=e.getBoundingClientRect();"
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
      snapshot.put("phase","complete").put("latestSavedSession","toast-test")
          .put("message","Upload complete. The replay email is being sent.");
      bridge.snapshot=snapshot.toString();
      String toastState = evaluate(web,
          "show('welcome');tick();(()=>{const n=$('notice'),r=n.getBoundingClientRect(),h=document.querySelector('header').getBoundingClientRect();"
          + "const font=parseFloat(getComputedStyle(n).fontSize),duration=getComputedStyle(n,'::after').animationDuration,remaining=statusNoticeExpiresAt-performance.now();"
          + "return JSON.stringify({hidden:n.hidden,complete:n.classList.contains('upload-complete'),top:r.top,header:h.bottom,height:r.height,font,duration,remaining,"
          + "valid:!n.hidden&&n.classList.contains('upload-complete')&&r.top>=h.bottom+7&&r.height>=58&&font>=16&&duration==='4.8s'&&remaining>4000});})()");
      assertTrue("Upload success floats below the header and expires after 4.8 seconds: " + toastState,
          new JSONObject(new JSONTokener(toastState).nextValue().toString()).getBoolean("valid"));
      assertEquals("Expired upload success stays hidden without a new event", "true", evaluate(web,
          "statusNoticeExpiresAt=performance.now()-1;tick();$('notice').hidden"));
      snapshot.put("phase","idle");snapshot.remove("latestSavedSession");snapshot.remove("message");
      bridge.snapshot=snapshot.toString();
      JSONObject unavailable = new JSONObject().put("id", UUID.randomUUID().toString()).put("localAvailable",false)
          .put("status","failed").put("captureInterruptionCode","app_interrupted").put("validationFailed",true);
      JSONArray originalItems = snapshot.getJSONArray("savedVideos");
      snapshot.put("savedVideos", new JSONArray().put(unavailable)).put("localDeviceKnown",true).put("updateChecking",true);
      bridge.snapshot=snapshot.toString();
      assertEquals("Offline interrupted attempt stays visible without media actions", "true", evaluate(web,
          "tick();$('update-saved').click();view==='saved-videos'&&$('saved-video-status').textContent.includes('No footage available')"
          + "&&$('saved-player').hidden&&$('saved-save').hidden&&$('saved-retry').hidden"));
      evaluate(web,"handlePlayerBack();true");
      snapshot.remove("updateChecking");snapshot.put("savedVideos",originalItems);bridge.snapshot=snapshot.toString();
      assertEquals("Four recipients appear on the single start screen", "true", evaluate(web,
          "tick();show('welcome');$('begin').click();clearRecipientDraft();$('player-email').value='one@court.ph,two@court.ph,three@court.ph,four@court.ph';"
          + "addEmail();view==='form'&&emails.length===4&&$('email-list').children.length===4&&$('add-email').disabled&&!$('record').disabled&&!$('email-history')"));
      assertEquals("Validation and editing stay on the single start screen", "true", evaluate(web,
          "(()=>{tick();show('welcome');$('begin').click();clearRecipientDraft();const input=$('player-email');"
          + "const empty=$('record').disabled&&$('start-help').textContent.includes('at least 1 email');"
          + "input.value='not-an-address';addEmail();const invalid=input.getAttribute('aria-invalid')==='true';"
          + "input.value='manual.player@gmail.com';addEmail();input.value='MANUAL.PLAYER@gmail.com';"
          + "const duplicate=!addEmail()&&emails.length===1;"
          + "input.value='';renderEmailFeedback();const listed=view==='form'&&$('email-list').textContent.includes('manual.player@gmail.com')&&!$('record').disabled;"
          + "$('email-list').querySelector('button:not(.edit-address)').click();const removed=emails.length===0&&$('record').disabled;"
          + "input.value='manual.player@gmail.com';addEmail();"
          + "input.value='unadded@gmail.com';$('email-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));"
          + "const mustAdd=view==='form'&&$('email-error').textContent.includes('Tap ADD EMAIL')&&$('email-count').textContent.includes('1 of 4')&&emails.length===1;"
          + "input.value='';renderEmailFeedback();return empty&&invalid&&duplicate&&listed&&removed&&mustAdd&&view==='form';})()"));
      long startsBefore=bridge.actions.stream().filter(action->action.startsWith("start:")).count();
      assertEquals("A pending start must preserve the listed group", "true", evaluate(web,
          "document.getElementById('record').click();document.getElementById('record').click();emails.length===1&&emails[0]==='manual.player@gmail.com'&&document.getElementById('record').disabled"));
      assertEquals("Repeated taps must not submit another start",startsBefore+1,bridge.actions.stream().filter(action->action.startsWith("start:")).count());
      String startAction = bridge.actions.stream().filter(action -> action.startsWith("start:")).reduce((a,b) -> b).orElseThrow();
      JSONObject startPayload = new JSONObject(startAction.substring("start:".length()));
      assertEquals("manual.player@gmail.com", startPayload.getJSONArray("emails").getString(0));
      assertFalse(startPayload.has("remember"));
      assertTrue(startPayload.getInt("tapDelayMs") >= 0);
      snapshot.put("phase","connecting").put("busy",true);bridge.snapshot=snapshot.toString();
      assertEquals("Addresses remain available while connecting", "true",evaluate(web,"tick();view==='session'&&emails.length===1"));
      snapshot.put("phase","error").put("busy",false).put("recoverable",true).put("startHasRecoverableFootage",false).put("error","Controlled start failure")
          .put("session",new JSONObject().put("id",UUID.randomUUID().toString()).put("status","requested"));bridge.snapshot=snapshot.toString();
      assertEquals("An older failed clip must not block a failed start retry for the next group", "true",evaluate(web,"tick();view==='form'&&emails.length===1&&!document.getElementById('record').disabled"));
      evaluate(web,"document.getElementById('record').click();true");
      snapshot.put("phase","recording").put("busy",true).put("elapsedMs",1000).put("captureAttempt","current-capture");bridge.snapshot=snapshot.toString();
      assertEquals("Recipients clear only once capture has actually started", "true",evaluate(web,"tick();view==='session'&&emails.length===0"));
      evaluate(web, "$('stop').click();$('stop').click();true");
      assertEquals("Repeated Stop taps send one attempt-scoped command", 1,
          bridge.actions.stream().filter(action -> action.equals("stop:current-capture")).count());
      snapshot.put("phase","error").put("busy",false).put("recoverable",true).put("startHasRecoverableFootage",true).put("recoveryKind","partial")
          .put("message","Video and audio confirmed. This tablet is ready for player mode.")
          .put("session",new JSONObject().put("id",first).put("status","recording"));bridge.snapshot=snapshot.toString();
      assertEquals("A stale server state must not trap local capture recovery", "true",evaluate(web,"tick();view==='welcome'&&!document.getElementById('recover').hidden"));
      assertEquals("Local footage errors direct players to Saved videos without exposing a raw failure","true",evaluate(web,
          "document.getElementById('error-message').textContent.includes('Your recording is in Saved videos')&&!document.getElementById('error-message').textContent.includes('Controlled start failure')"));
      assertEquals("Actionable recovery stays visible across polls", "true", evaluate(web,
          "tick();tick();!$('error').hidden&&$('notice').hidden&&!$('recover').hidden"));
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
          "showNativeModal({kind:'enrollment-code',replace:true});document.querySelector('#modal-content input').value='staff-entered-code';tick();!document.getElementById('modal').hidden&&document.querySelector('#modal-content input').value==='staff-entered-code'"));
      evaluate(web, "$('modal-content').querySelector('input').value='Abc012_de-Fg';$('modal-actions').querySelector('.primary').click();true");
      snapshot.put("error","The server rejected this enrollment code.");bridge.snapshot=snapshot.toString();
      assertEquals("Enrollment rejection keeps the code form and displays the next action","true",evaluate(web,
          "tick();!$('modal').hidden&&!$('modal-error').hidden&&$('modal-error').textContent.includes('rejected')"
              + "&&$('modal-content').querySelector('input').value==='Abc012_de-Fg'&&!$('modal-actions').querySelector('.primary').disabled"));
      snapshot.put("error","");
      snapshot.put("enabled",false).put("initialized",true).put("registrationInactive",true);bridge.snapshot=snapshot.toString();
      assertEquals("A server-rejected registration is distinguished from an internet outage","true",evaluate(web,
          "tick();showNativeModal({kind:'saved-enrollment'});document.getElementById('modal-title').textContent==='Registration needs attention'"));
      snapshot.put("enabled",true).remove("registrationInactive");bridge.snapshot=snapshot.toString();evaluate(web,"tick();true");
      assertEquals("QR enrollment requires the full PIN and accepts one submit", "true", evaluate(web,
          "showNativeModal({kind:'enrollment-pin',invite:'Q'.repeat(24)});const p=$('modal-content').querySelector('input'),b=$('modal-actions').querySelector('.primary');"
              + "p.value='12345';b.click();const incomplete=!$('modal-error').hidden&&!b.disabled;"
              + "p.value='012345';b.click();b.click();incomplete&&b.disabled"));
      assertEquals(1, bridge.actions.stream().filter(a -> a.startsWith("enroll-qr:") && a.contains("012345")).count());
      evaluate(web, "window.dismissNativeModal();true");
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
      assertEquals("The phone header stays in view on the recipient form", "true", evaluate(web,
          "document.querySelector('header').getBoundingClientRect().top>=0&&scrollY===0"));
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
      currentVideo.put("captureInterruptionCode", "camera_disconnected").put("validationFailed", true);
      bridge.snapshot = snapshot.toString();
      assertEquals("An interrupted original remains exportable while playback and upload are blocked", "true",
          evaluate(web, "tick();$('saved-details').click();"
              + "$('saved-video-status').textContent.includes('Interrupted recording')&&$('saved-player').hidden"
              + "&&!$('saved-preview-warning').hidden&&$('saved-retry').hidden&&!$('saved-save').disabled"
              + "&&$('modal-copy').textContent.includes('The camera disconnected.')"));
      evaluate(web, "window.dismissNativeModal();true");
      currentVideo.remove("captureInterruptionCode"); currentVideo.remove("validationFailed");
      bridge.snapshot = snapshot.toString();
      evaluate(web, "tick();true");
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
      currentVideo.put("status", "uploading").put("bytes", 2_097_152).put("uploadedBytes", 2_097_152)
          .put("progress", 99).put("verifyingUpload", true);
      bridge.snapshot = snapshot.toString();
      assertEquals("Drive confirmation remains distinct from upload completion", "true", evaluate(web,
          "tick();$('saved-video-status').textContent==='Verifying upload'&&$('saved-video-meta').textContent.includes('2.0 / 2.0 MB uploaded')&&$('saved-retry').hidden"));
      assertEquals("true", evaluate(web,
          "document.getElementById('saved-previous').click();"
          + "document.getElementById('saved-details').click();"
          + "document.getElementById('saved-retry').textContent==='Retry processing'&&!document.getElementById('modal').hidden&&"
          + "document.getElementById('modal-copy').textContent.includes('do not end together')"));
      snapshot.put("exportingSession", second).put("exportPercent", 42); bridge.snapshot = snapshot.toString();
      assertEquals("true", evaluate(web, "window.dismissNativeModal();tick();document.getElementById('saved-save').disabled&&document.getElementById('saved-save').textContent.includes('42%')"));
      snapshot.put("savedVideos", new JSONArray()); bridge.snapshot = snapshot.toString();
      assertEquals("true", evaluate(web, "tick();!document.getElementById('saved-empty').hidden&&document.getElementById('saved-panel').hidden&&handlePlayerBack()&&!document.getElementById('welcome').hidden"));
      if (android.os.Build.VERSION.SDK_INT >= 30) assertDockedKeyboard(web);
    } finally {
      engine.busy = oldBusy;
      instrumentation.runOnMainSync(() -> { web.removeJavascriptInterface("CasaNative"); web.destroy(); activity.finish(); });
    }
  }

  private void assertDockedKeyboard(WebView web) throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    evaluate(web, "window.dismissNativeModal();show('form');true");
    JSONObject before = new JSONObject(new JSONTokener(evaluate(web,
        "JSON.stringify(document.querySelector('.backdrop').getBoundingClientRect().toJSON())")).nextValue().toString());
    JSONArray tap = new JSONArray(new JSONTokener(evaluate(web,
        "(()=>{const r=$('player-email').getBoundingClientRect();return JSON.stringify([(r.left+r.width/2)*devicePixelRatio,(r.top+r.height/2)*devicePixelRatio]);})()"))
        .nextValue().toString());
    int[] location = new int[2];
    instrumentation.runOnMainSync(() -> web.getLocationOnScreen(location));
    String command = "input tap " + (location[0] + tap.getInt(0)) + " " + (location[1] + tap.getInt(1));
    instrumentation.getUiAutomation().executeShellCommand(command).close();
    awaitPlayer(web, "document.activeElement===$('player-email')&&recipientKeyboardInset>40");
    assertEquals("Email controls must be above the docked keyboard", "true", evaluate(web,
        "[$('player-email'),$('add-email')].every(el=>el.getBoundingClientRect().bottom<=innerHeight-recipientKeyboardInset+1)&&getComputedStyle($('record')).display==='none'&&getComputedStyle($('notifications')).visibility==='hidden'"));
    assertEquals(before.toString(), new JSONTokener(evaluate(web,
        "JSON.stringify(document.querySelector('.backdrop').getBoundingClientRect().toJSON())")).nextValue().toString());
    instrumentation.getUiAutomation().executeShellCommand("input keyevent KEYCODE_BACK").close();
    awaitPlayer(web, "view==='form'&&!document.body.classList.contains('recipient-ime')");
  }

  private void awaitPlayer(WebView web, String script) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
    while (System.nanoTime() < deadline) {
      if ("true".equals(evaluate(web, script))) return;
      Thread.sleep(100);
    }
    fail("Player did not reach expected state: " + script);
  }
}
