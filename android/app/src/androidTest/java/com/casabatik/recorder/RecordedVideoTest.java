package com.casabatik.recorder;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RecordedVideoTest {
  @Test
  public void rejectsVideoWhoseAudioStopsBeforeThePicture() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    File source = new File(instrumentation.getTargetContext().getCacheDir(),
        "recording-truncated-audio.mp4");
    try {
      try (InputStream input = instrumentation.getContext().getAssets().open(
              "recording-truncated-audio.mp4");
          FileOutputStream output = new FileOutputStream(source)) {
        input.transferTo(output);
      }
      RecordingAccuracy.Failure failure = assertThrows(RecordingAccuracy.Failure.class,
          () -> RecordedVideo.validate(source, 3_000L, true));
      assertTrue(failure.getMessage().contains("do not end together"));
    } finally {
      source.delete();
    }
  }
}
