package com.casabatik.recorder;

import static org.bytedeco.ffmpeg.global.avcodec.AV_CODEC_ID_AAC;
import static org.bytedeco.ffmpeg.global.avutil.AV_PIX_FMT_BGR24;
import static org.bytedeco.ffmpeg.global.avutil.AV_PIX_FMT_YUV420P;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.util.Log;
import java.io.File;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.bytedeco.javacv.FFmpegFrameRecorder;
import org.bytedeco.javacv.Frame;

/** Adds the public Dink Vision mark while preserving the original until validation succeeds. */
final class VideoBranding {
  private static final String ASSET = "dink-vision-logo.png";
  private static final String BRAND = "DinkVision";
  private static final String TEMP_SUFFIX = ".dinkvision.tmp";
  private static final String BACKUP_SUFFIX = ".dinkvision.backup";

  static final class ProcessingPausedException extends Exception {
    ProcessingPausedException() {
      super("Logo processing paused while another recording starts.");
    }
  }

  static void recoverInterruptedSwaps(File directory) {
    File[] backups = directory.listFiles((parent, name) -> name.endsWith(BACKUP_SUFFIX));
    if (backups == null) return;
    for (File backup : backups) {
      String name = backup.getName().substring(0, backup.getName().length() - BACKUP_SUFFIX.length());
      File recording = new File(directory, name);
      // A zero-byte destination can be left by an interrupted swap or write.
      // Keep nonempty originals and backups available for inspection.
      if (backup.isFile() && backup.length() > 0
          && (!recording.exists() || (recording.isFile() && recording.length() == 0))) {
        try {
          Files.move(backup.toPath(), recording.toPath(), StandardCopyOption.REPLACE_EXISTING);
          Log.w("DinkVisionVideo", "Restored recording after an interrupted logo save: " + name);
        } catch (Exception e) {
          Log.e("DinkVisionVideo", "Could not restore " + name, e);
        }
      }
    }
  }

  static long apply(Context context, File source, long expectedMillis, boolean expectAudio)
      throws Exception {
    return apply(context, source, expectedMillis, expectAudio, () -> false, -1);
  }

  static long apply(
      Context context,
      File source,
      long expectedMillis,
      boolean expectAudio,
      BooleanSupplier pauseRequested)
      throws Exception {
    return apply(context, source, expectedMillis, expectAudio, pauseRequested, -1);
  }

  static long apply(Context context, File source, long expectedMillis, boolean expectAudio,
      BooleanSupplier pauseRequested, IntConsumer progress) throws Exception {
    return apply(context, source, expectedMillis, expectAudio, pauseRequested, -1, progress);
  }

  static long applyPreview(
      Context context,
      File source,
      long expectedMillis,
      boolean expectAudio,
      long previewMillis)
      throws Exception {
    if (previewMillis < 1) throw new IllegalArgumentException("Preview duration must be positive.");
    return apply(context, source, expectedMillis, expectAudio, () -> false, previewMillis);
  }

  private static long apply(
      Context context,
      File source,
      long expectedMillis,
      boolean expectAudio,
      BooleanSupplier pauseRequested,
      long previewMillis)
      throws Exception {
    return apply(context, source, expectedMillis, expectAudio, pauseRequested, previewMillis, ignored -> {});
  }

