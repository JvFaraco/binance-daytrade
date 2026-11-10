// Curvas e tempos de movimento em JS, espelhando tokens.css (definidos uma vez em cada lado).
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];
export const EASE_INOUT: [number, number, number, number] = [0.65, 0, 0.35, 1];
export const T_FAST = 0.12;
export const T_NUM = 0.28;
export const T_PANEL = 0.42;
export const STAGGER = 0.04;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
