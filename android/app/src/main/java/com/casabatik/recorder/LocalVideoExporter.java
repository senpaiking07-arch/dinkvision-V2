package com.casabatik.recorder;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.function.Consumer;
import java.util.function.IntConsumer;

/** Copies a private original to user-owned storage; never moves or deletes the source. */
final class LocalVideoExporter {
  private LocalVideoExporter() {}

  static boolean readable(ContentResolver resolver, String value) {
    if (value == null || value.isEmpty()) return false;
    try (var descriptor = resolver.openFileDescriptor(Uri.parse(value), "r")) {
      return descriptor != null;
    } catch (Exception unavailable) {
      return false;
    }
  }

  static boolean verifiedCopy(ContentResolver resolver, String value, long expectedBytes) {
    if (value == null || value.isEmpty() || expectedBytes < 1) return false;
    try (var descriptor = resolver.openFileDescriptor(Uri.parse(value), "r")) {
      return descriptor != null && descriptor.getStatSize() == expectedBytes;
    } catch (Exception unavailable) { return false; }
  }

  static Uri save(Context context, File source, String name, Uri chosen,
      IntConsumer progress, Consumer<Uri> created) throws Exception {
    return save(context,source,name,chosen,progress,created,ignored->{});
  }
  static Uri save(Context context, File source, String name, Uri chosen,
      IntConsumer progress, Consumer<Uri> created, java.util.function.LongConsumer completedBytes) throws Exception {
    ContentResolver resolver = context.getContentResolver();
    Uri destination = chosen;
    boolean gallery = chosen == null;
    try (FileInputStream input = new FileInputStream(source)) {
      long expected = input.getChannel().size();
      if (expected < 1) throw new IOException("The local video is empty.");
      if (gallery) {
        if (Build.VERSION.SDK_INT < 29)
          throw new IOException("Choose a location using Save to device.");
        ContentValues values = new ContentValues();
        values.put(MediaStore.Video.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
        values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/DinkVision");
        values.put(MediaStore.Video.Media.IS_PENDING, 1);
        destination = resolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
      } else if (!"content".equals(chosen.getScheme())) {
        throw new IOException("Choose a file with Android's save picker.");
      }
      if (destination == null) throw new IOException("Android could not create the saved video.");
      created.accept(destination);
      try (OutputStream output = resolver.openOutputStream(destination, "w")) {
        if (output == null) throw new IOException("Android could not open the destination.");
        byte[] buffer = new byte[64 * 1024];
        long copied = 0;
        int count, lastPercent = -1;
        while ((count = input.read(buffer)) != -1) {
          if (Thread.currentThread().isInterrupted()) throw new IOException("Saving was interrupted. The original is still in the app.");
          output.write(buffer, 0, count);
          copied += count;
          int percent = (int) Math.min(99L, copied * 100L / expected);
          if (percent != lastPercent) { progress.accept(percent); lastPercent = percent; }
        }
        output.flush();
        if (copied != expected) throw new IOException("The copy was incomplete. The original is still in the app.");
      }
      if (gallery) {
        ContentValues published = new ContentValues();
        published.put(MediaStore.Video.Media.IS_PENDING, 0);
        if (resolver.update(destination, published, null, null) != 1)
          throw new IOException("Android could not finish publishing the video.");
      }
      progress.accept(100);
      completedBytes.accept(expected);
      return destination;
    } catch (Exception failure) {
      if (destination != null) {
        try {
          if (gallery) resolver.delete(destination, null, null);
          else DocumentsContract.deleteDocument(resolver, destination);
        } catch (Exception ignored) { }
      }
      throw failure;
    }
  }

  static void cleanupInterruptedGalleryCopy(Context context, String value) {
    if (Build.VERSION.SDK_INT < 29 || value.isEmpty()) return;
    Uri uri = Uri.parse(value);
    if (!"content".equals(uri.getScheme()) || !"media".equals(uri.getAuthority())) return;
    try (Cursor cursor = context.getContentResolver().query(uri,
        new String[] {MediaStore.Video.Media.IS_PENDING}, null, null, null)) {
      if (cursor != null && cursor.moveToFirst() && cursor.getInt(0) == 1)
        context.getContentResolver().delete(uri, null, null);
    } catch (Exception ignored) { }
  }
}
