package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.graphics.Color;
import android.media.*;
import android.view.Surface;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.concurrent.*;
import org.junit.Test;

public class LiveLogoProcessorTest {
  @Test public void completedCameraEvidenceSurvivesProcessRestart() throws Exception {
    var context=InstrumentationRegistry.getInstrumentation().getTargetContext();
    File first=new File(context.getCacheDir(),"live-camera-1.mp4");
    org.junit.Assume.assumeTrue(context.getPackageName().endsWith(".honor")&&first.exists());
    for(int index=1;index<=2;index++) {
      File file=new File(context.getCacheDir(),"live-camera-"+index+".mp4");
      assertTrue(LiveLogoEvidence.verified(file));long bytes=file.length();
      VideoBranding.apply(context,file,-1,true,()->false);
      assertEquals(bytes,file.length());assertTrue(LiveLogoEvidence.verified(file));
    }
  }
  @Test public void evidenceRejectsChangedOrTruncatedBytes() throws Exception {
    File file = File.createTempFile("live-proof-", ".mp4", InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
    try {
      try (FileOutputStream out = new FileOutputStream(file)) { out.write(new byte[1024]); }
      assertFalse(LiveLogoEvidence.verified(file));
      LiveLogoEvidence.mark(file); assertTrue(LiveLogoEvidence.verified(file));
      try (RandomAccessFile edit = new RandomAccessFile(file,"rw")) { edit.seek(10); edit.write(1); }
      assertFalse(LiveLogoEvidence.verified(file));
      try (RandomAccessFile edit = new RandomAccessFile(file,"rw")) { edit.setLength(100); }
      assertFalse(LiveLogoEvidence.verified(file));
    } finally { file.delete(); }
  }

  @Test public void gpuLogoIsInSaved1080pVideoAndCompletedBytesSkipSoftwareBranding() throws Exception {
    var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    File file = new File(context.getCacheDir(),"live-logo-synthetic.mp4");
    MediaCodec encoder = MediaCodec.createEncoderByType("video/avc");
    MediaFormat format = MediaFormat.createVideoFormat("video/avc",1920,1080);
    format.setInteger(MediaFormat.KEY_COLOR_FORMAT,MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    format.setInteger(MediaFormat.KEY_BIT_RATE,16000000); format.setInteger(MediaFormat.KEY_FRAME_RATE,60);
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL,1);
    encoder.configure(format,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE);
    Surface surface = encoder.createInputSurface();
    LiveLogoProcessor processor = new LiveLogoProcessor(context,surface,1920,1080);
    MediaMuxer muxer = new MediaMuxer(file.toString(),MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
    ExecutorService drain = Executors.newSingleThreadExecutor();
    encoder.start();
    Future<?> result = drain.submit(() -> {
      MediaCodec.BufferInfo info = new MediaCodec.BufferInfo(); int track = -1;
      long deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
      try {
        while(System.nanoTime()<deadline) {
          int index = encoder.dequeueOutputBuffer(info,10000);
          if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track=muxer.addTrack(encoder.getOutputFormat()); muxer.start(); }
          else if(index>=0) {
            var buffer=encoder.getOutputBuffer(index);
            if(info.size>0&&(info.flags&MediaCodec.BUFFER_FLAG_CODEC_CONFIG)==0) {
              buffer.position(info.offset); buffer.limit(info.offset+info.size); muxer.writeSampleData(track,buffer,info);
            }
            boolean end=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;
            encoder.releaseOutputBuffer(index,false); if(end)return;
          }
        }
        throw new AssertionError("Encoder did not finish");
      } finally { if(track>=0)muxer.stop(); }
    });
    try {
      for(int i=0;i<150;i++) {
        var canvas=processor.input().lockHardwareCanvas(); canvas.drawColor(Color.GREEN);
        processor.input().unlockCanvasAndPost(canvas); Thread.sleep(17);
      }
      Thread.sleep(100); processor.stop(); encoder.signalEndOfInputStream(); result.get(25,TimeUnit.SECONDS);
      processor.completed(file); assertTrue(LiveLogoEvidence.verified(file));
      MediaMetadataRetriever retriever=new MediaMetadataRetriever();
      try {
        retriever.setDataSource(file.toString());
        assertEquals("1920",retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
        assertEquals("1080",retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
        var bitmap=retriever.getFrameAtTime(1000000,MediaMetadataRetriever.OPTION_CLOSEST);
        assertNotNull(bitmap);
        try(var image = new FileOutputStream(new File(context.getCacheDir(),"live-logo-decoded.png"))) {
          bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,image);
        }
        int changed=0;
        for(int y=850;y<1055;y+=3)for(int x=1500;x<1895;x+=3) {
          int pixel=bitmap.getPixel(x,y); if(Color.red(pixel)>60||Color.blue(pixel)>60)changed++;
        }
        assertTrue("Logo must be embedded in saved pixels: changed="+changed+" size="+bitmap.getWidth()+"x"+bitmap.getHeight(),changed>100);
        int center=bitmap.getPixel(960,540);assertTrue(Color.green(center)>180&&Color.red(center)<60);
        bitmap.recycle();
      } finally { retriever.release(); }
      byte[] before=java.nio.file.Files.readAllBytes(file.toPath());
      VideoBranding.apply(context,file,-1,false,()->false);
      assertArrayEquals("Upload retry must reuse live-branded bytes",before,java.nio.file.Files.readAllBytes(file.toPath()));
    } finally {
      processor.close(); drain.shutdownNow(); encoder.stop(); encoder.release(); surface.release(); muxer.release();
      // This test-only clip is retained in the diagnostic app cache for visual review.
    }
  }
}