  private static long apply(Context context, File source, long expectedMillis, boolean expectAudio,
      BooleanSupplier pauseRequested, long previewMillis, IntConsumer progress) throws Exception {
    progress.accept(0);
    long sourceMillis = RecordedVideo.validate(source, expectedMillis, expectAudio);
    if (previewMillis > 0 && sourceMillis < previewMillis)
      throw new RecordingAccuracy.Failure(
          "The camera test did not contain the full three seconds. Reconnect the camera and retry.");
    if (pauseRequested.getAsBoolean()) throw new ProcessingPausedException();
    File temporary = new File(source.getParentFile(), source.getName() + TEMP_SUFFIX);
    File backup = new File(source.getParentFile(), source.getName() + BACKUP_SUFFIX);
    if (isBranded(source)) {
      temporary.delete();
      backup.delete();
      progress.accept(100);
      return sourceMillis;
    }
    if (temporary.exists() && !temporary.delete())
      throw new Exception("A previous logo save is still being cleaned up. Please retry.");
    if (source.getParentFile().getUsableSpace() < source.length() + 50_000_000L)
      throw new Exception("Not enough tablet storage to finish the Dink Vision video.");

    try {
      render(
          context,
          source,
          temporary,
          sourceMillis,
          expectAudio,
          pauseRequested,
          previewMillis,
          progress);
      progress.accept(99);
      long brandedMillis =
          RecordedVideo.validate(
              temporary, previewMillis > 0 ? -1 : expectedMillis, expectAudio);
      if (previewMillis > 0) {
        long brandedAudioMillis = expectAudio ? RecordedVideo.audioDurationMillis(temporary) : -1;
        Log.i(
            "DinkVisionCameraTest",
            "sourceDurationMs=" + sourceMillis + " brandedDurationMs=" + brandedMillis
                + " brandedAudioMs=" + brandedAudioMillis
                + " requiredDurationMs=" + previewMillis);
        requirePreviewDuration(brandedMillis, previewMillis);
        if (expectAudio) requirePreviewDuration(brandedAudioMillis, previewMillis);
      }
      if (pauseRequested.getAsBoolean()) throw new ProcessingPausedException();
      replaceValidated(source, temporary, backup);
      long confirmedMillis =
          RecordedVideo.validate(source, previewMillis > 0 ? -1 : expectedMillis, expectAudio);
      if (previewMillis > 0) requirePreviewDuration(confirmedMillis, previewMillis);
      if (previewMillis > 0 && expectAudio)
        requirePreviewDuration(RecordedVideo.audioDurationMillis(source), previewMillis);
      if (!isBranded(source)) throw new Exception("The saved video is missing its Dink Vision logo marker.");
      backup.delete();
      Log.i(
          "DinkVisionVideo",
          "Logo saved durationMs=" + confirmedMillis + " bytes=" + source.length());
      progress.accept(100);
      return confirmedMillis;
    } catch (Exception failure) {
      temporary.delete();
      if (!source.exists() && backup.exists())
        try {
          Files.move(backup.toPath(), source.toPath(), StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception restoreFailure) {
          failure.addSuppressed(restoreFailure);
        }
      if (failure instanceof ProcessingPausedException
          || failure instanceof RecordingAccuracy.Failure) throw failure;
      Log.e("DinkVisionVideo", "Logo processing failed; the source video was preserved", failure);
      diagnostic(context, "failure file=" + source.getName() + " cause=" + failure.getClass().getSimpleName() + ": " + failure.getMessage());
      throw new Exception(
          "The Dink Vision logo could not be added. The original video was preserved. Please retry.",
          failure);
    }
  }

  private static boolean isBranded(File source) {
    if (LiveLogoEvidence.verified(source)) return true;
    try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(source)) {
      grabber.start();
      String comment = grabber.getMetadata("comment");
      return comment != null && comment.contains(BRAND);
    } catch (Exception ignored) {
      return false;
    }
  }

  private static void replaceValidated(File source, File temporary, File backup) throws Exception {
    try {
      Files.move(
          temporary.toPath(),
          source.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING);
      return;
    } catch (AtomicMoveNotSupportedException ignored) {
      // Some Android filesystems do not expose atomic replacement. The backup
      // path below is recoverable by recoverInterruptedSwaps after a restart.
    }
    if (backup.exists() && !backup.delete())
      throw new Exception("A previous safe video backup could not be released.");
    Files.move(source.toPath(), backup.toPath(), StandardCopyOption.REPLACE_EXISTING);
    try {
      Files.move(temporary.toPath(), source.toPath(), StandardCopyOption.REPLACE_EXISTING);
    } catch (Exception failure) {
      Files.move(backup.toPath(), source.toPath(), StandardCopyOption.REPLACE_EXISTING);
      throw failure;
    }
  }

