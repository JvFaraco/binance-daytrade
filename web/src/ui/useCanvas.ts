import { useEffect, useRef } from "react";

export type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/**
 * Canvas que acompanha o tamanho do contêiner e a densidade de pixels. `draw` roda no próximo
 * quadro quando `deps` mudam ou o tamanho muda; nunca mais de uma vez por quadro.
 */
export function useCanvas(draw: Draw, deps: ReadonlyArray<unknown>) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  const raf = useRef(0);
  const schedule = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const paint = () => {
      raf.current = 0;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawRef.current(ctx, w, h);
    };
    schedule.current = () => {
      if (!raf.current) raf.current = requestAnimationFrame(paint);
    };
    const ro = new ResizeObserver(() => schedule.current());
    ro.observe(canvas);
    schedule.current();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, []);

  useEffect(() => {
    drawRef.current = draw;
    schedule.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

let tokenCache: Record<string, string> | null = null;

/** Cores dos tokens CSS para desenhar em canvas. */
export function tokens(): Record<string, string> {
  if (tokenCache) return tokenCache;
  const cs = getComputedStyle(document.documentElement);
  const get = (n: string) => cs.getPropertyValue(n).trim();
  tokenCache = {
    bg0: get("--bg-0"),
    bg1: get("--bg-1"),
    bg2: get("--bg-2"),
    bg3: get("--bg-3"),
    line1: get("--line-1"),
    line2: get("--line-2"),
    tx1: get("--tx-1"),
    tx2: get("--tx-2"),
    tx3: get("--tx-3"),
    signal: get("--signal"),
    pos: get("--pos"),
    neg: get("--neg"),
    raw: get("--raw"),
    font: get("--font"),
  };
  return tokenCache;
}

export function alpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
