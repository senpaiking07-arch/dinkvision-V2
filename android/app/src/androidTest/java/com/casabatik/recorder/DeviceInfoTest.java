package com.casabatik.recorder;
import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DeviceInfoTest {
  @Test public void inventoryReportsBuildAndAttachedCamerasWithoutUniqueCredentials() throws Exception {
    var value = DeviceInfo.report(InstrumentationRegistry.getInstrumentation().getTargetContext());
    assertEquals("android", value.getString("platform"));
    assertEquals(android.os.Build.MODEL, value.getString("model"));
    assertEquals(BuildConfig.VERSION_NAME, value.getString("app_version"));
    assertTrue(value.getJSONArray("usb_cameras").length() <= 4);
    assertFalse(value.has("serial")); assertFalse(value.has("android_id")); assertFalse(value.has("cookies"));
  }
}
