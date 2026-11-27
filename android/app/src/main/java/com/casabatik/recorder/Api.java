package com.casabatik.recorder;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

final class Api {
  static final String ORIGIN = BuildConfig.APP_ORIGIN;
  private final Vault vault;
  private volatile String reachableAttempt = "";
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

  private static final Set<String> UPLOAD_ACTIONS = Set.of("upload", "retry-upload", "restart-upload", "upload-status", "upload-part", "upload-parts", "finish");
  private static final Set<String> PREPARE_ACTIONS = Set.of("upload", "retry-upload", "restart-upload");

  static int readTimeout(String path, JSONObject body) {
    if ("/api/tablet/diagnostics".equals(path)) return 5000;
    return "/api/tablet".equals(path) && body != null && UPLOAD_ACTIONS.contains(body.optString("action")) ? 60000 : 30000;
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

  byte[] recordingLogo(String sessionId) throws Exception {
    UUID.fromString(sessionId);
    String credential = vault.object("cookies").optString("cb-kiosk");
    FutureTask<byte[]> fetch = new FutureTask<>(() -> fetchRecordingLogo(sessionId, credential));
    Thread worker = new Thread(fetch, "DinkVisionCourtLogo");
    worker.setDaemon(true);
    worker.start();
    try {
      return fetch.get(2, TimeUnit.SECONDS);
    } finally {
      fetch.cancel(true);
    }
  }

  private byte[] fetchRecordingLogo(String sessionId, String credential) throws Exception {
    final int limit = 512 * 1024;
    final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
    HttpURLConnection connection = connections.open(new URL(ORIGIN + "/api/tablet/recording-logo/" + sessionId));
    try {
      connection.setConnectTimeout(1500);
      connection.setReadTimeout(1500);
      connection.setInstanceFollowRedirects(false);
      connection.setRequestProperty("Cookie", "cb-kiosk=" + credential);
      connection.setRequestProperty("Accept", "image/png");
      int status = connection.getResponseCode();
      if (status == 204) return null;
      if (status != 200 || !"image/png".equals(connection.getContentType()) || connection.getContentLength() > limit)
        throw new IOException("Court logo is unavailable.");
      try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[8192];
        while (!Thread.currentThread().isInterrupted() && System.nanoTime() < deadline) {
          int count = input.read(buffer);
          if (count == -1) return output.toByteArray();
          if (output.size() + count > limit) throw new IOException("Court logo exceeds the size limit.");
          output.write(buffer, 0, count);
        }
        throw new SocketTimeoutException("Court logo download timed out.");
      }
    } finally {
      connection.disconnect();
    }
  }

  private JSONObject request(String path, JSONObject body) throws Exception {
    if (!path.startsWith("/api/")) throw new Exception("Invalid application request.");
    boolean diagnostics = "/api/tablet/diagnostics".equals(path);
    HttpURLConnection c;
    try { c = connections.open(new URL(ORIGIN + path)); }
    catch (IOException failure) { if (!diagnostics) serverReachable = false; throw networkFailure(failure); }
    c.setConnectTimeout(diagnostics?5000:15000);
    c.setReadTimeout(readTimeout(path, body));
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
        if (status >= 500) throw new RequestFailure("The app server is temporarily unavailable.", "http_server", status);
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
    return uploadTransport(session, file, false);
  }

