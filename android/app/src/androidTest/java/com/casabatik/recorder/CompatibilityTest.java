package com.casabatik.recorder;
import static org.junit.Assert.*;
import android.content.pm.ServiceInfo;
import org.junit.Test;
public class CompatibilityTest {
  @Test public void captureDoesNotUseTransferQuota() {
    assertEquals(0, RecorderService.foregroundTypes(36) & ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE | ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA,
        RecorderService.foregroundTypes(29));
    assertTrue((RecorderService.foregroundTypes(36) & ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0);
  }
}
