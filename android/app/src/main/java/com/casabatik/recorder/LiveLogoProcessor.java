package com.casabatik.recorder;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.SurfaceTexture;
import android.opengl.*;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import com.herohan.uvcapp.VideoCapture;
import java.io.File;
import java.nio.*;
import java.util.concurrent.*;

/** Offscreen compositor: only the encoder input sees the added logo. No Activity/preview dependency. */
final class LiveLogoProcessor implements VideoCapture.SurfaceProcessor {
  static volatile String status = "Live watermark ready";
  private final HandlerThread thread = new HandlerThread("DinkVisionLiveLogo");
  private final Handler handler;
  private final int width, height, rotation;
  private volatile boolean encoding = true;
  private final java.util.function.Consumer<Exception> onFailure;
  private EGLDisplay display = EGL14.EGL_NO_DISPLAY;
  private EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
  private EGLSurface window = EGL14.EGL_NO_SURFACE;
  private SurfaceTexture texture;
  private Surface input;
  private int cameraTexture, logoTexture, cameraProgram, logoProgram, logoWidth, logoHeight;
  private volatile boolean stopped;
  private volatile Exception failure;
  private volatile long frames;
  private long lastTimestamp;
  private final float[] transform = new float[16];
  private static final float[] IDENTITY = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
  private final FloatBuffer vertices = floats(-1,-1, 1,-1, -1,1, 1,1);
  private final FloatBuffer cameraUv = floats(0,0, 1,0, 0,1, 1,1);
  private final FloatBuffer logoUv;

  LiveLogoProcessor(Context context, Surface encoder, int width, int height) throws Exception {
    this(context,encoder,width,height,ignored -> {});
  }

  LiveLogoProcessor(Context context, Surface encoder, int width, int height, java.util.function.Consumer<Exception> onFailure) throws Exception {
    this(context, encoder, width, height, 0, true, onFailure);
  }

  LiveLogoProcessor(Context context, Surface encoder, int width, int height, int rotation,
      boolean encoding, java.util.function.Consumer<Exception> onFailure) throws Exception {
    this.width = width; this.height = height; this.rotation = rotation; this.encoding = encoding;
    // Invert the MP4 playback rotation so the logo reads upright at bottom right.
    switch (rotation) {
      case 90: logoUv = floats(0,0, 0,1, 1,0, 1,1); break;
      case 180: logoUv = floats(1,0, 0,0, 1,1, 0,1); break;
      case 270: logoUv = floats(1,1, 1,0, 0,1, 0,0); break;
      default: logoUv = floats(0,1, 1,1, 0,0, 1,0);
    }
    this.onFailure = onFailure;
    thread.start(); handler = new Handler(thread.getLooper());
    try { onGl(() -> initialize(context, encoder)); status = "Live watermark active"; }
    catch (Exception e) { status = "Live watermark unavailable · camera check required"; close(); throw e; }
  }