  private static void render(
      Context context,
      File source,
      File output,
      long sourceMillis,
      boolean expectAudio,
      BooleanSupplier pauseRequested,
      long previewMillis,
      IntConsumer progress)
      throws Exception {
    Bitmap original = null, scaled = null, mark = null;
    long startedNanos = System.nanoTime(), lastDiagnosticNanos = startedNanos;
    BrandingProgress health = new BrandingProgress(startedNanos);
    long encodedFrames = 0;
    try (InputStream stream = context.getAssets().open(ASSET);
        FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(source)) {
      original = BitmapFactory.decodeStream(stream);
      if (original == null) throw new Exception("Dink Vision logo image is unreadable.");
      grabber.setPixelFormat(AV_PIX_FMT_BGR24);
      grabber.start();
      int width = grabber.getImageWidth(), height = grabber.getImageHeight();
      if (width < 1 || height < 1) throw new Exception("The saved video has no picture.");
      int rotation = normalizeRotation(grabber.getDisplayRotation());
      int displayWidth = rotation % 180 == 0 ? width : height;
      int displayHeight = rotation % 180 == 0 ? height : width;
      double scale =
          Math.min(
              displayWidth * 0.20 / original.getWidth(),
              displayHeight * 0.16 / original.getHeight());
      int markWidth = Math.max(1, (int) Math.round(original.getWidth() * scale));
      int markHeight = Math.max(1, (int) Math.round(original.getHeight() * scale));
      scaled = Bitmap.createScaledBitmap(original, markWidth, markHeight, true);
      mark = orientMark(scaled, rotation);
      int[] pixels = new int[mark.getWidth() * mark.getHeight()];
      mark.getPixels(pixels, 0, mark.getWidth(), 0, 0, mark.getWidth(), mark.getHeight());
      int channels = expectAudio ? Math.min(2, grabber.getAudioChannels()) : 0;
      int sampleRate = channels > 0 ? grabber.getSampleRate() : 0;
      if (channels > 0 && sampleRate < 1) throw new Exception("The saved audio sample rate is invalid.");
      double fps = grabber.getFrameRate();
      if (!Double.isFinite(fps) || fps <= 0 || fps > 120)
        throw new Exception("The saved video frame rate is invalid.");
      diagnostic(context, "start file=" + source.getName() + " width=" + width + " height=" + height
          + " sourceFps=" + fps + " durationMs=" + sourceMillis + " freeBytes=" + source.getUsableSpace());

      try (FFmpegFrameRecorder recorder = new FFmpegFrameRecorder(output, width, height, channels)) {
        recorder.setFormat("mp4");
        recorder.setVideoCodecName("libopenh264");
        int bitrate = grabber.getVideoBitrate();
        recorder.setVideoBitrate(bitrate > 0 ? Math.max(2_000_000, Math.min(32_000_000, bitrate)) : 4_000_000);
        recorder.setFrameRate(fps);
        recorder.setGopSize(Math.max(1, (int) Math.round(fps)));
        recorder.setPixelFormat(AV_PIX_FMT_YUV420P);
        recorder.setOption("movflags", "frag_keyframe+hybrid_fragmented");
        recorder.setMetadata("comment", BRAND);
        recorder.setDisplayRotation(grabber.getDisplayRotation());
        if (channels > 0) {
          recorder.setAudioCodec(AV_CODEC_ID_AAC);
          recorder.setSampleRate(sampleRate);
          recorder.setAudioBitrate(128_000);
        }
        recorder.start();
        long sourceStart = Long.MIN_VALUE, lastVideo = Long.MIN_VALUE;
        long audioSampleFrames = 0;
        int outputFrameNumber = -1;
        int reportedPercent = -1;
        boolean wroteVideo = false, wroteAudio = false;
        boolean previewVideoComplete = false, previewAudioComplete = channels == 0;
        Frame frame;
        while ((frame = grabber.grabFrame(channels > 0, true, true, false)) != null) {
          if (pauseRequested.getAsBoolean()) throw new ProcessingPausedException();
          if (output.getParentFile().getUsableSpace() < 50_000_000L)
            throw new Exception("Tablet storage is nearly full. The original video was preserved.");
          if (frame.image != null) {
            if (sourceStart == Long.MIN_VALUE) sourceStart = frame.timestamp;
            if (previewVideoComplete) continue;
            if (frame.timestamp <= lastVideo)
              throw new Exception("The saved video timestamps do not advance.");
            lastVideo = frame.timestamp;
            int frameNumber = nextFrameNumber(frame.timestamp, sourceStart, fps, outputFrameNumber);
            // Quantization can place several jittery camera frames in one output slot.
            // Skip duplicates; advancing their clock would stretch the picture beyond audio.
            if (frameNumber <= outputFrameNumber) {
              // Consuming a valid, intentionally dropped quantized frame is progress too.
              health.advanced(frame.timestamp - sourceStart, System.nanoTime());
              continue;
            }
            blend(frame, pixels, mark.getWidth(), mark.getHeight(), rotation);
            outputFrameNumber = frameNumber;
            recorder.setFrameNumber(outputFrameNumber);
            recorder.record(frame);
            encodedFrames++;
            health.advanced(frame.timestamp - sourceStart, System.nanoTime());
            wroteVideo = true;
            int percent = processingPercent(frame.timestamp - sourceStart, previewMillis > 0 ? previewMillis : sourceMillis);
            if (percent != reportedPercent) { reportedPercent = percent; progress.accept(percent); }
            if (previewMillis > 0
                && frame.timestamp - sourceStart >= previewMillis * 1_000L)
              previewVideoComplete = true;
          } else if (frame.samples != null && channels > 0) {
            // UVC files can decode audio before the first video frame. Keep it: dropping those
            // samples makes the branded audio end early even when the source tracks align.
            if (!previewAudioComplete) {
              int frameChannels = frame.audioChannels > 0 ? frame.audioChannels : channels;
              int sampleFrames = frame.samples[0].remaining();
              if (frame.samples.length == 1) sampleFrames /= frameChannels;
              audioSampleFrames += sampleFrames;
              recorder.record(frame);
              health.advancedAudio(audioSampleFrames * 1_000_000L / sampleRate, System.nanoTime());
              wroteAudio = true;
              if (previewMillis > 0
                  && audioSampleFrames * 1_000L >= previewMillis * sampleRate)
                previewAudioComplete = true;
            }
          }
          long nowNanos = System.nanoTime();
          health.check(nowNanos);
          if (nowNanos - lastDiagnosticNanos >= 10_000_000_000L) {
            double elapsedSeconds = (nowNanos - startedNanos) / 1_000_000_000.0;
            diagnostic(context, "progress file=" + source.getName() + " percent=" + reportedPercent
                + " elapsedSeconds=" + elapsedSeconds + " encodedFrames=" + encodedFrames
                + " processingFps=" + encodedFrames / elapsedSeconds);
            lastDiagnosticNanos = nowNanos;
          }
          if (previewMillis > 0 && previewVideoComplete && previewAudioComplete) break;
        }
        recorder.stop();
        if (!wroteVideo) throw new Exception("No video picture was available for the logo.");
        if (channels > 0 && !wroteAudio) throw new Exception("No audio was available while saving the logo.");
        if (previewMillis > 0 && (!previewVideoComplete || !previewAudioComplete))
          throw new RecordingAccuracy.Failure(
              "The camera test did not contain the full three seconds. Reconnect the camera and retry.");
      }
    } finally {
      if (mark != null && mark != scaled) mark.recycle();
      if (scaled != null) scaled.recycle();
      if (original != null) original.recycle();
    }
  }

