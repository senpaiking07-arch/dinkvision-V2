// Transform actual camera frames off the page's rendering loop.
self.onmessage = async ({ data }) => {
  const { readable, writable, transform } = data;
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let canvas, context;
  try {
    while (true) {
      const { value: frame, done } = await reader.read();
      if (done) throw Error('Camera stream ended.');
      let output;
      try {
        const w = frame.displayWidth, h = frame.displayHeight;
        const sideways = transform.video_rotation % 180 !== 0;
        const width = sideways ? h : w, height = sideways ? w : h;
        if (!canvas || canvas.width !== width || canvas.height !== height) {
          canvas = new OffscreenCanvas(width, height);
          context = canvas.getContext('2d', { alpha: false });
          if (!context) throw Error('Camera transform canvas unavailable.');
        }
        context.save();
        context.translate(width / 2, height / 2);
        context.scale(transform.video_flip_horizontal ? -1 : 1, transform.video_flip_vertical ? -1 : 1);
        context.rotate(transform.video_rotation * Math.PI / 180);
        context.drawImage(frame, -w / 2, -h / 2, w, h);
        context.restore();
        output = new VideoFrame(canvas, { timestamp: frame.timestamp, ...(frame.duration == null ? {} : { duration: frame.duration }) });
        // Signal readiness before write: the consumer is attached after setup resolves.
        self.postMessage({ type: 'frame' });
        await writer.write(output);
      } finally {
        frame.close();
        output?.close();
      }
    }
    await writer.close();
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Camera transform failed.' });
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
  }
};
