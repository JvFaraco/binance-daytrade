// Componentes base do painel: Panel, Stat, Sparkline, Meter, Badge, Tooltip, LiveDot, Skeleton
// e os controles. Todo painel é montado com eles.
import { m, useReducedMotion } from "framer-motion";
import { type KeyboardEvent, type ReactNode, memo, useId, useState } from "react";
import { AnimatedNumber } from "./AnimatedNumber";
import { EASE_OUT, T_PANEL } from "./motion";
import "./ui.css";

export { AnimatedNumber };
export type Tone = "pos" | "neg" | "raw" | "signal" | "mute" | "neutral";

// ------------------------------------------------------------ LiveDot

export type LiveState = "live" | "busy" | "done" | "idle" | "error";

export function LiveDot({ state, label }: { state: LiveState; label?: string }) {
  return (
    <span className="livedot" data-state={state}>
      <span className="livedot__dot" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

// ------------------------------------------------------------ Panel

interface PanelProps {
  area: string;
  title: string;
  /** subtítulo técnico: o que é calculado e com quê */
  sub?: string;
  /** estado ao vivo, à direita do cabeçalho */
  state?: ReactNode;
  children: ReactNode;
  pad?: boolean;
  /** começa recolhido no celular */
  collapsed?: boolean;
  className?: string;
}

const panelVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: T_PANEL, ease: EASE_OUT } },
};
const panelVariantsStill = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.01 } } };

/** Moldura padrão: título · subtítulo técnico · estado ao vivo. */
export function Panel({ area, title, sub, state, children, pad = false, collapsed = false, className }: PanelProps) {
  const [closed, setClosed] = useState(collapsed);
  const reduce = useReducedMotion();
  const id = useId();
  return (
    <m.section
      className={"panel" + (className ? " " + className : "")}
      style={{ gridArea: area }}
      data-area={area}
      data-collapsed={closed}
      variants={reduce ? panelVariantsStill : panelVariants}
      aria-labelledby={id}
    >
      <header className="panel__head">
        <h2 className="panel__title" id={id}>
          {title}
        </h2>
        <span className="panel__sub" title={sub}>
          {sub}
        </span>
        <div className="panel__state">{state}</div>
        <button type="button" className="panel__toggle" aria-expanded={!closed} aria-label={(closed ? "Expandir " : "Recolher ") + title} onClick={() => setClosed((c) => !c)}>
          {closed ? "+" : "–"}
        </button>
      </header>
      <div className={"panel__body" + (pad ? " panel__body--pad" : "")}>{children}</div>
    </m.section>
  );
}

// ------------------------------------------------------------ Badge

export function Badge({ tone = "neutral", outline = false, children, title }: { tone?: Tone; outline?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className="badge" data-tone={tone} data-outline={outline} title={title}>
      {children}
    </span>
  );
}

// ------------------------------------------------------------ Stat

interface StatProps {
  label: string;
  /** número vivo (com `format`) ou texto pronto */
  value?: number | null;
  format?: (v: number) => string;
  text?: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: Tone;
  size?: "md" | "lg" | "xl";
  flash?: boolean;
}

export const Stat = memo(function Stat({ label, value, format, text, unit, hint, tone = "neutral", size = "md", flash = true }: StatProps) {
  return (
    <div className="stat" data-tone={tone} data-size={size}>
      <span className="label">{label}</span>
      <span className="stat__value">
        {text !== undefined ? <span className="num">{text}</span> : <AnimatedNumber value={value} format={format ?? String} flash={flash} />}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
});

// ------------------------------------------------------------ Skeleton

export function Skeleton({ width = "100%", height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skel" style={{ width, height }} aria-hidden="true" />;
}

export function SkeletonStack({ lines = 4, label = "Carregando" }: { lines?: number; label?: string }) {
  const widths = ["92%", "68%", "84%", "56%", "76%", "88%", "60%", "80%"];
  return (
    <div className="skel-stack" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={widths[i % widths.length]} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------ estados desenhados

interface PanelStateProps {
  kind: "empty" | "loading" | "error" | "limited";
  title: string;
  detail?: ReactNode;
  children?: ReactNode;
}

/** Vazio, carregando, erro e "a API limitou": o mesmo desenho em todo painel. */
export function PanelState({ kind, title, detail, children }: PanelStateProps) {
  return (
    <div className="pstate" data-kind={kind} role={kind === "error" || kind === "limited" ? "alert" : "status"}>
      <span className="pstate__title">{title}</span>
      {detail ? <span className="pstate__detail">{detail}</span> : null}
      {children}
    </div>
  );
}

/** Painel que depende do scanner quando a partida falhou: estado explícito, nunca um esqueleto eterno. */
export function NoData() {
  return <PanelState kind="empty" title="Sem dados" detail="Este painel depende dos dados públicos da Binance, que não carregaram. O motivo está no painel Scanner." />;
}

// ------------------------------------------------------------ Meter

export function Meter({ value, tone = "raw", marks = [], label }: { value: number; tone?: Tone; marks?: number[]; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="meter" data-tone={tone} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <div className="meter__fill" style={{ width: v * 100 + "%" }} />
      {marks.map((m) => (
        <div key={m} className="meter__mark" style={{ left: Math.max(0, Math.min(1, m)) * 100 + "%" }} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------ Sparkline

export const Sparkline = memo(function Sparkline({ data, label, min, max }: { data: number[]; label: string; min?: number; max?: number }) {
  if (data.length < 2) return <svg className="spark" role="img" aria-label={label + ": sem dados ainda"} />;
  const lo = min ?? Math.min(...data);
  const hi = max ?? Math.max(...data);
  const span = hi - lo || 1;
  const d = data.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (data.length - 1)) * 100).toFixed(2)},${(20 - ((v - lo) / span) * 18 - 1).toFixed(2)}`).join("");
  return (
    <svg className="spark" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={d} />
    </svg>
  );
});

// ------------------------------------------------------------ Tooltip

export function Tooltip({ text, side, children }: { text: ReactNode; side?: "right" | "top"; children: ReactNode }) {
  const id = useId();
  return (
    <span className="tip" data-side={side}>
      <span aria-describedby={id} tabIndex={0} style={{ display: "inline-flex", minWidth: 0 }}>
        {children}
      </span>
      <span className="tip__bubble" role="tooltip" id={id}>
        {text}
      </span>
    </span>
  );
}

// ------------------------------------------------------------ Segmented

interface SegmentedProps<T extends string | number> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}

/** Grupo de opções exclusivas; setas mudam a opção, como num grupo de rádio. */
export function Segmented<T extends string | number>({ label, value, options, onChange }: SegmentedProps<T>) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value);
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    const j = (i + dir + options.length) % options.length;
    e.preventDefault();
    onChange(options[j].value);
    const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    btns[j]?.focus();
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} className="seg__opt" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
