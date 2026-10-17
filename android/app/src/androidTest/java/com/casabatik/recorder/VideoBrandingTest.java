package com.casabatik.recorder;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.bytedeco.javacv.Frame;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class VideoBrandingTest {
  @Test
  public void savedVideoHasLogoMarkerAndRemainsPlayable() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    File source =
        new File(instrumentation.getTargetContext().getCacheDir(), "branded-recording.mp4");
    try {
      try (InputStream input =
              instrumentation.getContext().getAssets().open("recording-one-second.mp4");
          FileOutputStream output = new FileOutputStream(source)) {
        input.transferTo(output);
      }
      long duration =
          VideoBranding.apply(instrumentation.getTargetContext(), source, -1, true);
      assertTrue(duration > 0);
      assertTrue(RtspRecorder.validate(source, -1, true) > 0);
      try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(source)) {
        grabber.start();
        assertTrue(grabber.getMetadata("comment").contains("DinkVision"));
      }
      long bytes = source.length();
      assertEquals(
          "Applying branding twice must keep the existing valid file",
          duration,
          VideoBranding.apply(instrumentation.getTargetContext(), source, -1, true));
      assertEquals(bytes, source.length());
    } finally {
      source.delete();
    }
  }

  @Test
  public void markIsPlacedAtTheDisplayedBottomRight() throws Exception {
    try (Frame frame = new Frame(100, 60, Frame.DEPTH_UBYTE, 3)) {
      int[] red = {0xffff0000, 0xffff0000, 0xffff0000, 0xffff0000};
      VideoBranding.blend(frame, red, 2, 2, 0);
      ByteBuffer pixels = ((ByteBuffer) frame.image[0]).duplicate();
      int offset = (60 - 12 - 2) * frame.imageStride + (100 - 12 - 2) * 3;
      assertTrue((pixels.get(offset + 2) & 0xff) > 200);
      assertEquals(0, pixels.get(0));
    }
  }
}
