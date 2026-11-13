package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class EmailHistoryTest {
  @Test public void optedInHistoryPersistsAndExpiresWithinItsEnrollment() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    SharedPreferences preferences = base.getSharedPreferences("email-history-test-" + UUID.randomUUID(), 0);
    Context context = new ContextWrapper(base) {
      @Override public Context getApplicationContext() { return this; }
      @Override public SharedPreferences getSharedPreferences(String name, int mode) { return preferences; }
    };
    try {
      Vault vault = new Vault(context);
      AtomicLong now = new AtomicLong(1000L);
      EmailHistory history = new EmailHistory(vault, now::get);
      vault.put("cookies", new JSONObject().put("cb-kiosk", "first-test-credential").toString());
      String enrollment = history.enrollment();
      history.remember(enrollment, new JSONArray().put("saved@players.test").put("private@players.test"),
          new JSONArray().put(true).put(false));
      assertTrue(history.find("").getBoolean("hasEntries"));
      assertEquals(0, history.find("sa").getJSONArray("suggestions").length());
      assertEquals(0, history.find("pri").getJSONArray("suggestions").length());
      assertFalse(preferences.getString("data", "").contains("saved@players.test"));
      vault = new Vault(context);
      history = new EmailHistory(vault, now::get);
      assertEquals("saved@players.test", history.find("SAV").getJSONArray("suggestions").getString(0));
      now.addAndGet(TimeUnit.DAYS.toMillis(30));
      assertFalse(history.find("sav").getBoolean("hasEntries"));
      for (int index = 0; index < 105; index++) {
        history.remember(enrollment, new JSONArray().put("player" + index + "@players.test"),
            new JSONArray().put(true));
      }
      assertEquals(100, vault.object("recipient-history").getJSONArray("entries").length());
      assertEquals(0, history.find("player0@").getJSONArray("suggestions").length());
      assertEquals("player104@players.test", history.find("pla").getJSONArray("suggestions").getString(0));
      history.remove("player104@players.test");
      assertEquals(0, history.find("player104@").getJSONArray("suggestions").length());
      vault.put("cookies", new JSONObject().put("cb-kiosk", "replacement-test-credential").toString());
      assertFalse(history.find("pla").getBoolean("hasEntries"));
      history.remember(enrollment, new JSONArray().put("late@players.test"), new JSONArray().put(true));
      assertFalse(history.find("lat").getBoolean("hasEntries"));
      history.remember(history.enrollment(), new JSONArray().put("current@players.test"), new JSONArray().put(true));
      history.remove("");
      assertFalse(history.find("cur").getBoolean("hasEntries"));
    } finally {
      preferences.edit().clear().commit();
    }
  }
}