  // HONOR firmware can hide Logcat output. Keep bounded, credential-free media
  // diagnostics in app-private storage as well; never include API requests.
  private static synchronized void diagnostic(Context context, String detail) {
    Log.i("DinkVisionVideo", detail);
    File log = new File(context.getFilesDir(), "branding-diagnostics.log");
    try (java.io.FileWriter writer = new java.io.FileWriter(log, log.length() < 262_144L)) {
      writer.write(System.currentTimeMillis() + " " + detail + "\n");
    } catch (java.io.IOException ignored) { }
  }

  static void requirePreviewDuration(long actualMillis, long expectedMillis)
      throws RecordingAccuracy.Failure {
    if (actualMillis < expectedMillis - 250L || actualMillis > expectedMillis + 500L)
      throw new RecordingAccuracy.Failure(
          "The saved camera test duration is incomplete. Reconnect the camera and retry.");
  }

  // Reserve completion for output validation and the safe replacement, not EOF alone.
  static int processingPercent(long processedUs, long durationMillis) {
    if (durationMillis < 1) throw new IllegalArgumentException("Video duration must be positive.");
    return (int) Math.max(0, Math.min(98, processedUs * 98.0 / (durationMillis * 1000.0)));
  }

  static int nextFrameNumber(
      long sourceTimestampUs, long sourceStartUs, double frameRate, int previousFrameNumber)
      throws Exception {
    if (!Double.isFinite(frameRate) || frameRate <= 0)
      throw new Exception("The saved video frame rate is invalid.");
    long relativeTimestampUs = Math.max(0L, sourceTimestampUs - sourceStartUs);
    long timestampFrame = Math.round(relativeTimestampUs * frameRate / 1_000_000.0);
    long nextFrame = timestampFrame;
    if (nextFrame > Integer.MAX_VALUE)
      throw new Exception("The saved video is too long to finish safely.");
    return (int) nextFrame;
  }

