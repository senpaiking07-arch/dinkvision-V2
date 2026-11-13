package com.casabatik.recorder;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in device diagnostic. Operates on a cache copy, never the queued original. */
@RunWith(AndroidJUnit4.class)
public class HonorBrandingDiagnosticTest {
  @Test public void processCopyOfSelectedRecording() throws Exception {
    String id = InstrumentationRegistry.getArguments().getString("sourceId", "");
    org.junit.Assume.assumeTrue(id.matches("[0-9a-f-]{36}"));
    var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    var wake = context.getSystemService(android.os.PowerManager.class)
        .newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "DinkVision:BrandingDiagnostic");
    wake.acquire(30 * 60_000L);
    InstrumentationRegistry.getInstrumentation().startActivitySync(
        new android.content.Intent(context, MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
    context.startForegroundService(new android.content.Intent(context, TransferService.class)
        );
    File original = new File(context.getFilesDir(), "recordings/" + id + ".mp4");
    File copy = new File(context.getCacheDir(), "honor-diagnostic-" + id + ".mp4");
    File report = new File(context.getCacheDir(), "honor-branding-diagnostic.txt");
    Files.copy(original.toPath(), copy.toPath(), StandardCopyOption.REPLACE_EXISTING);
    long originalBytes = original.length();
    try (PrintWriter log = new PrintWriter(new FileWriter(report), true)) {
      try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(copy)) {
        grabber.start();
        log.println("width=" + grabber.getImageWidth() + " height=" + grabber.getImageHeight()
            + " fps=" + grabber.getFrameRate() + " durationUs=" + grabber.getLengthInTime()
            + " bytes=" + originalBytes + " freeBytes=" + copy.getUsableSpace());
      }
      long started = android.os.SystemClock.elapsedRealtime();
      try {
        long duration = VideoBranding.apply(context, copy, -1, true, () -> false,
            percent -> log.println("elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started) + " percent=" + percent));
        log.println("SUCCESS durationMs=" + duration + " elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started));
      } catch (Exception failure) {
        log.println("FAILURE elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started));
        failure.printStackTrace(log);
        throw failure;
      } finally {
        org.junit.Assert.assertEquals("Original must remain untouched", originalBytes, original.length());
      }
    } finally {
      if (wake.isHeld()) wake.release();
      context.stopService(new android.content.Intent(context, TransferService.class));
    }
  }
}
