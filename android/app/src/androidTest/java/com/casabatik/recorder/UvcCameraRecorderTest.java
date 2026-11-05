package com.casabatik.recorder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.serenegiant.usb.Size;
import com.serenegiant.usb.UVCCamera;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class UvcCameraRecorderTest {
  private static Size size(int type, int width, int height, Integer... fps) {
    List<Integer> rates = Arrays.asList(fps);
    return new Size(type, width, height, rates.get(0), rates);
  }

  @Test
  public void prefersHighestResolutionAt60FpsWhenTheEncoderSupportsIt() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 3840, 2160, 60),
                size(UVCCamera.UVC_VS_FRAME_UNCOMPRESSED, 1280, 720, 30),
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 1280, 720, 60, 30, 15)), (w,h,f)->true);
    assertEquals(UVCCamera.UVC_VS_FRAME_MJPEG, selected.type);
    assertEquals(3840, selected.width);
    assertEquals(2160, selected.height);
    assertEquals(60, selected.fps);
  }

  @Test
  public void avoids4kWhenCameraHasA1080pMjpegMode() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 3840, 2160, 30),
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 1920, 1080, 30),
                size(UVCCamera.UVC_VS_FRAME_UNCOMPRESSED, 640, 480, 30)), (w,h,f)->true);
    assertEquals(1920, selected.width);
    assertEquals(1080, selected.height);
    assertEquals(30, selected.fps);
  }

  @Test
  public void avoids4kEvenWhenOnlyTheSmallerModeIsUncompressed() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(
                size(UVCCamera.UVC_VS_FRAME_MJPEG, 3840, 2160, 30),
                size(UVCCamera.UVC_VS_FRAME_UNCOMPRESSED, 1280, 720, 30)), (w,h,f)->true);
    assertEquals(1280, selected.width);
    assertEquals(720, selected.height);
  }

  @Test
  public void preservesTheOnlyFrameRateReportedByTheCamera() throws Exception {
    Size selected =
        UvcCameraRecorder.chooseRecordingSize(
            Arrays.asList(size(UVCCamera.UVC_VS_FRAME_MJPEG, 1280, 720, 60)), (w,h,f)->true);
    assertEquals(60, selected.fps);
  }

  @Test public void aSmaller60FpsModeBeats4k30AndUnsupported4k60() throws Exception {
    Size selected=UvcCameraRecorder.chooseRecordingSize(Arrays.asList(
        size(UVCCamera.UVC_VS_FRAME_MJPEG,3840,2160,60,30),
        size(UVCCamera.UVC_VS_FRAME_MJPEG,1920,1080,30),
        size(UVCCamera.UVC_VS_FRAME_MJPEG,1280,720,60,30)),(w,h,f)->w<=1920);
    assertEquals(1280,selected.width);assertEquals(60,selected.fps);
  }
  @Test public void neverInventsFpsOrSelectsAnUnencodableCameraMode() throws Exception {
    Size selected=UvcCameraRecorder.chooseRecordingSize(Arrays.asList(
        size(UVCCamera.UVC_VS_FRAME_MJPEG,1920,1080,25),
        size(UVCCamera.UVC_VS_FRAME_MJPEG,1280,720,15)),(w,h,f)->true);
    assertEquals(25,selected.fps);assertEquals(1920,selected.width);
    org.junit.Assert.assertThrows(Exception.class,()->UvcCameraRecorder.chooseRecordingSize(
        Arrays.asList(size(UVCCamera.UVC_VS_FRAME_MJPEG,1920,1080,60)),(w,h,f)->false));
  }
  @Test public void failed60FpsThroughputTriesSmallerModesThen1080p30() throws Exception {
    List<Size> modes=Arrays.asList(size(UVCCamera.UVC_VS_FRAME_MJPEG,1920,1080,30),
        size(UVCCamera.UVC_VS_FRAME_MJPEG,1280,720,60,30),size(UVCCamera.UVC_VS_FRAME_MJPEG,640,480,60));
    Size smaller=UvcCameraRecorder.chooseRecordingSize(modes,(w,h,f)->true,1280L*720-1);
    assertEquals(640,smaller.width);assertEquals(60,smaller.fps);
    Size fallback=UvcCameraRecorder.chooseRecordingSize(modes,(w,h,f)->true,0);
    assertEquals(1920,fallback.width);assertEquals(30,fallback.fps);
    Size smooth=UvcCameraRecorder.chooseRecordingSize(modes,(w,h,f)->true,0,1920L*1080-1);
    assertEquals(1280,smooth.width);assertEquals(30,smooth.fps);
    assertFalse(RecordingProfile.sustains(30,20.2));assertTrue(RecordingProfile.sustains(30,29.93));
    assertFalse(RecordingProfile.sustains60(29.93));assertFalse(RecordingProfile.sustains60(Double.NaN));
    assertTrue(RecordingProfile.sustains60(59.94));
  }
  @Test public void explicitQualityChoiceUsesOnlyAnOfferedSupportedMode() throws Exception {
    List<Size> modes=Arrays.asList(size(UVCCamera.UVC_VS_FRAME_MJPEG,1920,1080,60,30),size(UVCCamera.UVC_VS_FRAME_MJPEG,1280,720,60));
    Size selected=UvcCameraRecorder.chooseRecordingSize(modes,(w,h,f)->true,Long.MAX_VALUE,Long.MAX_VALUE,"1920x1080@30");
    assertEquals(1920,selected.width);assertEquals(30,selected.fps);
    org.junit.Assert.assertThrows(Exception.class,()->UvcCameraRecorder.chooseRecordingSize(modes,(w,h,f)->true,Long.MAX_VALUE,Long.MAX_VALUE,"3840x2160@60"));
    org.junit.Assert.assertThrows(Exception.class,()->UvcCameraRecorder.chooseRecordingSize(modes,(w,h,f)->false,Long.MAX_VALUE,Long.MAX_VALUE,"1920x1080@60"));
  }
}
