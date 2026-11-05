package com.casabatik.recorder;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import java.util.List;

/** Selects genuine camera/encoder modes, with smoothness ahead of pixel count. */
final class RecordingProfile {
  interface EncoderSupport { boolean supports(int width, int height, int fps); }
  final int width, height, fps, format;
  RecordingProfile(int width, int height, int fps, int format) {
    this.width = width; this.height = height; this.fps = fps; this.format = format;
  }
  static int bitrate(int width, int height, int fps) {
    // Scale compression budget with both pixels and frame rate, bounded for mobile hardware.
    return (int) Math.max(4_000_000L, Math.min(32_000_000L,
        (long) width * height * fps / 8));
  }
  int bitrate() { return bitrate(width, height, fps); }
  String key() { return width + "x" + height + "@" + fps; }
  String label() { return width + " × " + height + " · " + fps + " fps target"; }
  static boolean sustains60(double measuredFps) { return Double.isFinite(measuredFps) && measuredFps >= 57; }
  static boolean sustains(int target, double measured) {
    return target == 60 ? sustains60(measured) : Double.isFinite(measured) && measured >= target * .9;
  }
  static int deliveredTier(double rate) {
    return rate >= 57 ? 60 : rate >= 27 ? 30 : rate >= 22.5 ? 25 : (int)Math.floor(rate / 5) * 5;
  }
  static org.json.JSONArray describe(List<RecordingProfile> candidates) throws Exception {
    java.util.Map<String, RecordingProfile> unique = new java.util.LinkedHashMap<>();
    for (RecordingProfile p : candidates) if(p.width>0&&p.height>0&&p.fps>0&&p.fps<=120) {
      RecordingProfile old=unique.get(p.key());
      if(old==null||p.format>old.format)unique.put(p.key(),p);
    }
    java.util.List<RecordingProfile> sorted=new java.util.ArrayList<>(unique.values());
    sorted.sort(java.util.Comparator.comparingLong((RecordingProfile p)->(long)p.width*p.height).reversed()
        .thenComparing(java.util.Comparator.comparingInt((RecordingProfile p)->p.fps).reversed()));
    org.json.JSONArray result=new org.json.JSONArray();
    for(RecordingProfile p:sorted){
      if(result.length()>=128)break;
      boolean supported=p.fps<=60&&p.tier()>=0&&encoderSupports(p.width,p.height,p.fps);
      result.put(new org.json.JSONObject().put("key",p.key()).put("width",p.width).put("height",p.height)
          .put("fps",p.fps).put("supported",supported));
    }
    return result;
  }

  static MediaFormat format(int width, int height, int fps) {
    MediaFormat value = MediaFormat.createVideoFormat("video/avc", width, height);
    value.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    value.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
    value.setInteger(MediaFormat.KEY_BIT_RATE, bitrate(width, height, fps));
    value.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
    return value;
  }
  static boolean encoderSupports(int width, int height, int fps) {
    try {
      return new MediaCodecList(MediaCodecList.REGULAR_CODECS)
          .findEncoderForFormat(format(width, height, fps)) != null;
    } catch (Exception unsupported) { return false; }
  }
  private int tier() {
    if (fps == 60) return 3;
    if (Math.max(width, height) > 1920 || Math.min(width, height) > 1080) return -1;
    return fps == 30 ? 2 : 1;
  }
  static RecordingProfile choose(List<RecordingProfile> candidates, EncoderSupport encoder) throws Exception {
    return choose(candidates, encoder, Long.MAX_VALUE, Long.MAX_VALUE);
  }
  static RecordingProfile choose(List<RecordingProfile> candidates, EncoderSupport encoder, long max60Pixels) throws Exception {
    return choose(candidates, encoder, max60Pixels, Long.MAX_VALUE);
  }
  static RecordingProfile choose(List<RecordingProfile> candidates, EncoderSupport encoder, long max60Pixels, long maxFallbackPixels) throws Exception {
    return choose(candidates, encoder, max60Pixels, maxFallbackPixels, "");
  }
  static RecordingProfile choose(List<RecordingProfile> candidates, EncoderSupport encoder, long max60Pixels, long maxFallbackPixels, String preferred) throws Exception {
    RecordingProfile best = null;
    for (RecordingProfile value : candidates) {
      if (value == null || value.width < 1 || value.height < 1 || value.fps < 1 || value.fps > 60
          || (!preferred.isEmpty() && !preferred.equals(value.key()))
          || value.tier() < 0 || (value.fps == 60 && (long)value.width * value.height > max60Pixels)
          || (value.fps != 60 && (long)value.width * value.height > maxFallbackPixels)
          || !encoder.supports(value.width, value.height, value.fps)) continue;
      if (best == null || value.tier() > best.tier()
          || (value.tier() == best.tier() && value.tier() == 1 && value.fps > best.fps)
          || (value.tier() == best.tier() && (value.tier() > 1 || value.fps == best.fps)
              && ((long) value.width * value.height > (long) best.width * best.height
                  || ((long) value.width * value.height == (long) best.width * best.height
                      && value.format > best.format)))) best = value;
    }
    if (best == null) throw new Exception("No compatible recording mode. Use a camera with 60 fps, or a 1080p / lower-resolution fallback supported by this device.");
    return best;
  }
}
