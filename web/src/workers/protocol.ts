// Mensagens entre a interface e o worker do motor.
import type { Combo, ComboTrades } from "../engine/backtest";
import type { Config } from "../engine/core";
import type { Plan } from "../engine/plan";
import type { RejectionReport } from "../engine/rejections";
import type { ResearchRaw } from "../engine/research";
import type { Ticker } from "../engine/scan";
import type { ExchangeInfo } from "../engine/size";
import type { HistoryTrade } from "../engine/timemachine";
import type { RestTelemetry } from "../data/rest";
import type { SphereBuffers } from "../sphere/geometry";
import type { Rules } from "../engine/size";

export type Request =
  | { type: "time" }
  | { type: "tickers"; quote: string; ttlMinutes: number; refresh?: boolean }
  | { type: "sessionBars"; symbols: string[]; limit: number }
  | { type: "exchangeInfo"; symbol: string }
  | { type: "avgPrice"; symbol: string }
  | { type: "history"; symbol: string; months: number; now: number }
  | { type: "lastBreakout"; symbol: string; cfg: Config; stopRule: string; targetR: number; before: number }
  | { type: "timemachine"; symbol: string; plan: Plan; tmNow: number; days: number; replays: number; seed: number; window: number; maxDraw: number }
  | { type: "grid"; symbol: string; entryBufferPct: number; combos: Combo[]; split: number; entryWindow: number; flatBy: number; maxChase: number }
  | { type: "research"; symbol: string; lookbacks: number[]; buyH: number; sellH: number }
  | { type: "rejections"; symbol: string; cfg: Config; stopRule: string; targetR: number; rules: Rules | null };

export interface TimeResult {
  /** relógio da Binance menos o relógio local, em ms */
  offset: number;
  roundTripMs: number;
}

export interface TickersResult {
  tickers: Ticker[];
  /** quando a lista foi buscada na API */
  at: number;
  fromCache: boolean;
}

export interface SessionBarsResult {
  /** por símbolo: candles compactados (ver data/pack.ts) ou a mensagem de erro */
  bars: Record<string, Float64Array>;
  errors: Record<string, string>;
}

export interface HistoryInfo {
  symbol: string;
  months: number;
  candles: number;
  first: number;
  last: number;
  cached: number;
  fetched: number;
  requests: number;
}

export interface TimeMachineResult {
  sessions: number;
  /** janela usada: [de, até) */
  from: number;
  to: number;
  replays: number;
  seed: number;
  window: number;
  entry: number;
  stop: number;
  target: number;
  exit: Float64Array;
  outcome: Uint8Array;
  len: Uint16Array;
  pathLen: number;
  history: HistoryTrade[];
  sphere: SphereBuffers;
  /** tempo só dos replays, em ms */
  mcMs: number;
}

export interface GridResult {
  combos: ComboTrades[];
  candles: number;
  first: number;
  last: number;
}

export interface ResponseMap {
  time: TimeResult;
  tickers: TickersResult;
  sessionBars: SessionBarsResult;
  exchangeInfo: ExchangeInfo;
  avgPrice: number;
  history: HistoryInfo;
  lastBreakout: Plan | null;
  timemachine: TimeMachineResult;
  grid: GridResult;
  research: ResearchRaw;
  rejections: RejectionReport;
}

export interface Progress {
  done: number;
  total: number;
  note?: string;
}

export type WorkerOut =
  | { id: number; kind: "progress"; progress: Progress }
  | { id: number; kind: "result"; data: unknown; ms: number }
  | { id: number; kind: "error"; message: string; status?: number; name: string }
  | { id: -1; kind: "telemetry"; rest: RestTelemetry };

export interface WorkerIn {
  id: number;
  req: Request;
}
