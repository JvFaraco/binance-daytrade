// Formatação pt-BR para a interface. (As mensagens do motor usam a formatação do Python, em engine/py.ts.)
const nf = (min: number, max: number) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: min, maximumFractionDigits: max });
const cache = new Map<string, Intl.NumberFormat>();

function f(min: number, max: number): Intl.NumberFormat {
  const k = min + ":" + max;
  let x = cache.get(k);
  if (!x) {
    x = nf(min, max);
    cache.set(k, x);
  }
  return x;
}

const MINUS = "−";
const sign = (s: string) => s.replace("-", MINUS);

export function num(x: number, decimals = 2): string {
  return sign(f(decimals, decimals).format(x));
}

export function signed(x: number, decimals = 2): string {
  const s = f(decimals, decimals).format(Math.abs(x));
  // zero arredondado não leva sinal
  if (Number(Math.abs(x).toFixed(decimals)) === 0) return s;
  return (x > 0 ? "+" : MINUS) + s;
}

/** Casas decimais de um preço pelo tamanho dele (ou pelo tick do par, se conhecido). */
export function priceDecimals(p: number, tick?: string): number {
  if (tick) {
    const t = tick.replace(/0+$/, "");
    const i = t.indexOf(".");
    return i < 0 ? 0 : t.length - i - 1;
  }
  const a = Math.abs(p);
  if (a >= 1000) return 2;
  if (a >= 10) return 3;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  return 8;
}

export function price(p: number, tick?: string): string {
  const d = priceDecimals(p, tick);
  return f(d, d).format(p);
}

export function pct(x: number, decimals = 2): string {
  return num(x, decimals) + "%";
}

export function signedPct(x: number, decimals = 2): string {
  return signed(x, decimals) + "%";
}

export function rr(x: number, decimals = 2): string {
  return signed(x, decimals) + "R";
}

export function int(x: number): string {
  return f(0, 0).format(x);
}

/** 12,3 M / 1,2 B para volume em USDT */
export function compact(x: number): string {
  if (x >= 1e9) return f(1, 1).format(x / 1e9) + " B";
  if (x >= 1e6) return f(0, 0).format(x / 1e6) + " M";
  if (x >= 1e3) return f(0, 0).format(x / 1e3) + " k";
  return f(0, 0).format(x);
}

const dtf = new Map<string, Intl.DateTimeFormat>();

function d(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = tz + JSON.stringify(opts);
  let x = dtf.get(k);
  if (!x) {
    x = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hourCycle: "h23", ...opts });
    dtf.set(k, x);
  }
  return x;
}

export const TZ = "America/Sao_Paulo";

export function hhmm(ms: number, tz = TZ): string {
  return d(tz, { hour: "2-digit", minute: "2-digit" }).format(ms);
}

export function hhmmss(ms: number, tz = TZ): string {
  return d(tz, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ms);
}

export function ddmm(ms: number, tz = TZ): string {
  return d(tz, { day: "2-digit", month: "2-digit" }).format(ms);
}

export function ddmmyy(ms: number, tz = TZ): string {
  return d(tz, { day: "2-digit", month: "2-digit", year: "2-digit" }).format(ms);
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}` : `${m}min`;
}
