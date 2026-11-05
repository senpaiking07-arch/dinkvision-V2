package com.casabatik.recorder;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;

final class Api {
  static final String ORIGIN = BuildConfig.APP_ORIGIN;
  private final Vault vault;
  volatile Boolean serverReachable;

  interface Connections {
    HttpURLConnection open(URL url) throws Exception;
  }

  private final Connections connections;

  Api(Vault v) {
    this(v, url -> (HttpURLConnection) url.openConnection());
  }

  Api(Vault v, Connections connections) {
    vault = v;
    this.connections = connections;
  }

  synchronized JSONObject call(String path, JSONObject body) throws Exception {
    if (!path.startsWith("/api/")) throw new Exception("Invalid application request.");
    HttpURLConnection c;
    try { c = connections.open(new URL(ORIGIN + path)); }
    catch (IOException failure) { serverReachable = false; throw failure; }
    c.setConnectTimeout(15000);
    c.setReadTimeout(30000);
    c.setInstanceFollowRedirects(false);
    c.setRequestProperty("Accept", "application/json");
    c.setRequestProperty("Origin", ORIGIN);
    c.setRequestProperty("X-DinkVision-Client", "android");
    c.setRequestProperty("X-DinkVision-Version-Code", String.valueOf(BuildConfig.VERSION_CODE));
    JSONObject jar = vault.object("cookies");
    List<String> cookies = new ArrayList<>();
    for (Iterator<String> i = jar.keys(); i.hasNext(); ) {
      String n = i.next();
      cookies.add(n + "=" + jar.getString(n));
    }
    if (!cookies.isEmpty()) c.setRequestProperty("Cookie", String.join("; ", cookies));
    try {
      if (body != null) {
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream o = c.getOutputStream()) {
          o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
      }
      int status = c.getResponseCode();
      serverReachable = true;
      InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
      String text = in == null ? "" : read(in);
      JSONObject result;
      try {
        result = new JSONObject(text);
      } catch (Exception e) {
        throw new Exception("Hosted app unavailable. Check the deployment and try again.");
      }
      if (status == 426 && result.optJSONObject("release") != null)
        vault.put("android-release", AppUpdate.validate(result.getJSONObject("release")).toString());
      if (status < 200 || status >= 300)
        throw new Exception(result.optString("error", "Request failed. Please retry."));
      // Outages, redirects and invalid deployment responses must never alter
      // pairing. Only a confirmed enrollment response can replace that token.
      boolean enrollment = "/api/tablet/enroll".equals(path);
      boolean receivedCredential = false;
      boolean changed = false;
      for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet())
        if ("set-cookie".equalsIgnoreCase(h.getKey()))
          for (String line : h.getValue())
            for (HttpCookie cookie : HttpCookie.parse(line)) {
              if ("cb-kiosk".equals(cookie.getName())) {
                if (!enrollment || !Boolean.TRUE.equals(result.opt("ok")) || cookie.getMaxAge() == 0
                    || !cookie.getValue().matches("[A-Za-z0-9_-]{43}")) continue;
                receivedCredential = true;
              }
              if (cookie.getMaxAge() == 0) jar.remove(cookie.getName());
              else jar.put(cookie.getName(), cookie.getValue());
              changed = true;
            }
      if (enrollment && !receivedCredential)
        throw new Exception("Enrollment response did not contain a valid device credential. Check the registration with Admin.");
      if (changed) vault.put("cookies", jar.toString());
      return result;
    } catch (IOException failure) {
      serverReachable = false;
      throw failure;
    } finally {
      c.disconnect();
    }
  }

  JSONObject tablet(String action, JSONObject fields) throws Exception {
    return call("/api/tablet", fields.put("action", action));
  }

  static String read(InputStream in) throws IOException {
    try (in;
        ByteArrayOutputStream b = new ByteArrayOutputStream()) {
      byte[] chunk = new byte[8192];
      int n;
      while ((n = in.read(chunk)) != -1) {
        if (b.size() + n > 2_000_000) throw new IOException("Response too large.");
        b.write(chunk, 0, n);
      }
      return b.toString("UTF-8");
    }
  }

  UploadTransfer.Transport uploadTransport(String session, File file) {
    UUID.fromString(session);
    return new UploadTransfer.Transport() {
      private String address = "";

      public JSONObject action(String action) throws Exception {
        if (!Set.of("upload", "retry-upload", "restart-upload", "upload-status", "finish").contains(action))
          throw new Exception("Invalid upload action.");
        JSONObject result = tablet(action, new JSONObject().put("id", session).put("direct_upload", true));
        if (Set.of("upload", "retry-upload", "restart-upload").contains(action)) {
          address = "";
          if (!result.optBoolean("ready") && !result.optBoolean("queued")) {
            JSONObject grant = result.optJSONObject("directUpload");
            if (grant == null)
              throw new Exception("Direct upload is unavailable. Ask Admin to update the hosted app. Your video stays in Saved videos.");
            if (grant.getLong("bytes") != file.length() || !"video/mp4".equals(grant.optString("mime")))
              throw new Exception("The upload session does not match this saved video.");
            String candidate = grant.getString("url");
            driveAddress(candidate);
            address = candidate;
          }
        }
        return result;
      }

      public JSONObject chunk(long offset, int length) throws Exception {
        return uploadDriveChunk(address, file, offset, length);
      }
    };
  }

  private static URL driveAddress(String address) throws Exception {
    try {
      if (address.length() > 4096) throw new IllegalArgumentException();
      URI uri = new URI(address);
      if (!"https".equals(uri.getScheme()) || !"www.googleapis.com".equals(uri.getHost())
          || uri.getRawUserInfo() != null || uri.getPort() != -1 || uri.getRawFragment() != null
          || uri.getPath() == null || !uri.getPath().matches("/upload/drive/v3/files(?:/[A-Za-z0-9_-]{8,200})?")
          || uri.getRawQuery() == null || !uri.getRawQuery().matches("(?:.*&)?upload_id=[^&]+(?:&.*)?"))
        throw new IllegalArgumentException();
      return uri.toURL();
    } catch (Exception invalid) {
      throw new Exception("Invalid Google Drive upload session. Your video stays in Saved videos.");
    }
  }

  JSONObject uploadDriveChunk(String address, File file, long offset, int length) throws Exception {
    if (offset < 0 || length < 1 || length > 4 * 1024 * 1024 || offset + length > file.length())
      throw new Exception("Invalid upload chunk.");
    URL destination = driveAddress(address);
    HttpURLConnection c = null;
    try {
      c = connections.open(destination);
      c.setInstanceFollowRedirects(false);
      c.setUseCaches(false);
      c.setConnectTimeout(15000);
      c.setReadTimeout(60000);
      c.setRequestMethod("PUT");
      c.setDoOutput(true);
      c.setFixedLengthStreamingMode(length);
      c.setRequestProperty("Content-Type", "video/mp4");
      c.setRequestProperty(
          "Content-Range", "bytes " + offset + "-" + (offset + length - 1) + "/" + file.length());
      try (RandomAccessFile f = new RandomAccessFile(file, "r");
          OutputStream o = c.getOutputStream()) {
        f.seek(offset);
        byte[] b = new byte[65536];
        int remain = length;
        while (remain > 0) {
          int n = f.read(b, 0, Math.min(b.length, remain));
          if (n < 0) throw new IOException("Video incomplete.");
          o.write(b, 0, n);
          remain -= n;
        }
      }
      int status = c.getResponseCode();
      if (status == 404 || status == 410) return new JSONObject().put("expired", true);
      if (status == 308 || status == 200 || status == 201)
        return new JSONObject().put("accepted", true).put("complete", status != 308);
      throw new Exception("Google Drive upload paused (HTTP " + status + "). Your video stays in Saved videos.");
    } catch (IOException interrupted) {
      // Network exceptions can contain the bearer URL; never put it into logs,
      // the saved queue, Admin or player-facing errors.
      throw new IOException("Google Drive connection interrupted. Retry from Saved videos.");
    } finally {
      if (c != null) c.disconnect();
    }
  }
}