  UploadTransfer.Transport uploadTransport(String session, File file, boolean singlePartAtATime) {
    UUID.fromString(session);
    return new UploadTransfer.Transport() {
      private String attemptId = "";
      private int attemptPartSize = 8 * 1024 * 1024;

      public JSONObject action(String action) throws Exception {
        if (!Set.of("upload", "retry-upload", "restart-upload", "upload-status", "finish").contains(action))
          throw new Exception("Invalid upload action.");
        JSONObject body = new JSONObject().put("id", session).put("direct_upload", true)
            .put("upload_protocol", "r2-multipart-v1").put("attempt_id", attemptId).put("large_parts", true);
        if (PREPARE_ACTIONS.contains(action)) body.put("part_size", 8 * 1024 * 1024);
        JSONObject result = tablet(action, body);
        if (PREPARE_ACTIONS.contains(action)) {
          attemptId = "";
          attemptPartSize = 8 * 1024 * 1024;
          if (!result.optBoolean("ready") && !result.optBoolean("queued")) {
            JSONObject multipart = result.optJSONObject("upload");
            if (multipart == null)
              throw new Exception("Private storage upload is unavailable. Your video stays in Saved videos.");
            int ps = multipart.optInt("partSize", 8 * 1024 * 1024);
            if (!"r2-multipart-v1".equals(multipart.optString("protocol"))
                || multipart.optLong("bytes") != file.length()
                || !UploadTransfer.validPartSize(ps)
                || !"video/mp4".equals(multipart.optString("mime")))
              throw new Exception("The upload does not match this saved video.");
            attemptId = UUID.fromString(multipart.getString("attemptId")).toString();
            attemptPartSize = ps;
            if (singlePartAtATime) multipart.put("parallelism", 1);
          }
        }
        return result;
      }

      private UploadTransfer.PartGrant parseGrant(JSONObject grant, long expectedOffset, int expectedLength) throws Exception {
        if (grant.optBoolean("expired")) return new UploadTransfer.PartGrant(-1, expectedOffset, expectedLength, "");
        int pn = grant.optInt("partNumber", (int) (expectedOffset / attemptPartSize) + 1);
        long off = grant.optLong("offset", -1);
        int len = grant.optInt("length", -1);
        if (off != expectedOffset || len != expectedLength || !attemptId.equals(grant.optString("attemptId")))
          throw new Exception("Upload progress changed. Retry the saved video.");
        String url = grant.optString("url", "");
        if (url.isEmpty()) throw new Exception("Upload not accepted. Retry the saved video.");
        return new UploadTransfer.PartGrant(pn, off, len, url);
      }

      public java.util.List<UploadTransfer.PartGrant> grants(long offset, int count, int partSize, long totalBytes) throws Exception {
        if (attemptId.isEmpty() || partSize != attemptPartSize || offset % partSize != 0)
          throw new Exception("Invalid confirmed upload offset.");
        java.util.List<Integer> numbers = new java.util.ArrayList<>();
        for (int i = 0; i < count; i++) {
          long off = offset + (long) i * partSize;
          if (off >= totalBytes) break;
          numbers.add((int) (off / partSize) + 1);
        }
        if (numbers.isEmpty()) return java.util.Collections.emptyList();
        JSONObject body = new JSONObject().put("id", session)
            .put("upload_protocol", "r2-multipart-v1").put("attempt_id", attemptId);
        if (numbers.size() == 1) body.put("part_number", numbers.get(0));
        else body.put("part_numbers", new org.json.JSONArray(numbers));
        JSONObject grant = tablet(numbers.size() == 1 ? "upload-part" : "upload-parts", body);
        if (grant.optBoolean("queued")) throw new UploadTransfer.WaitingForTurn();
        if (grant.optBoolean("expired"))
          return java.util.Collections.singletonList(new UploadTransfer.PartGrant(-1, offset, 0, ""));
        if (grant.optBoolean("uploaded")) return java.util.Collections.emptyList();
        java.util.List<UploadTransfer.PartGrant> out = new java.util.ArrayList<>();
        if (grant.has("parts")) {
          org.json.JSONArray parts = grant.optJSONArray("parts");
          if (parts == null) throw new Exception("Upload not accepted. Retry the saved video.");
          if (parts.length() != numbers.size()) throw new Exception("Invalid upload part count.");
          for (int i = 0; i < parts.length(); i++) {
            JSONObject p = parts.getJSONObject(i);
            int pn = p.getInt("partNumber");
            if (pn != numbers.get(i)) throw new Exception("Invalid upload part number.");
            long expectedOff = (long) (pn - 1) * partSize;
            int expectedLen = (int) Math.min(partSize, totalBytes - expectedOff);
            out.add(parseGrant(p, expectedOff, expectedLen));
            if (out.get(out.size() - 1).partNumber == -1) return java.util.Collections.singletonList(out.get(out.size() - 1));
          }
        } else {
          out.add(parseGrant(grant, offset, (int) Math.min(partSize, totalBytes - offset)));
        }
        if (!out.isEmpty() && out.get(0).partNumber > 0 && !reachableAttempt.equals(attemptId)) {
          checkStorageHost(out.get(0).url);
          reachableAttempt = attemptId;
        }
        return out;
      }

      public boolean putPart(UploadTransfer.PartGrant grant) throws Exception {
        JSONObject result = uploadR2Part(grant.url, file, grant.offset, grant.length);
        if (result.optBoolean("expired")) throw new UploadTransfer.ExpiredPartException();
        return result.optBoolean("accepted");
      }

      public JSONObject chunk(long offset, int length) throws Exception {
        java.util.List<UploadTransfer.PartGrant> g = grants(offset, 1, attemptPartSize, file.length());
        if (g.isEmpty()) return new JSONObject().put("accepted", true).put("complete", true);
        UploadTransfer.PartGrant grant = g.get(0);
        if (grant.partNumber == -1) return new JSONObject().put("expired", true);
        JSONObject r = uploadR2Part(grant.url, file, grant.offset, grant.length);
        if (r.optBoolean("expired")) return r;
        return new JSONObject().put("accepted", r.optBoolean("accepted")).put("url", grant.url).put("partNumber", grant.partNumber).put("offset", grant.offset).put("length", grant.length).put("attemptId", attemptId);
      }
    };
  }