  private void initialize(Context context, Surface encoder) throws Exception {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
    int[] version = new int[2];
    require(EGL14.eglInitialize(display, version, 0, version, 1), "EGL initialize");
    EGLConfig[] configs = new EGLConfig[1]; int[] count = new int[1];
    int[] attributes = {EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,
        EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT,
        0x3142,1,EGL14.EGL_NONE}; // EGL_RECORDABLE_ANDROID
    require(EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) && count[0] > 0, "Recordable EGL config");
    eglContext = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT,
        new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE},0);
    window = EGL14.eglCreateWindowSurface(display, configs[0], encoder, new int[]{EGL14.EGL_NONE},0);
    require(EGL14.eglMakeCurrent(display,window,window,eglContext), "Encoder EGL surface");
    cameraProgram = program(true); logoProgram = program(false);
    cameraTexture = texture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES);
    texture = new SurfaceTexture(cameraTexture);
    texture.setDefaultBufferSize(width,height);
    input = new Surface(texture);
    try (var stream = context.getAssets().open("dink-vision-logo.png")) {
      Bitmap bitmap = BitmapFactory.decodeStream(stream);
      if (bitmap == null) throw new Exception("Live logo image unavailable");
      try {
        boolean portrait = rotation == 90 || rotation == 270;
        double scale = Math.min((portrait ? height : width) * .20 / bitmap.getWidth(),
            (portrait ? width : height) * .16 / bitmap.getHeight());
        logoWidth = Math.max(1,(int)Math.round(bitmap.getWidth()*scale));
        logoHeight = Math.max(1,(int)Math.round(bitmap.getHeight()*scale));
        if (portrait) { int swap = logoWidth; logoWidth = logoHeight; logoHeight = swap; }
        logoTexture = texture(GLES20.GL_TEXTURE_2D);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D,0,bitmap,0);
      } finally { bitmap.recycle(); }
    }
    checkGl();
    texture.setOnFrameAvailableListener(ignored -> render(), handler);
  }

  private void render() {
    if (stopped || failure != null) return;
    try {
      texture.updateTexImage(); texture.getTransformMatrix(transform);
      long timestamp = texture.getTimestamp();
      if (!encoding || timestamp <= lastTimestamp) return;
      GLES20.glViewport(0,0,width,height);
      GLES20.glDisable(GLES20.GL_BLEND);
      draw(cameraProgram,cameraTexture,GLES11Ext.GL_TEXTURE_EXTERNAL_OES,cameraUv,transform);
      int margin = Math.max(12,Math.round(Math.min(width,height)*.02f));
      int left = rotation == 180 || rotation == 270 ? margin : width-logoWidth-margin;
      int bottom = rotation == 90 || rotation == 180 ? height-logoHeight-margin : margin;
      GLES20.glViewport(left,bottom,logoWidth,logoHeight);
      GLES20.glEnable(GLES20.GL_BLEND);
      GLES20.glBlendFunc(GLES20.GL_ONE,GLES20.GL_ONE_MINUS_SRC_ALPHA);
      draw(logoProgram,logoTexture,GLES20.GL_TEXTURE_2D,logoUv,IDENTITY);
      checkGl();
      require(EGLExt.eglPresentationTimeANDROID(display,window,timestamp), "Frame timestamp");
      require(EGL14.eglSwapBuffers(display,window), "Encode live logo frame");
      lastTimestamp = timestamp; frames++;
    } catch (Exception e) { failure = e; onFailure.accept(e); }
  }

  private void draw(int program,int texture,int target,FloatBuffer uv,float[] matrix) {
    GLES20.glUseProgram(program);
    int position = GLES20.glGetAttribLocation(program,"position"), coord = GLES20.glGetAttribLocation(program,"uv");
    vertices.position(0); uv.position(0);
    GLES20.glVertexAttribPointer(position,2,GLES20.GL_FLOAT,false,0,vertices);
    GLES20.glVertexAttribPointer(coord,2,GLES20.GL_FLOAT,false,0,uv);
    GLES20.glEnableVertexAttribArray(position); GLES20.glEnableVertexAttribArray(coord);
    GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program,"transform"),1,false,matrix,0);
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0); GLES20.glBindTexture(target,texture);
    GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"image"),0);
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4);
    GLES20.glDisableVertexAttribArray(position); GLES20.glDisableVertexAttribArray(coord);
  }

  void startEncoding() { encoding = true; }
  public Surface input() { return input; }
  public void stop() { stopped = true; }
  public void completed(File file) throws Exception {
    stop(); onGl(() -> {});
    if (failure != null) throw new Exception("Live logo rendering failed", failure);
    if (frames < 1 || file == null) throw new Exception("No live-logo frames were saved");
    RecordedVideo.validate(file, -1, false);
    LiveLogoEvidence.mark(file);
  }

  public void close() {
    stop();
    try { onGl(() -> {
      if (texture != null) texture.setOnFrameAvailableListener(null);
      if (input != null) input.release();
      if (texture != null) texture.release();
      if (display != EGL14.EGL_NO_DISPLAY) {
        EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);
        if (window != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display,window);
        if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display,eglContext);
        EGL14.eglReleaseThread(); EGL14.eglTerminate(display);
      }
    }); } catch (Exception ignored) { /* Bounded cleanup; an encoder failure must preserve the saved file. */ }
    thread.quitSafely();
  }

  private interface GlWork { void run() throws Exception; }
  private void onGl(GlWork work) throws Exception {
    FutureTask<Void> task = new FutureTask<>(() -> { work.run(); return null; });
    if (!handler.post(task)) throw new Exception("Live logo worker stopped");
    task.get(10,TimeUnit.SECONDS);
  }
  private static FloatBuffer floats(float... values) {
    FloatBuffer buffer = ByteBuffer.allocateDirect(values.length*4).order(ByteOrder.nativeOrder()).asFloatBuffer();
    buffer.put(values).position(0); return buffer;
  }
  private static int texture(int target) {
    int[] id = new int[1]; GLES20.glGenTextures(1,id,0); GLES20.glBindTexture(target,id[0]);
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR);
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR);
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE);
    GLES20.glTexParameteri(target,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE); return id[0];
  }
  private static int program(boolean external) throws Exception {
    String vertex = "attribute vec4 position; attribute vec2 uv; uniform mat4 transform; varying vec2 tex; void main(){gl_Position=position;tex=(transform*vec4(uv,0.0,1.0)).xy;}";
    String fragment = (external ? "#extension GL_OES_EGL_image_external : require\n" : "")
        + "precision mediump float; varying vec2 tex; uniform " + (external ? "samplerExternalOES" : "sampler2D")
        + " image; void main(){gl_FragColor=texture2D(image,tex);}";
    int vs = shader(GLES20.GL_VERTEX_SHADER,vertex), fs = shader(GLES20.GL_FRAGMENT_SHADER,fragment);
    int program = GLES20.glCreateProgram(); GLES20.glAttachShader(program,vs); GLES20.glAttachShader(program,fs);
    GLES20.glLinkProgram(program); GLES20.glDeleteShader(vs); GLES20.glDeleteShader(fs);
    int[] ok = new int[1]; GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,ok,0);
    require(ok[0] != 0,"Live logo shader link"); return program;
  }
  private static int shader(int type,String source) throws Exception {
    int shader = GLES20.glCreateShader(type); GLES20.glShaderSource(shader,source); GLES20.glCompileShader(shader);
    int[] ok = new int[1]; GLES20.glGetShaderiv(shader,GLES20.GL_COMPILE_STATUS,ok,0);
    require(ok[0] != 0,"Live logo shader compile"); return shader;
  }
  private static void checkGl() throws Exception { require(GLES20.glGetError()==GLES20.GL_NO_ERROR,"Live logo GL rendering"); }
  private static void require(boolean valid,String operation) throws Exception { if (!valid) throw new Exception(operation + " failed"); }
}
