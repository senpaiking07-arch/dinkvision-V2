package com.casabatik.recorder;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import org.json.JSONArray;
import org.json.JSONObject;

/** Opted-in recipients, private to the credential that enrolled this installation. */
final class EmailHistory {
  private static final String KEY = "recipient-history";
  private static final int LIMIT = 100;
  private static final long LIFETIME = TimeUnit.DAYS.toMillis(30);
  private final Vault vault;
  private final LongSupplier clock;

  EmailHistory(Vault vault, LongSupplier clock) {
    this.vault = vault;
    this.clock = clock;
  }

  String enrollment() {
    String token = vault.object("cookies").optString("cb-kiosk");
    if (token.isEmpty()) return "";
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
      return Base64.encodeToString(digest, Base64.NO_WRAP);
    } catch (NoSuchAlgorithmException unavailable) { return ""; }
  }

  private LinkedHashMap<String, Long> liveEntries(JSONObject stored, String enrollment, long now) {
    LinkedHashMap<String, Long> entries = new LinkedHashMap<>();
    JSONArray saved = stored.optJSONArray("entries");
    if (enrollment.isEmpty() || !enrollment.equals(stored.optString("enrollment")) || saved == null)
      return entries;
    for (int index = 0; index < saved.length(); index++) {
      JSONObject item = saved.optJSONObject(index);
      if (item == null) continue;
      long expiry = item.optLong("expiresAt");
      String email = item.optString("email");
      if (expiry > now && !email.isEmpty()) entries.put(email, expiry);
    }
    return entries;
  }

  private void write(String enrollment, LinkedHashMap<String, Long> entries) throws Exception {
    if (entries.isEmpty()) {
      vault.put(KEY, "");
      return;
    }
    JSONArray saved = new JSONArray();
    for (var entry : entries.entrySet())
      saved.put(new JSONObject().put("email", entry.getKey()).put("expiresAt", entry.getValue()));
    vault.put(KEY, new JSONObject().put("enrollment", enrollment).put("entries", saved).toString());
  }

  JSONObject find(String prefix) throws Exception {
    synchronized (vault) {
      String enrollment = enrollment();
      JSONObject stored = vault.object(KEY);
      LinkedHashMap<String, Long> entries = liveEntries(stored, enrollment, clock.getAsLong());
      JSONArray previous = stored.optJSONArray("entries");
      if (previous != null && previous.length() != entries.size()) {
        try { write(enrollment, entries); } catch (Exception ignored) { /* Expired entries remain hidden. */ }
      }
      JSONArray suggestions = new JSONArray();
      if (prefix.length() >= 3) {
        var addresses = new ArrayList<>(entries.keySet());
        String normalized = prefix.toLowerCase(Locale.ROOT);
        for (int index = addresses.size() - 1; index >= 0 && suggestions.length() < 3; index--)
          if (addresses.get(index).startsWith(normalized)) suggestions.put(addresses.get(index));
      }
      return new JSONObject().put("hasEntries", !entries.isEmpty()).put("suggestions", suggestions);
    }
  }

  void remember(String enrollment, JSONArray recipients, JSONArray consent) throws Exception {
    if (enrollment.isEmpty() || consent == null) return;
    synchronized (vault) {
      if (!enrollment.equals(enrollment())) return;
      long now = clock.getAsLong();
      LinkedHashMap<String, Long> entries = liveEntries(vault.object(KEY), enrollment, now);
      boolean changed = false;
      for (int index = 0; index < recipients.length(); index++) {
        if (!Boolean.TRUE.equals(consent.opt(index))) continue;
        String email = recipients.getString(index);
        entries.remove(email);
        entries.put(email, now + LIFETIME);
        changed = true;
      }
      if (!changed) return;
      while (entries.size() > LIMIT) entries.remove(entries.keySet().iterator().next());
      write(enrollment, entries);
    }
  }

  void remove(String email) throws Exception {
    synchronized (vault) {
      String enrollment = enrollment();
      var entries = liveEntries(vault.object(KEY), enrollment, clock.getAsLong());
      if (email.isEmpty()) entries.clear();
      else entries.remove(email.toLowerCase(Locale.ROOT));
      write(enrollment, entries);
    }
  }
}
