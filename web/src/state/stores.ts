// Estado por assunto, cada um na sua store: um tick do WebSocket não re-renderiza a árvore toda,
// só os componentes que selecionam o pedaço que mudou.
import { create } from "zustand";
import type { RuleTrade } from "../engine/backtest";
import type { Signal } from "../engine/core";
import type { Plan } from "../engine/plan";
import type { RejectionReport } from "../engine/rejections";
import type { ResearchRaw } from "../engine/research";
import type { Check } from "../engine/risk";
import type { ScanResult, UniverseEntry } from "../engine/scan";
import type { Order, Rules } from "../engine/size";
import type { RestTelemetry } from "../data/rest";
import type { StreamStatus } from "../data/stream";
import type { GridResult, HistoryInfo, TimeMachineResult } from "../workers/protocol";

export type Load = "idle" | "loading" | "ready" | "error";

// ---------------------------------------------------------------- mercado (scanner)

export interface MarketState {
  boot: "relógio" | "universo" | "candles" | "pronto" | "erro";
  bootDone: number;
  bootTotal: number;
  error: string | null;
  universe: UniverseEntry[];
  universeAt: number;
  universeCached: boolean;
  results: ScanResult[];
  bySymbol: Record<string, ScanResult>;
  counts: Record<string, number>;
  hits: string[];
  discarded: Array<[string, string]>;
  scanMs: number | null;
  scannedAt: number;
  scans: number;
  /** último preço por par (do fluxo de candles), atualizado no máximo 2x por segundo */
  prices: Record<string, number>;
}

export const useMarket = create<MarketState>(() => ({
  boot: "relógio",
  bootDone: 0,
  bootTotal: 0,
  error: null,
  universe: [],
  universeAt: 0,
  universeCached: false,
  results: [],
  bySymbol: {},
  counts: {},
  hits: [],
  discarded: [],
  scanMs: null,
  scannedAt: 0,
  scans: 0,
  prices: {},
}));

// ---------------------------------------------------------------- pipeline

export type StageId = "scan" | "plan" | "timemachine" | "size" | "risk";
export const STAGES: StageId[] = ["scan", "plan", "timemachine", "size", "risk"];

export interface Stage {
  status: "idle" | "running" | "done" | "error" | "skipped";
  /** tempo real da última execução, em ms */
  ms: number | null;
  note: string;
  /** 0..1 enquanto roda, quando a etapa informa progresso */
  progress: number | null;
  /** quantas vezes terminou: a interface pisca quando muda */
  runs: number;
}

const idle = (): Stage => ({ status: "idle", ms: null, note: "", progress: null, runs: 0 });

export const usePipeline = create<{ stages: Record<StageId, Stage> }>(() => ({
  stages: { scan: idle(), plan: idle(), timemachine: idle(), size: idle(), risk: idle() },
}));

export function setStage(id: StageId, patch: Partial<Stage>): void {
  usePipeline.setState((s) => {
    const cur = s.stages[id];
    const finishing = patch.status && patch.status !== "running" && patch.status !== "idle";
    return { stages: { ...s.stages, [id]: { ...cur, ...patch, runs: finishing ? cur.runs + 1 : cur.runs } } };
  });
}

// ---------------------------------------------------------------- análise do par escolhido

export interface TmState {
  result: TimeMachineResult;
  /** preços de saída em ordem crescente: percentis para qualquer custo sem ordenar de novo */
  sortedExit: Float64Array;
  plan: Plan;
}

export interface AnalysisState {
  history: { status: Load; symbol: string; months: number; done: number; total: number; note: string; info: HistoryInfo | null; error: string | null };
  signal: Signal | null;
  plan: Plan | null;
  /** "live" = rompimento da sessão atual; "replay" = último rompimento do histórico */
  planSource: "live" | "replay" | null;
  /** por que não há plano da sessão atual (mensagem do motor) */
  planNote: string | null;
  tmStatus: Load;
  tmProgress: number;
  tmError: string | null;
  tm: TmState | null;
  rules: Rules | null;
  rulesError: string | null;
  avgPrice: number | null;
  order: Order | null;
  orderError: string | null;
  checks: Check[] | null;
  riskVerdict: "PASS" | "BLOCK" | null;
  grid: { status: Load; done: number; total: number; result: GridResult | null; error: string | null; ms: number | null; symbol: string; months: number };
  research: { status: Load; raw: ResearchRaw | null; error: string | null; ms: number | null };
  /** a regra com os controles atuais em todas as sessões do período (para o bruto x líquido) */
  breakout: { status: Load; trades: RuleTrade[] | null; sessions: number };
  rejections: { status: Load; report: RejectionReport | null };
}

export const useAnalysis = create<AnalysisState>(() => ({
  history: { status: "idle", symbol: "", months: 0, done: 0, total: 0, note: "", info: null, error: null },
  signal: null,
  plan: null,
  planSource: null,
  planNote: null,
  tmStatus: "idle",
  tmProgress: 0,
  tmError: null,
  tm: null,
  rules: null,
  rulesError: null,
  avgPrice: null,
  order: null,
  orderError: null,
  checks: null,
  riskVerdict: null,
  grid: { status: "idle", done: 0, total: 0, result: null, error: null, ms: null, symbol: "", months: 0 },
  research: { status: "idle", raw: null, error: null, ms: null },
  breakout: { status: "idle", trades: null, sessions: 0 },
  rejections: { status: "idle", report: null },
}));

// ---------------------------------------------------------------- telemetria real

export interface TelemetryState {
  rest: RestTelemetry | null;
  wsStatus: StreamStatus;
  wsHost: string;
  /** mediana do último segundo, em ms */
  wsLatency: number | null;
  wsLatencyHistory: number[];
  wsRate: number;
  /** candles de 5m em memória: sessão dos pares do scanner + histórico do par */
  sessionCandles: number;
  /** último trabalho do worker */
  workerMs: number | null;
  workerJob: string;
  fps: number | null;
  fpsHistory: number[];
  clockOffset: number;
}

export const useTelemetry = create<TelemetryState>(() => ({
  rest: null,
  wsStatus: "conectando",
  wsHost: "",
  wsLatency: null,
  wsLatencyHistory: [],
  wsRate: 0,
  sessionCandles: 0,
  workerMs: null,
  workerJob: "",
  fps: null,
  fpsHistory: [],
  clockOffset: 0,
}));

/** Versão da fita e do candle em formação: os desenhos em canvas leem os dados direto de live.ts. */
export const useTicks = create<{ tape: number; bars: number }>(() => ({ tape: 0, bars: 0 }));
