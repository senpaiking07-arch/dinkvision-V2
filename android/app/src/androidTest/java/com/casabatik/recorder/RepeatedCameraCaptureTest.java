package com.casabatik.recorder;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;

@RunWith(AndroidJUnit4.class)
public class RepeatedCameraCaptureTest {
  @Test public void successiveClipsReleaseHardwareEncoders() throws Exception {
    var instrumentation=InstrumentationRegistry.getInstrumentation();
    var context=instrumentation.getTargetContext();
    MainActivity activity=(MainActivity)instrumentation.startActivitySync(new android.content.Intent(context,MainActivity.class)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
    Engine engine=Engine.get(context); boolean prior=engine.busy;engine.busy=true;
    context.startForegroundService(new android.content.Intent(context,RecorderService.class).putExtra(RecorderService.EXTRA_CAMERA_ACTIVE,true));
    try {
      for(int n=0;n<10;n++){
        File file=new File(context.getCacheDir(),"encoder-release-check-"+n+".mp4");
        try{
          long duration=DeviceCameraRecorder.capture(context,file,2,0,()->false,new CameraCapture.Listener(){
            public void ready(){} public void countdown(int value){} public void started(){} public void frame(int seconds){}
          });
          assertTrue("Clip "+n+" must contain validated picture and audio",RecordedVideo.validate(file,duration,true)>0);
        }finally{file.delete();}
      }
    }finally{engine.busy=prior;context.stopService(new android.content.Intent(context,RecorderService.class));instrumentation.runOnMainSync(activity::finish);}
  }
}
