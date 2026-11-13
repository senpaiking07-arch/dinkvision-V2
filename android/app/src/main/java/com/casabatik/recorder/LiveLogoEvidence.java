package com.casabatik.recorder;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/** An MP4 UUID box binds the completed live-logo pass to these exact saved bytes. */
final class LiveLogoEvidence {
  private static final byte[] ID = "DINKLIVELOGO0001".getBytes(StandardCharsets.US_ASCII);
  private static final int BOX_SIZE = 56;

  static void mark(File file) throws Exception {
    if (!file.isFile() || file.length() < 1024) throw new IOException("No complete live recording was saved.");
    try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
      long length = output.length();
      byte[] digest = digest(output, length);
      if (output.length() != length) throw new IOException("Saved video changed while sealing the watermark.");
      output.writeInt(BOX_SIZE);
      output.writeInt(0x75756964);
      output.write(ID);
      output.write(digest);
      output.getFD().sync();
    }
  }

  static void requireVerified(File file) throws RecordingAccuracy.Failure {
    requireVerifiedDigest(file);
  }

  static boolean verified(File file) {
    try {
      requireVerifiedDigest(file);
      return true;
    } catch (RecordingAccuracy.Failure invalid) { return false; }
  }

  static boolean hasSeal(File file) {
    if (!file.isFile()) return false;
    try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
      return readSeal(input, input.length()) != null;
    } catch (Exception unavailable) { return false; }
  }

  static byte[] requireVerifiedDigest(File file) throws RecordingAccuracy.Failure {
    try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
      long length = input.length();
      byte[] expected = readSeal(input, length);
      if (expected != null && MessageDigest.isEqual(expected, digest(input, length - BOX_SIZE))
          && input.length() == length) return expected;
    } catch (Exception ignored) { /* Use the same safe recovery message for unreadable files. */ }
    throw new RecordingAccuracy.Failure("Live watermark could not be verified. Footage was kept on the device.");
  }

  private static byte[] readSeal(RandomAccessFile input, long length) throws IOException {
    if (length <= BOX_SIZE) return null;
    input.seek(length - BOX_SIZE);
    if (input.readInt() != BOX_SIZE || input.readInt() != 0x75756964) return null;
    byte[] id = new byte[16];
    input.readFully(id);
    if (!Arrays.equals(ID, id)) return null;
    byte[] expected = new byte[32];
    input.readFully(expected);
    return expected;
  }

  private static byte[] digest(RandomAccessFile file, long length) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    file.seek(0);
    byte[] buffer = new byte[65536];
    while (length > 0) {
      if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("Video check paused.");
      int read = file.read(buffer, 0, (int)Math.min(buffer.length, length));
      if (read < 0) throw new EOFException("Saved video changed while checking live logo.");
      digest.update(buffer, 0, read);
      length -= read;
    }
    return digest.digest();
  }
}
