// Tab visibility is not a stop request. Only leaving the page interrupts capture.
// This policy applies equally to direct cameras and canvas-transformed cameras.
export const CAPTURE_HIDDEN_MESSAGE =
  "Recording stopped because the recording page was closed or navigated away. Available footage is saved on this device.";

export function assertCaptureVisible() {
  // Visibility alone is not an interruption. Camera capture continues while
  // the tab is hidden; pagehide is the explicit leave signal below.
}

export function watchCaptureVisibility(interrupt: () => void) {
  const leaving = () => interrupt();
  window.addEventListener("pagehide", leaving);
  return () => {
    window.removeEventListener("pagehide", leaving);
  };
}
