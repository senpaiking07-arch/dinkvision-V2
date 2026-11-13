package com.casabatik.recorder;

import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.util.Log;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

/** Opt-in timing using a disposable, unsealed test MP4 staged in the emulator's cache. */
public class MediaValidationTimingTest {
  @Test public void measureOriginalStopPath() throws Exception {
    measure((file) -> {
      long precheck = millis(() -> RecordedVideo.validate(file, -1, false));
      long seal = millis(() -> LiveLogoEvidence.mark(file));
      long rehash = millis(() -> LiveLogoEvidence.requireVerified(file));
      long validate = millis(() -> RecordedVideo.validate(file, -1, true));
      return "originalStopMs=" + (precheck + seal + rehash + validate)
          + " precheckMs=" + precheck + " sealMs=" + seal
          + " digestMs=" + rehash + " scanMs=" + validate;
    });
  }

  @Test public void measureDeferredValidation() throws Exception {
    measure(file -> {
      LiveRecordingValidation worker = new LiveRecordingValidation();
      long seal = millis(() -> {
        LiveLogoEvidence.mark(file);
        assertTrue(LiveLogoEvidence.hasSeal(file));
      });
      long initial = millis(() -> worker.validate(file, -1, true));
      long retry = millis(() -> worker.validate(file, -1, true));
      return "deferredStopMs=" + seal + " workerValidationMs=" + initial + " retryDigestMs=" + retry;
    });
  }

  private interface Sample { String run(File file) throws Exception; }
  private interface Step { void run() throws Exception; }

  private static long millis(Step step) throws Exception {
    long start = System.nanoTime();
    step.run();
    return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
  }

  private static void measure(Sample sample) throws Exception {
    assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("measureMediaValidation")));
    var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    assumeTrue(context.getPackageName().endsWith(".dev"));
    File source = new File(context.getCacheDir(), "media-validation-input.mp4");
    assertTrue("Stage a disposable A/V fixture first", source.isFile());
    File copy = File.createTempFile("measure-validation-", ".mp4", context.getCacheDir());
    try {
      for (int trial = 1; trial <= 3; trial++) {
        Files.copy(source.toPath(), copy.toPath(), StandardCopyOption.REPLACE_EXISTING);
        Log.i("DVValidationTiming", "trial=" + trial + " bytes=" + source.length() + " " + sample.run(copy));
      }
    } finally {
      copy.delete();
    }
  }
}
