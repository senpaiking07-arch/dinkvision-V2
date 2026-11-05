package com.casabatik.recorder;
import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AppUpdateTest {
  @Test public void mandatoryPolicySurvivesOfflineCachingButOnlyBlocksOlderBuilds() throws Exception {
    JSONObject policy=AppUpdate.validate(new JSONObject().put("versionName","0.5.35").put("versionCode",41)
        .put("required",true).put("downloadUrl","https://example.com/downloads/recorder.apk"));
    JSONObject cached=new JSONObject(policy.toString());
    assertTrue(AppUpdate.required(cached,40));assertFalse(AppUpdate.required(cached,41));assertFalse(AppUpdate.required(cached,42));
    for(String bad:new String[]{"javascript:alert(1)","http://example.com/app.apk","https://user:pw@example.com/app.apk","https:///app.apk"})
      assertFalse(bad,AppUpdate.safeDownloadUrl(bad));
    policy.put("downloadUrl","");assertThrows(Exception.class,()->AppUpdate.validate(policy));
  }

  @Test public void requiredUpdateCoversTheRealPlayerAndRejectsNativeSetupActions() throws Exception {
    var instrumentation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation();
    MainActivity activity=(MainActivity)instrumentation.startActivitySync(new android.content.Intent(
        instrumentation.getTargetContext(),MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
    Engine engine=Engine.get(activity);
    Thread.sleep(2500);
    String saved=engine.vault.get("android-release");boolean checked=engine.releaseChecked;
    try {
      engine.releaseChecked=true;
      engine.vault.put("android-release",new JSONObject().put("versionName","0.5.36")
          .put("versionCode",BuildConfig.VERSION_CODE+1).put("required",true)
          .put("downloadUrl","https://example.com/downloads/recorder.apk").toString());
      Thread.sleep(1000);
      java.util.concurrent.CountDownLatch latch=new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.atomic.AtomicReference<String> answer=new java.util.concurrent.atomic.AtomicReference<>();
      instrumentation.runOnMainSync(()->{
        android.webkit.WebView web=(android.webkit.WebView)((android.view.ViewGroup)activity.findViewById(android.R.id.content)).getChildAt(0);
        web.evaluateJavascript("tick();CasaNative.action('setup-reenroll','');CasaNative.action('start','[\\\"must.not.send@gmail.com\\\"]');"
            +"!document.getElementById('required-update').hidden&&document.querySelector('main').inert&&document.getElementById('modal').hidden",
            value->{answer.set(value);latch.countDown();});
      });
      assertTrue(latch.await(5,java.util.concurrent.TimeUnit.SECONDS));assertEquals("true",answer.get());
      assertFalse("Update gate must not create a recording",engine.busy);
    }finally{engine.vault.put("android-release",saved);engine.releaseChecked=checked;instrumentation.runOnMainSync(activity::finish);}
  }
}
