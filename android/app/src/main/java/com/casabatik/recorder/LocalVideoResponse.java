package com.casabatik.recorder;

import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.Collections;

/** Authorizes private playback; WebView applies HTTP Range to the full input stream itself. */
final class LocalVideoResponse {
  private LocalVideoResponse() {}
  static WebResourceResponse open(Engine engine, String name, String range) {
    try {
      if (!name.endsWith(".mp4")) throw new IOException("Unknown video.");
      String session = name.substring(0, name.length() - 4);
      if (engine.isPreviewInvalid(session)) throw new IOException("Video needs inspection.");
      if (engine.isPreviewPending(session))
        return new WebResourceResponse("text/plain", "UTF-8", 503, "Processing",
            Collections.singletonMap("Retry-After", "5"), new ByteArrayInputStream(new byte[0]));
      var file = engine.localPlaybackFile(session);
      long total = file.length(), start = 0, end = total - 1;
      boolean partial = range != null && !range.isEmpty();
      if (partial) {
        var match=java.util.regex.Pattern.compile("bytes=(\\d*)-(\\d*)").matcher(range);
        if (!match.matches() || (match.group(1).isEmpty() && match.group(2).isEmpty())) throw new IOException("Invalid range");
        if(match.group(1).isEmpty()) start=Math.max(0,total-Long.parseLong(match.group(2)));
        else {start=Long.parseLong(match.group(1));if(!match.group(2).isEmpty()) end=Math.min(end,Long.parseLong(match.group(2)));}
        if(start>end || start>=total) return new WebResourceResponse("text/plain","UTF-8",416,"Range Not Satisfiable",Collections.singletonMap("Content-Range","bytes */"+total),new ByteArrayInputStream(new byte[0]));
      }
      var headers=new java.util.HashMap<String,String>();
      headers.put("Cache-Control","no-store");headers.put("Accept-Ranges","bytes");headers.put("Content-Length",Long.toString(end-start+1));
      if(partial) headers.put("Content-Range","bytes "+start+"-"+end+"/"+total);
      // Chromium seeks this stream using the request's Range header. Slicing it
      // here applies the offset twice and breaks MP4 metadata reads near EOF.
      // Match WebViewAssetLoader's full-stream contract.
      return new WebResourceResponse("video/mp4", null, partial ? 206 : 200, partial ? "Partial Content" : "OK",
          headers, new FileInputStream(file));
    } catch (Exception unavailable) {
      return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
          Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }
  }
}
