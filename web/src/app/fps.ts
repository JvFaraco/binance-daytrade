// Quadros por segundo reais da interface, medidos com requestAnimationFrame.
import { useTelemetry } from "../state/stores";

let started = false;

export function startFpsMeter(): void {
  if (started) return;
  started = true;
  let frames = 0;
  let t0 = performance.now();
  const tick = (t: number) => {
    frames++;
    if (t - t0 >= 1000) {
      const fps = (frames * 1000) / (t - t0);
      frames = 0;
      t0 = t;
      const s = useTelemetry.getState();
      useTelemetry.setState({ fps, fpsHistory: [...s.fpsHistory.slice(-59), fps] });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