  private static URL r2Address(String address) throws Exception {
    try {
      URI uri = new URI(address);
      if (address.length() > 8192 || !"https".equals(uri.getScheme()) || uri.getHost() == null
          || !uri.getHost().matches("[a-f0-9]{32}\\.r2\\.cloudflarestorage\\.com")
          || uri.getRawUserInfo() != null || uri.getPort() != -1 || uri.getRawFragment() != null
          || uri.getRawQuery() == null || !uri.getRawQuery().contains("X-Amz-Signature=")
          || !uri.getRawQuery().contains("uploadId=") || !uri.getRawQuery().contains("partNumber="))
        throw new IllegalArgumentException();
      return uri.toURL();
    } catch (Exception invalid) { throw new Exception("Invalid private storage address. The local video is retained."); }
  }

  void checkStorageHost(String signedUrl) throws Exception {
    URL address = r2Address(signedUrl);
    HttpURLConnection probe = null;
    try {
      probe = connections.open(new URL("https", address.getHost(), "/"));
      probe.setInstanceFollowRedirects(false);
      probe.setUseCaches(false);
      probe.setConnectTimeout(2500);
      probe.setReadTimeout(2500);
      probe.setRequestMethod("HEAD");
      if (probe.getResponseCode() < 100) throw new IOException();
    } catch (IOException failure) {
      throw new RequestFailure("Cloud storage is unreachable from this network. Ask the venue network admin to allow "
          + address.getHost() + "; the video remains saved on this device.", networkFailure(failure).code);
    } finally {
      if (probe != null) probe.disconnect();
    }
  }

  JSONObject uploadR2Part(String address, File file, long offset, int length) throws Exception {
    if (offset < 0 || length < 1 || length > UploadTransfer.MAX_PART_BYTES || offset + length > file.length())
      throw new Exception("Invalid upload part.");
    HttpURLConnection c = null;
    try {
      c = connections.open(r2Address(address));
      c.setInstanceFollowRedirects(false);
      c.setUseCaches(false);
      c.setConnectTimeout(15000);
      c.setReadTimeout(180000);
      c.setRequestMethod("PUT");
      c.setDoOutput(true);
      c.setFixedLengthStreamingMode(length);
      c.setRequestProperty("Content-Type", "video/mp4");
      try (RandomAccessFile f = new RandomAccessFile(file, "r"); OutputStream out = c.getOutputStream()) {
        f.seek(offset);
        byte[] buffer = new byte[65536];
        int remaining = length;
        while (remaining > 0) {
          if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("Upload paused.");
          int count;
          try { count = f.read(buffer, 0, Math.min(buffer.length, remaining)); }
          catch (IOException local) { throw new RequestFailure("Could not read the saved video on this device.", "device_or_storage"); }
          if (count < 0) throw new RecordingAccuracy.Failure("Saved video is missing or incomplete.");
          out.write(buffer, 0, count);
          remaining -= count;
        }
      }
      int status = c.getResponseCode();
      if (status == 403 || status == 404 || status == 410) return new JSONObject().put("expired", true);
      if (status >= 200 && status < 300) return new JSONObject().put("accepted", true);
      throw new RequestFailure("Private storage upload paused (HTTP " + status + "). The video remains saved locally.",
          status >= 500 ? "http_server" : "http_client", status);
    } catch (FileNotFoundException missing) {
      throw new RequestFailure("Saved video could not be opened on this device.", "device_or_storage");
    } catch (IOException failure) {
      String code = networkFailure(failure).code;
      String detail = switch (code) {
        case "timeout" -> "Cloud storage upload timed out. Retrying automatically";
        case "dns" -> "Cloud storage address could not be resolved. Check the venue network";
        case "tls" -> "Secure connection to cloud storage failed. Check the device date and time";
        default -> "Cloud storage connection was interrupted. Retrying automatically";
      };
      throw new RequestFailure(detail + "; saved videos remain on this device.", code);
    }
    finally { if (c != null) c.disconnect(); }
  }
}
