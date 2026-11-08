import { useEffect, useState } from "react";
import { camera, type CameraReading } from "./CameraMonitor";

/** The latest camera reading, refreshed at most `hz` times per second for React. */
export function useCameraReading(hz = 5): CameraReading {
  const [r, setR] = useState<CameraReading>(camera.last);
  useEffect(() => {
    let last = 0, pending: CameraReading | null = null, timer = 0;
    const off = camera.onReading((x) => {
      const now = performance.now();
      if (now - last >= 1000 / hz) { last = now; setR(x); return; }
      pending = x;
      if (!timer) timer = window.setTimeout(() => { timer = 0; if (pending) { last = performance.now(); setR(pending); pending = null; } }, 1000 / hz);
    });
    return () => { off(); clearTimeout(timer); };
  }, [hz]);
  return r;
}
