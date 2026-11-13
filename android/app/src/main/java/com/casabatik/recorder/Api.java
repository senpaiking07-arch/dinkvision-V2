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
  private final Object enrollmentLock = new Object();
  private static final class Response extends JSONObject {
    String credential;
    Response(String text) throws org.json.JSONException { super(text); }
  }
  interface StateUpdate { void apply() throws Exception; }
  void acceptCurrentResponse(JSONObject response, StateUpdate update) throws Exception {
    synchronized (vault) {
      if (response instanceof Response
          && !Objects.equals(((Response)response).credential,vault.object("cookies").optString("cb-kiosk")))
        throw new Exception("Device registration changed during this request. Please retry.");
      update.apply();
    }
  }

  static final class RequestFailure extends Exception {
    final String code;
    final int httpStatus;
    RequestFailure(String message, String code) { this(message, code, 0); }
    RequestFailure(String message, String code, int httpStatus) { super(message); this.code=code; this.httpStatus=httpStatus; }
  }

  private static RequestFailure networkFailure(IOException failure) {
    String code = failure instanceof SocketTimeoutException ? "timeout" :
      failure instanceof UnknownHostException ? "dns" :
      failure instanceof javax.net.ssl.SSLException ? "tls" : "connection";
    return new RequestFailure("Connection interrupted. Please retry; saved videos remain on this device.",code);
  }

  Api(Vault v) {
    this(v, url -> (HttpURLConnection) url.openConnection());
  }

  Api(Vault v, Connections connections) {
    vault = v;
    this.connections = connections;
  }

  JSONObject call(String path, JSONObject body) throws Exception {
    // Enrollment rotates identity. Serialize only enrollment transactions, never
    // unrelated capture/heartbeat/upload HTTP waits.
    if ("/api/tablet/enroll".equals(path) || "/api/tablet/pairing".equals(path)) {
      synchronized (enrollmentLock) { return request(path, body); }
    }
    return request(path, body);
  }

  private JSONObject request(String path, JSONObject body) throws Exception {
    if (!path.startsWith("/api/")) throw new Exception("Invalid application request.");
    boolean diagnostics = "/api/tablet/diagnostics".equals(path);
    HttpURLConnection c;
    try { c = connections.open(new URL(ORIGIN + path)); }
    catch (IOException failure) { if (!diagnostics) serverReachable = false; throw networkFailure(failure); }
    c.setConnectTimeout(diagnostics?5000:15000);
    c.setReadTimeout(diagnostics?5000:30000);
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
      if (!diagnostics) serverReachable = true;
      InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
      String text = in == null ? "" : read(in);
      Response result;
      try {
        result = new Response(text);
      } catch (Exception e) {
        throw new Exception("Hosted app unavailable. Check the deployment and try again.");
      }
      if (status == 426 && result.optJSONObject("release") != null)
        vault.put("android-release", AppUpdate.validate(result.getJSONObject("release")).toString());
      if (status == 404 && "/api/tablet/enroll".equals(path)
          && "enrollment_not_committed".equals(result.optString("code")))
        throw new RequestFailure("This enrollment attempt has not been confirmed.", "enrollment_not_committed", status);
      if (status == 400 && "/api/tablet/enroll".equals(path)
          && "enrollment_code_unavailable".equals(result.optString("code")))
        throw new RequestFailure(result.optString("error", "Enrollment is unavailable."), "enrollment_code_unavailable", status);
      if (status < 200 || status >= 300)
        throw new RequestFailure(result.optString("error", "Request failed. Please retry."),status>=500?"http_server":"http_client",status);
      // Outages, redirects and invalid deployment responses must never alter
      // pairing. Only a confirmed enrollment response can replace that token.
      boolean enrollment = "/api/tablet/enroll".equals(path)
          || ("/api/tablet/pairing".equals(path) && "enrolled".equals(result.optString("status")));
      boolean receivedCredential = false;
      List<HttpCookie> updates = new ArrayList<>();
      for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet())
        if ("set-cookie".equalsIgnoreCase(h.getKey()))
          for (String line : h.getValue())
            for (HttpCookie cookie : HttpCookie.parse(line)) {
              if ("cb-kiosk".equals(cookie.getName())) {
                if (!enrollment || !Boolean.TRUE.equals(result.opt("ok")) || cookie.getMaxAge() == 0
                    || !cookie.getValue().matches("[A-Za-z0-9_-]{43}")) continue;
                receivedCredential = true;
              }
              updates.add(cookie);
            }
      if (enrollment && !receivedCredential)
        throw new Exception("Enrollment response did not contain a valid device credential. Check the registration with Admin.");
      synchronized (vault) {
        JSONObject current = vault.object("cookies");
        // A response issued for the old registration must neither merge cookies
        // nor expose that old device's assignment to Engine.updateServer().
        if (!Objects.equals(jar.optString("cb-kiosk"), current.optString("cb-kiosk")))
          throw new Exception("Device registration changed during this request. Please retry.");
        for (HttpCookie cookie : updates) {
          if (cookie.getMaxAge() == 0) current.remove(cookie.getName());
          else current.put(cookie.getName(), cookie.getValue());
        }
        if (!updates.isEmpty()) vault.put("cookies", current.toString());
        result.credential=current.optString("cb-kiosk");
      }
      return result;
    } catch (IOException failure) {
      if (!diagnostics) serverReachable = false;
      throw networkFailure(failure);
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
          if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("Upload paused.");
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
      throw new RequestFailure("Google Drive upload paused (HTTP " + status + "). Your video stays in Saved videos.",status>=500?"http_server":"http_client",status);
    } catch (IOException interrupted) {
      // Network exceptions can contain the bearer URL; never put it into logs,
      // the saved queue, Admin or player-facing errors.
      throw networkFailure(interrupted);
    } finally {
      if (c != null) c.disconnect();
    }
  }
}
