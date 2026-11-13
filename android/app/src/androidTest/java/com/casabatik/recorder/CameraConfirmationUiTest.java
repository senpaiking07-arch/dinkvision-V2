package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.Intent;
import android.webkit.*;
import androidx.webkit.WebViewAssetLoader;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.Test;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

public class CameraConfirmationUiTest {
  private String evaluate(WebView web,String script) throws Exception {
    CountDownLatch done=new CountDownLatch(1);AtomicReference<String> result=new AtomicReference<>();
    InstrumentationRegistry.getInstrumentation().runOnMainSync(()->web.evaluateJavascript(script,value->{result.set(value);done.countDown();}));
    assertTrue(done.await(5,TimeUnit.SECONDS));return result.get();
  }

  @Test public void exactModeReviewAndPersistentConnectionNotice() throws Exception {
    var instrumentation=InstrumentationRegistry.getInstrumentation();
    MainActivity activity=(MainActivity)instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    Engine engine=Engine.get(activity);boolean oldBusy=engine.busy;engine.busy=true;
    AtomicReference<WebView> view=new AtomicReference<>();
    instrumentation.runOnMainSync(()->{WebView web=new WebView(activity);web.getSettings().setJavaScriptEnabled(true);activity.setContentView(web);view.set(web);});
    WebView web=view.get();SavedVideosUiTest.FakeBridge bridge=new SavedVideosUiTest.FakeBridge();
    JSONObject state=new JSONObject().put("enabled",true).put("enrolled",true).put("initialized",true).put("tested",false)
      .put("cameraMode","device").put("phase","review").put("testReady",true).put("testConfirmable",true)
      .put("testToken","current").put("selectedRecordingMode","auto").put("testHasAudio",true)
      .put("recordingModes",new JSONArray().put(new JSONObject().put("key","1920x1080@60").put("width",1920).put("height",1080).put("fps",60).put("supported",true)));
    bridge.snapshot=state.toString();CountDownLatch loaded=new CountDownLatch(1);
    try {
      instrumentation.runOnMainSync(()->{
        WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/assets/",new WebViewAssetLoader.AssetsPathHandler(activity)).build();
        web.addJavascriptInterface(bridge,"CasaNative");
        web.setWebViewClient(new WebViewClient(){
          public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
            if(request.getUrl().getPath().startsWith("/camera-test/"))try{return new WebResourceResponse("video/mp4",null,instrumentation.getContext().getAssets().open("recording-one-second.mp4"));}catch(Exception ignored){}
            return loader.shouldInterceptRequest(request.getUrl());
          }
          public void onPageFinished(WebView view,String url){loaded.countDown();}
        });web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
      });
      assertTrue(loaded.await(10,TimeUnit.SECONDS));
      for(int i=0;i<30 && !"false".equals(evaluate(web,"tick();document.getElementById('camera-test-confirm').disabled"));i++)Thread.sleep(100);
      assertEquals("false",evaluate(web,"document.getElementById('camera-test-confirm').disabled"));
      evaluate(web,"document.getElementById('camera-test-confirm').style.transition='none';document.getElementById('camera-quality').value='1920x1080@60';document.getElementById('camera-quality').dispatchEvent(new Event('change'));");
      state.put("testConfirmable",false).put("selectedRecordingMode","1920x1080@60");bridge.snapshot=state.toString();
      assertEquals("true",evaluate(web,"tick();document.getElementById('camera-test-confirm').disabled"));
      assertEquals("\"rgb(100, 116, 139)\"",evaluate(web,"getComputedStyle(document.getElementById('camera-test-confirm')).backgroundColor"));
      evaluate(web,"document.getElementById('camera-test-confirm').click()");
      assertFalse(bridge.actions.stream().anyMatch(action->action.startsWith("confirm-camera-test")));
      state.put("selectedRecordingMode","auto");bridge.snapshot=state.toString();
      assertEquals("true",evaluate(web,"tick();document.getElementById('camera-test-confirm').disabled"));
      state.put("phase","recording").put("busy",true).put("testReady",false)
        .put("connectionNotice",ConnectionNotice.message(false,false));bridge.snapshot=state.toString();
      assertEquals("false",evaluate(web,"tick();document.getElementById('connection-notice').hidden"));
      assertEquals("\"recording\"",evaluate(web,"state.phase"));
      state.put("connectionNotice",ConnectionNotice.message(true,false));bridge.snapshot=state.toString();
      assertTrue(evaluate(web,"tick();document.getElementById('connection-notice').textContent").contains("Internet available"));
      state.put("connectionNotice",ConnectionNotice.message(true,true));bridge.snapshot=state.toString();
      assertEquals("true",evaluate(web,"tick();document.getElementById('connection-notice').hidden"));
    } finally {
      engine.busy=oldBusy;instrumentation.runOnMainSync(()->{web.destroy();activity.finish();});
    }
  }
}