  static Bitmap orientMark(Bitmap scaled, int rotation) {
    int normalized = normalizeRotation(rotation);
    if (normalized == 0) return scaled;
    Matrix matrix = new Matrix();
    // getDisplayRotation() reports the display transform counterclockwise.
    // Android Bitmap coordinates run downward, so using the same numeric
    // angle produces the inverse visual transform required before playback.
    matrix.postRotate(normalized);
    return Bitmap.createBitmap(
        scaled, 0, 0, scaled.getWidth(), scaled.getHeight(), matrix, true);
  }

  static void blend(Frame frame, int[] pixels, int logoWidth, int logoHeight, int rotation)
      throws Exception {
    if (frame.image == null || frame.image.length == 0 || !(frame.image[0] instanceof ByteBuffer))
      throw new Exception("The saved video picture format is unsupported.");
    ByteBuffer image = ((ByteBuffer) frame.image[0]).duplicate();
    int width = frame.imageWidth, height = frame.imageHeight;
    int margin = Math.max(12, Math.round(Math.min(width, height) * 0.02f));
    // Choose the raw-frame corner that becomes bottom-right after the player
    // applies the MP4 display rotation copied by the recorder.
    int left, top;
    switch (normalizeRotation(rotation)) {
      case 90 -> {
        left = margin;
        top = height - logoHeight - margin;
      }
      case 180 -> {
        left = margin;
        top = margin;
      }
      case 270 -> {
        left = width - logoWidth - margin;
        top = margin;
      }
      default -> {
        left = width - logoWidth - margin;
        top = height - logoHeight - margin;
      }
    }
    left = Math.max(0, Math.min(left, width - logoWidth));
    top = Math.max(0, Math.min(top, height - logoHeight));
    int base = image.position(), stride = frame.imageStride;
    for (int y = 0; y < logoHeight; y++) {
      for (int x = 0; x < logoWidth; x++) {
        int color = pixels[y * logoWidth + x];
        int alpha = Math.round(((color >>> 24) & 0xff) * 0.92f);
        if (alpha == 0) continue;
        int offset = base + (top + y) * stride + (left + x) * 3;
        int inverse = 255 - alpha;
        int blue = color & 0xff, green = (color >>> 8) & 0xff, red = (color >>> 16) & 0xff;
        image.put(offset, (byte) ((blue * alpha + (image.get(offset) & 0xff) * inverse) / 255));
        image.put(offset + 1, (byte) ((green * alpha + (image.get(offset + 1) & 0xff) * inverse) / 255));
        image.put(offset + 2, (byte) ((red * alpha + (image.get(offset + 2) & 0xff) * inverse) / 255));
      }
    }
  }

  private static int normalizeRotation(double degrees) {
    if (!Double.isFinite(degrees)) return 0;
    int rotation = ((int) Math.round(degrees / 90.0) * 90) % 360;
    return rotation < 0 ? rotation + 360 : rotation;
  }
}
