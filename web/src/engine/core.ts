// Porte de scripts/core.py: sinal de rompimento da faixa inicial, custos e tempo.
// Os nomes dos campos seguem o Python (snake_case) para os testes de paridade compararem direto.
import { fixedHalfEven, floorDiv } from "./py";

export const IV = 300000; // candles de 5 minutos, em ms
export const INTERVAL = "5m";
export const DAY = 86400000;
export const HOUR = 3600000;

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type StopRule = "or-mid" | "or-low";
export type EntryMode = "otoco" | "two-step";

export interface Config {
  paper: boolean;
  quote: string;
  anchor_utc: string;
  range_minutes: number;
  entry_window_minutes: number;
  flat_by_hours: number;
  min_quote_volume: number;
  min_range_pct: number;
  universe_cache_minutes: number;
  exclude_bases: string[];
  max_chase_pct: number;
  account: number;
  max_loss_per_trade: number;
  max_position_pct: number;
  daily_loss_limit: number;
  max_trades_per_day: number;
  min_reward_risk: number;
  fee_pct: number;
  fee_in_bnb: boolean;
  entry_mode: EntryMode;
  slippage_pct: number;
  entry_buffer_pct: number;
  stop_limit_buffer_pct: number;
  max_signal_age_minutes: number;
  display_tz: string;
}

/** Os mesmos padrões de core.DEFAULTS. */
export const DEFAULTS: Config = {
  paper: true,
  quote: "USDT",
  anchor_utc: "13:00",
  range_minutes: 60,
  entry_window_minutes: 240,
  flat_by_hours: 8,
  min_quote_volume: 20000000,
  min_range_pct: 1.0,
  universe_cache_minutes: 30,
  exclude_bases: [],
  max_chase_pct: 1.0,
  account: 1000,
  max_loss_per_trade: 10,
  max_position_pct: 50,
  daily_loss_limit: 30,
  max_trades_per_day: 3,
  min_reward_risk: 1.0,
  fee_pct: 0.1,
  fee_in_bnb: false,
  entry_mode: "otoco",
  slippage_pct: 0.05,
  entry_buffer_pct: 0.1,
  stop_limit_buffer_pct: 0.3,
  max_signal_age_minutes: 15,
  display_tz: "America/Sao_Paulo",
};

/** Parâmetros de sessão: o que orb_signal lê do config (e o que o plano guarda em "params"). */
export interface SessionParams {
  anchor_utc: string;
  range_minutes: number;
  entry_window_minutes: number;
  flat_by_hours: number;
}

export class TraderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraderError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------- candles

/** Timestamps em microssegundos (arquivos mensais da Binance desde 2025) viram milissegundos. */
export function normTs(t: number | string): number {
  const n = Math.trunc(Number(t));
  return n > 1e14 ? Math.floor(n / 1000) : n;
}

export type KlineRow = ReadonlyArray<number | string>;

