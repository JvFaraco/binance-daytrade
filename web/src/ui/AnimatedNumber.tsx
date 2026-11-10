import { memo, useEffect, useRef } from "react";
import { T_NUM, prefersReducedMotion } from "./motion";

interface Props {
  value: number | null | undefined;
  format: (v: number) => string;
  /** texto quando não há valor (carregando ou indisponível) */
  empty?: string;
  /** pisca a casa que mudou na cor do sentido; desligue para valores sem direção */
  flash?: boolean;
  className?: string;
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Número vivo: interpola até o novo valor em ~280 ms em vez de pular, e a casa que mudou pisca
 * de leve em verde (subiu) ou vermelho (caiu). Atualiza o DOM direto: nenhum re-render por quadro.
 */
export const AnimatedNumber = memo(function AnimatedNumber({ value, format, empty = "—", flash = true, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const finalText = useRef<string>("");
  const raf = useRef(0);
  const fmt = useRef(format);

  useEffect(() => {
    fmt.current = format;
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);

    const paint = (text: string, marks: string[] | null) => {
      while (el.childNodes.length > text.length) el.removeChild(el.lastChild as ChildNode);
      while (el.childNodes.length < text.length) el.appendChild(document.createElement("span"));
      for (let i = 0; i < text.length; i++) {
        const span = el.childNodes[i] as HTMLSpanElement;
        if (span.textContent !== text[i]) span.textContent = text[i];
        if (marks) {
          const cls = marks[i] ?? "";
          if (cls) {
            span.className = "";
            void span.offsetWidth; // reinicia a animação
            span.className = cls;
          }
        }
      }
    };

    if (value === null || value === undefined || !Number.isFinite(value)) {
      shown.current = null;
      finalText.current = empty;
      paint(empty, null);
      return;
    }
    const target = value;
    const text = fmt.current(target);
    const from = shown.current;
    const prevText = finalText.current;
    finalText.current = text;
    if (from === null || prefersReducedMotion() || from === target) {
      shown.current = target;
      paint(text, null);
      return;
    }
    let marks: string[] | null = null;
    if (flash && prevText.length === text.length) {
      const cls = target > from ? "up" : "down";
      marks = [];
      for (let i = 0; i < text.length; i++) marks.push(text[i] !== prevText[i] && /\d/.test(text[i]) ? cls : "");
    }
    const t0 = performance.now();
    const dur = T_NUM * 1000;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const v = from + (target - from) * easeOut(k);
      shown.current = v;
      if (k < 1) {
        paint(fmt.current(v), null);
        raf.current = requestAnimationFrame(step);
      } else {
        shown.current = target;
        paint(text, marks);
      }
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // o formatador costuma ser uma função nova a cada render; o efeito só precisa rodar quando o valor muda
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, empty, flash]);

  return <span ref={ref} className={"anum num" + (className ? " " + className : "")} />;
});
