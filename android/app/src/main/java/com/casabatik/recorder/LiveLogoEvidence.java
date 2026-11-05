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
    byte[] digest = digest(file, file.length());
    try (FileOutputStream stream = new FileOutputStream(file, true); DataOutputStream out = new DataOutputStream(stream)) {
      out.writeInt(BOX_SIZE); out.writeInt(0x75756964); out.write(ID); out.write(digest);
      out.flush(); stream.getFD().sync();
    }
  }

  static void requireVerified(File file) throws RecordingAccuracy.Failure {
    if (!verified(file)) throw new RecordingAccuracy.Failure("Live watermark could not be verified. Footage was kept on the device.");
  }

  static boolean verified(File file) {
    if (file == null || file.length() <= BOX_SIZE) return false;
    try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
      input.seek(file.length() - BOX_SIZE);
      if (input.readInt() != BOX_SIZE || input.readInt() != 0x75756964) return false;
      byte[] id = new byte[16], expected = new byte[32]; input.readFully(id); input.readFully(expected);
      return Arrays.equals(ID, id) && MessageDigest.isEqual(expected, digest(file, file.length() - BOX_SIZE));
    } catch (Exception unavailable) { return false; }
  }

  private static byte[] digest(File file, long length) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
      byte[] buffer = new byte[65536];
      while (length > 0) {
        int read = in.read(buffer, 0, (int)Math.min(buffer.length, length));
        if (read < 0) throw new EOFException("Saved video changed while checking live logo.");
        digest.update(buffer, 0, read); length -= read;
      }
    }
    return digest.digest();
  }
}