export function parseKlines(rows: ReadonlyArray<KlineRow>): Bar[] {
  const out: Bar[] = rows.map((r) => ({
    t: normTs(r[0]),
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: r.length > 7 ? Number(r[7]) : Number(r[5]),
  }));
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function closedOnly(bars: ReadonlyArray<Bar>, nowMs: number): Bar[] {
  return bars.filter((b) => b.t + IV <= nowMs);
}

// ---------------------------------------------------------------- tempo

export function parseHHMM(s: string): number {
  const [h, m] = String(s).split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

export function sessionStart(tsMs: number, anchor: string): number {
  const day = floorDiv(tsMs, DAY) * DAY;
  const a = day + parseHHMM(anchor) * 60000;
  return tsMs >= a ? a : a - DAY;
}

/** '2026-11-02 13:05' (UTC) -> ms */
export function utcMs(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new TraderError("data inválida: " + text);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

export function todayUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** "dd/mm HH:MM BRT" no fuso pedido (como core.fmt_ts). */
export function fmtTs(ms: number, tz = "America/Sao_Paulo"): string {
  let f = fmtCache.get(tz);
  let label = tz === "America/Sao_Paulo" ? "BRT" : tz;
  try {
    if (!f) {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      fmtCache.set(tz, f);
    }
  } catch {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    label = "UTC";
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.day}/${p.month} ${p.hour}:${p.minute} ${label}`;
}

// ---------------------------------------------------------------- sinal

export type SignalStatus = "forming" | "nodata" | "waiting" | "triggered" | "expired";

export interface Trigger {
  time: number;
  bar_t: number;
  slot: number;
  close: number;
  pct_over: number;
}

export interface Signal {
  status: SignalStatus;
  session_start: number;
  range_end: number;
  window_end: number;
  flat_by: number;
  trigger: Trigger | null;
  range_high?: number;
  range_low?: number;
  range_mid?: number;
  range_pct?: number;
}

/**
 * Rompimento da faixa inicial da sessão (só compra, spot).
 * bars: candles de 5m FECHADOS, em ordem.
 */
export function orbSignal(bars: ReadonlyArray<Bar>, nowMs: number, cfg: SessionParams, session?: number): Signal {
  const s = session !== undefined ? session : sessionStart(nowMs, cfg.anchor_utc);
  const rngEnd = s + Math.trunc(cfg.range_minutes) * 60000;
  const winEnd = rngEnd + Math.trunc(cfg.entry_window_minutes) * 60000;
  const flat = s + Math.trunc(Number(cfg.flat_by_hours) * HOUR);
  const out: Signal = { status: "forming", session_start: s, range_end: rngEnd, window_end: winEnd, flat_by: flat, trigger: null };
  if (nowMs < rngEnd) return out;
  const nRng = floorDiv(Math.trunc(cfg.range_minutes) * 60000, IV);
  let hi = -Infinity;
  let lo = Infinity;
  let count = 0;
  for (const b of bars) {
    if (b.t >= s && b.t < rngEnd) {
      count++;
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
  }
  if (count < nRng) {
    out.status = "nodata";
    return out;
  }
  out.range_high = hi;
  out.range_low = lo;
  out.range_mid = (hi + lo) / 2;
  out.range_pct = ((hi - lo) / lo) * 100;
  const limit = Math.min(winEnd, flat);
  for (const b of bars) {
    if (b.t < rngEnd || b.t >= limit) continue;
    if (b.t + IV > nowMs) break;
    if (b.c > hi) {
      out.trigger = { time: b.t + IV, bar_t: b.t, slot: floorDiv(b.t - s, IV), close: b.c, pct_over: ((b.c - hi) / hi) * 100 };
      out.status = "triggered";
      return out;
    }
  }
  out.status = nowMs >= limit ? "expired" : "waiting";
  return out;
}

export function stopPrice(sig: { range_mid?: number; range_low?: number }, rule: string): number {
  if (rule === "or-mid") return sig.range_mid as number;
  if (rule === "or-low") return sig.range_low as number;
  throw new TraderError(`regra de stop desconhecida: ${rule} (use or-mid ou or-low)`);
}

export function parseTargetR(text: string | number): number {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*[rR]?\s*$/.exec(String(text));
  if (!m || Number(m[1]) <= 0) throw new TraderError(`alvo invalido: '${text}' (use por exemplo 1R ou 1.5R)`);
  return Number(m[1]);
}

// ---------------------------------------------------------------- custos

/** Custo (taxa + slippage) de comprar em entry e vender em exit, por unidade. */
export function roundTripCost(entry: number, exit: number, feePct: number, slipPct: number): number {
  return ((entry + exit) * (feePct + slipPct)) / 100.0;
}

export function netR(entry: number, exit: number, stop: number, feePct: number, slipPct: number): number {
  const risk = entry - stop;
  return (exit - entry - roundTripCost(entry, exit, feePct, slipPct)) / risk;
}

export function lossPerUnit(entry: number, stop: number, feePct: number, slipPct: number): number {
  return entry - stop + roundTripCost(entry, stop, feePct, slipPct);
}

/** "%.nf%%" usado nas mensagens. */
export function pct(x: number, n: number): string {
  return fixedHalfEven(x, n) + "%";
}
