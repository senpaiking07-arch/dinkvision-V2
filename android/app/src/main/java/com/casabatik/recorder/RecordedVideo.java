package com.casabatik.recorder;

import static org.bytedeco.ffmpeg.global.avcodec.av_packet_unref;
import static org.bytedeco.ffmpeg.global.avutil.AVMEDIA_TYPE_AUDIO;
import static org.bytedeco.ffmpeg.global.avutil.AVMEDIA_TYPE_VIDEO;
import static org.bytedeco.ffmpeg.global.avutil.AV_NOPTS_VALUE;
import static org.bytedeco.ffmpeg.global.avutil.av_get_time_base_q;
import static org.bytedeco.ffmpeg.global.avutil.av_rescale_q;

import java.io.File;
import org.bytedeco.ffmpeg.avcodec.AVPacket;
import org.bytedeco.ffmpeg.avformat.AVFormatContext;
import org.bytedeco.ffmpeg.avformat.AVStream;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.bytedeco.javacv.Frame;

/** Validates saved USB/built-in camera video before branding or upload. */
final class RecordedVideo {
  private RecordedVideo() {}

  static void validate(File file) throws Exception {
    validate(file, -1, false);
  }

  static void validate(File file, long expectedMillis) throws Exception {
    validate(file, expectedMillis, false);
  }

  private static long streamDurationMicros(FFmpegFrameGrabber grabber, int mediaType) {
    AVFormatContext context = grabber.getFormatContext();
    long longest = 0;
    if (context == null) return longest;
    for (int index = 0; index < context.nb_streams(); index++) {
      AVStream stream = context.streams(index);
      if (stream == null
          || stream.codecpar() == null
          || stream.codecpar().codec_type() != mediaType
          || stream.duration() <= 0
          || stream.duration() == AV_NOPTS_VALUE)
        continue;
      double seconds =
          stream.duration()
              * (double) stream.time_base().num()
              / (double) stream.time_base().den();
      if (Double.isFinite(seconds) && seconds > 0)
        longest = Math.max(longest, Math.round(seconds * 1_000_000d));
    }
    return longest;
  }

  static long audioDurationMillis(File file) throws Exception {
    try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(file)) {
      grabber.start();
      return Math.round(streamDurationMicros(grabber, AVMEDIA_TYPE_AUDIO) / 1_000d);
    }
  }

  static long validate(File file, long expectedMillis, boolean expectAudio) throws Exception {
    if (!file.isFile() || file.length() < 1024)
      throw new Exception("No recoverable video was saved.");
    long validatedDurationMicros;
    try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(file)) {
      grabber.start();
      long durationMicros = grabber.getLengthInTime();
      long videoMicros = streamDurationMicros(grabber, AVMEDIA_TYPE_VIDEO);
      long audioMicros = streamDurationMicros(grabber, AVMEDIA_TYPE_AUDIO);
      validatedDurationMicros = videoMicros > 0 ? videoMicros : durationMicros;
      Frame frame;
      int count = 0;
      while ((frame = grabber.grabImage()) != null && count < 2) count++;
      if (count == 0) throw new Exception("Saved video cannot be read.");
      if (expectAudio && (grabber.getAudioChannels() < 1 || audioMicros <= 0))
        throw new Exception(
            "Saved video has no complete audio track. It was kept locally and was not uploaded.");
      if (expectedMillis > 0) {
        long expectedMicros = expectedMillis * 1_000L;
        long savedVideoMicros = videoMicros > 0 ? videoMicros : durationMicros;
        RecordingAccuracy.duration(savedVideoMicros, expectedMicros, "Video");
        if (expectAudio) RecordingAccuracy.duration(audioMicros, expectedMicros, "Audio");
      }
      if (expectAudio)
        RecordingAccuracy.duration(
            audioMicros,
            videoMicros > 0 ? videoMicros : durationMicros,
            "Audio/video");
    }
    validatePackets(file, expectedMillis, expectAudio);
    return Math.round(validatedDurationMicros / 1_000d);
  }

  private static void validatePackets(File file, long expectedMillis, boolean expectAudio)
      throws Exception {
    try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(file)) {
      grabber.start();
      AVFormatContext context = grabber.getFormatContext();
      long[] first = new long[context.nb_streams()];
      long[] last = new long[first.length];
      long[] end = new long[first.length];
      java.util.Arrays.fill(first, Long.MAX_VALUE);
      java.util.Arrays.fill(last, Long.MIN_VALUE);
      AVPacket packet;
      while ((packet = grabber.grabPacket()) != null) {
        try {
          int index = packet.stream_index();
          AVStream stream = context.streams(index);
          int kind = stream.codecpar().codec_type();
          if (kind != AVMEDIA_TYPE_VIDEO && kind != AVMEDIA_TYPE_AUDIO) continue;
          if (packet.pts() == AV_NOPTS_VALUE || packet.dts() == AV_NOPTS_VALUE)
            throw new RecordingAccuracy.Failure("Saved recording has missing timestamps.");
          long dts = av_rescale_q(packet.dts(), stream.time_base(), av_get_time_base_q());
          long pts = av_rescale_q(packet.pts(), stream.time_base(), av_get_time_base_q());
          long duration =
              av_rescale_q(packet.duration(), stream.time_base(), av_get_time_base_q());
          if (duration > RecordingAccuracy.MAX_GAP_US
              || (last[index] != Long.MIN_VALUE
                  && (dts <= last[index] || dts - last[index] > RecordingAccuracy.MAX_GAP_US)))
            throw new RecordingAccuracy.Failure(
                "Saved recording contains a clock reset or a gap exceeding 3 seconds.");
          first[index] = Math.min(first[index], pts);
          last[index] = dts;
          end[index] = Math.max(end[index], pts + duration);
        } finally {
          av_packet_unref(packet);
        }
      }
      long videoStart = Long.MAX_VALUE;
      long audioStart = Long.MAX_VALUE;
      long videoDuration = 0;
      long audioDuration = 0;
      for (int index = 0; index < first.length; index++) {
        if (first[index] == Long.MAX_VALUE) continue;
        int kind = context.streams(index).codecpar().codec_type();
        if (kind == AVMEDIA_TYPE_VIDEO) {
          videoStart = first[index];
          videoDuration = end[index] - first[index];
        }
        if (kind == AVMEDIA_TYPE_AUDIO) {
          audioStart = first[index];
          audioDuration = end[index] - first[index];
        }
      }
      RecordingAccuracy.duration(
          videoDuration, expectedMillis > 0 ? expectedMillis * 1_000 : -1, "Video packets");
      if (expectAudio || audioStart != Long.MAX_VALUE) {
        RecordingAccuracy.duration(audioDuration, videoDuration, "Audio/video packets");
        if (audioStart == Long.MAX_VALUE || Math.abs(audioStart - videoStart) > 1_500_000)
          throw new RecordingAccuracy.Failure(
              "Saved audio and video do not start together.");
      }
      android.util.Log.i(
          "WPCRecording",
          "validated videoUs=" + videoDuration + " audioUs=" + audioDuration);
    }
  }
}
