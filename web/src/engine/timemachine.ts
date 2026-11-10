// Porte de scripts/timemachine.py: reexecuta o plano N vezes sorteando candles de 5m do mesmo
// horário da sessão (± janela) e também em cada sessão passada real. Custos entram no R.
//
// Fiel ao Python: mesma semente -> mesmos sorteios (PyRandom) -> mesmas contagens e mesmo R médio.
// Extra para o painel: os replays também devolvem o preço de saída e o caminho de cada um. Isso
// não consome números aleatórios a mais nem muda o resultado agregado.
import { type Bar, type SessionParams, IV, HOUR, netR, orbSignal, roundTripCost, sessionStart, stopPrice } from "./core";
import type { Plan } from "./plan";
import { fixedHalfEven, floorDiv, fmtG, pyRoundInt, pySum } from "./py";
import { PyRandom } from "./pyrandom";

export interface Session {
  s: number;
  bars: Bar[];
}

export interface Costs {
  fee_pct: number;
  slippage_pct: number;
}

function sessionsBySlot(bars: ReadonlyArray<Bar>, anchor: string, n: number): Map<number, Array<Bar | undefined>> {
  const by = new Map<number, Array<Bar | undefined>>();
  for (const b of bars) {
    const s = sessionStart(b.t, anchor);
    const slot = floorDiv(b.t - s, IV);
    if (slot < n) {
      let row = by.get(s);
      if (!row) {
        row = new Array<Bar | undefined>(n).fill(undefined);
        by.set(s, row);
      }
      row[slot] = b;
    }
  }
  return by;
}

/** Sessões completas (todos os candles de 5m entre a âncora e o horário de zerar), em ordem. */
export function completeSessions(bars: ReadonlyArray<Bar>, anchor: string, flatByHours: number, beforeMs = Infinity): Session[] {
  const n = Math.trunc(Number(flatByHours) * 12);
  const by = sessionsBySlot(bars, anchor, n);
  const out: Session[] = [];
  for (const s of [...by.keys()].sort((a, b) => a - b)) {
    const row = by.get(s) as Array<Bar | undefined>;
    if (s < beforeMs && row.every((b) => b !== undefined)) out.push({ s, bars: row as Bar[] });
  }
  return out;
}

/** Sessões passadas com todos os candles de 5m entre o início e o horário de zerar. */
export function fullSessions(bars: ReadonlyArray<Bar>, params: SessionParams, beforeMs: number): Session[] {
  return completeSessions(bars, params.anchor_utc, params.flat_by_hours, beforeMs);
}

/**
 * Para cada slot, as razões (o, h, l, c) / fechamento anterior dos candles daquele slot e dos
 * vizinhos (± window), concatenadas na mesma ordem do Python. 4 números por candle.
 */
export function buildPool(sessions: ReadonlyArray<Session>, n: number, window: number): Float64Array[] {
  const per = sessions.length;
  const ratios: Float64Array[] = [new Float64Array(0)];
  for (let i = 1; i < n; i++) {
    const a = new Float64Array(per * 4);
    for (let k = 0; k < per; k++) {
      const bars = sessions[k].bars;
      const pc = bars[i - 1].c;
      const b = bars[i];
      a[k * 4] = b.o / pc;
      a[k * 4 + 1] = b.h / pc;
      a[k * 4 + 2] = b.l / pc;
      a[k * 4 + 3] = b.c / pc;
    }
    ratios.push(a);
  }
  const merged: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(1, i - window);
    const hi = Math.min(n - 1, i + window);
    let len = 0;
    for (let k = lo; k <= hi; k++) len += ratios[k].length;
    const m = new Float64Array(len);
    let off = 0;
    for (let k = lo; k <= hi; k++) {
      m.set(ratios[k], off);
      off += ratios[k].length;
    }
    merged.push(m);
  }
  return merged;
}

export function percentile(sortedVals: ArrayLike<number>, p: number): number | null {
  const n = sortedVals.length;
  if (!n) return null;
  const i = Math.min(n - 1, Math.max(0, pyRoundInt((p / 100.0) * (n - 1))));
  return sortedVals[i];
}

export interface McResult {
  replays: number;
  seed: number;
  counts: { target: number; stop: number; open: number };
  pct: { target: number; stop: number; open: number };
  green_pct: number;
  avg_net_r: number;
  open_p5: number | null;
  open_p50: number | null;
  open_p95: number | null;
}

export const OUTCOME_TARGET = 0;
export const OUTCOME_STOP = 1;
export const OUTCOME_OPEN = 2;

/** Os replays crus: o que não depende de custo. O R líquido sai daqui para qualquer taxa. */
export interface McRaw {
  replays: number;
  seed: number;
  entry: number;
  stop: number;
  target: number;
  /** preço de saída de cada replay */
  exit: Float64Array;
  /** 0 alvo, 1 stop, 2 aberto até zerar */
  outcome: Uint8Array;
  /** pontos válidos do caminho de cada replay (1 = só a entrada) */
  len: Uint16Array;
  /** pontos por caminho: do slot da entrada até o último da sessão */
  pathLen: number;
  /** R bruto (sem custo) em cada ponto: replays * pathLen. Só existe se pedido. */
  paths: Float32Array | null;
}

export interface McOptions {
  recordPaths?: boolean;
  /** chamado a cada bloco de replays com a fração concluída */
  onProgress?: (done: number, total: number) => void;
  progressEvery?: number;
}

/** Roda os replays. Mesma ordem de sorteio do run_mc do Python. */
export function runMcRaw(plan: Plan, sessions: ReadonlyArray<Session>, replays: number, seed: number, window: number, opts: McOptions = {}): McRaw {
  const n = Math.trunc(Number(plan.params.flat_by_hours) * 12);
  const pool = buildPool(sessions, n, window);
  const rng = new PyRandom(seed);
  const { entry, stop, target } = plan;
  const e = Math.trunc(plan.entry_slot);
  const risk = entry - stop;
  const pathLen = Math.max(1, n - e);
  const exit = new Float64Array(replays);
  const outcome = new Uint8Array(replays);
  const len = new Uint16Array(replays);
  const paths = opts.recordPaths ? new Float32Array(replays * pathLen) : null;
  const every = opts.progressEvery ?? 500;
  for (let i = 0; i < replays; i++) {
    let price = entry;
    let out = OUTCOME_OPEN;
    let exitP = 0;
    const base = i * pathLen;
    let j = 1;
    for (let slot = e + 1; slot < n; slot++, j++) {
      const p = pool[slot];
      const k = rng.randbelow(p.length >> 2) << 2;
      if (price * p[k + 2] <= stop) {
        // toca nos dois no mesmo candle: conta como stop
        out = OUTCOME_STOP;
        exitP = stop;
        if (paths) paths[base + j] = -1;
        j++;
        break;
      }
      if (price * p[k + 1] >= target) {
        out = OUTCOME_TARGET;
        exitP = target;
        if (paths) paths[base + j] = (target - entry) / risk;
        j++;
        break;
      }
      price *= p[k + 3];
      if (paths) paths[base + j] = (price - entry) / risk;
    }
    if (out === OUTCOME_OPEN) exitP = price;
    exit[i] = exitP;
    outcome[i] = out;
    len[i] = j;
    if (opts.onProgress && (i + 1) % every === 0) opts.onProgress(i + 1, replays);
  }
  if (opts.onProgress) opts.onProgress(replays, replays);
  return { replays, seed, entry, stop, target, exit, outcome, len, pathLen, paths };
}

/** O mesmo dicionário que run_mc devolve, para uma taxa e um slippage. */
export function summarizeMc(raw: McRaw, cfg: Costs): McResult {
  const { replays, entry, stop } = raw;
  const counts = { target: 0, stop: 0, open: 0 };
  const rs = new Float64Array(replays);
  const open: number[] = [];
  let green = 0;
  for (let i = 0; i < replays; i++) {
    const o = raw.outcome[i];
    const x = raw.exit[i];
    if (o === OUTCOME_TARGET) counts.target++;
    else if (o === OUTCOME_STOP) counts.stop++;
    else {
      counts.open++;
      open.push(x);
    }
    if (o === OUTCOME_TARGET || (o === OUTCOME_OPEN && x > entry)) green++;
    rs[i] = netR(entry, x, stop, cfg.fee_pct, cfg.slippage_pct);
  }
  const sorted = Float64Array.from(open).sort();
  return {
    replays,
    seed: raw.seed,
    counts,
    pct: { target: (counts.target / replays) * 100, stop: (counts.stop / replays) * 100, open: (counts.open / replays) * 100 },
    green_pct: (green / replays) * 100,
    avg_net_r: pySum(rs) / rs.length,
    open_p5: percentile(sorted, 5),
    open_p50: percentile(sorted, 50),
    open_p95: percentile(sorted, 95),
  };
}

export function runMc(plan: Plan, sessions: ReadonlyArray<Session>, cfg: Costs, replays: number, seed: number, window: number): McResult {
  return summarizeMc(runMcRaw(plan, sessions, replays, seed, window), cfg);
}

/** Estatísticas do painel para um custo qualquer, sem refazer os sorteios. */
export interface McCostStats {
  /** % de replays com R líquido > 0 */
  win_pct: number;
  avg_net_r: number;
  p5: number;
  p50: number;
  p95: number;
  /** maior queda da soma de R líquido, na ordem dos replays */
  max_dd_r: number;
  /** custo de ida e volta no alvo e no stop, em R */
  cost_r_target: number;
  cost_r_stop: number;
}

export function mcCostStats(raw: McRaw, sortedExit: Float64Array, cfg: Costs): McCostStats {
  const { replays, entry, stop, target } = raw;
  const risk = entry - stop;
  const rs = new Float64Array(replays);
  let wins = 0;
  let run = 0;
  let peak = 0;
  let dd = 0;
  for (let i = 0; i < replays; i++) {
    const r = netR(entry, raw.exit[i], stop, cfg.fee_pct, cfg.slippage_pct);
    rs[i] = r;
    if (r > 0) wins++;
    run += r;
    if (run > peak) peak = run;
    if (run - peak < dd) dd = run - peak;
  }
  const at = (p: number) => netR(entry, percentile(sortedExit, p) as number, stop, cfg.fee_pct, cfg.slippage_pct);
  return {
    win_pct: (wins / replays) * 100,
    avg_net_r: pySum(rs) / replays,
    p5: at(5),
    p50: at(50),
    p95: at(95),
    max_dd_r: dd,
    cost_r_target: roundTripCost(entry, target, cfg.fee_pct, cfg.slippage_pct) / risk,
    cost_r_stop: roundTripCost(entry, stop, cfg.fee_pct, cfg.slippage_pct) / risk,
  };
}

export interface HistoryTrade {
  s: number;
  entry: number;
  exit: number;
  stop: number;
  outcome: number;
}

/** Cada sessão passada em que a regra do plano disparou, com a saída real. */
export function historyTrades(plan: Plan, sessions: ReadonlyArray<Session>): HistoryTrade[] {
  const params = plan.params;
  const out: HistoryTrade[] = [];
  for (const { s, bars } of sessions) {
    const sig = orbSignal(bars, s + Math.trunc(Number(params.flat_by_hours) * HOUR), params, s);
    if (sig.status !== "triggered" || !sig.trigger) continue;
    const t = sig.trigger;
    const entry = t.close;
    const stop = stopPrice(sig, plan.stop_rule);
    const target = entry + plan.target_r * (entry - stop);
    let outcome = OUTCOME_OPEN;
    let exit = bars[bars.length - 1].c;
    for (let i = t.slot + 1; i < bars.length; i++) {
      const b = bars[i];
      if (b.l <= stop) {
        outcome = OUTCOME_STOP;
        exit = stop;
        break;
      }
      if (b.h >= target) {
        outcome = OUTCOME_TARGET;
        exit = target;
        break;
      }
    }
    out.push({ s, entry, exit, stop, outcome });
  }
  return out;
}

export interface HistoryResult {
  sessions: number;
  fired: number;
  target: number;
  stop: number;
  open: number;
  avg_net_r: number | null;
}

export function summarizeHistory(nSessions: number, trades: ReadonlyArray<HistoryTrade>, cfg: Costs): HistoryResult {
  const out: HistoryResult = { sessions: nSessions, fired: trades.length, target: 0, stop: 0, open: 0, avg_net_r: null };
  const nr: number[] = [];
  for (const t of trades) {
    if (t.outcome === OUTCOME_TARGET) out.target++;
    else if (t.outcome === OUTCOME_STOP) out.stop++;
    else out.open++;
    nr.push(netR(t.entry, t.exit, t.stop, cfg.fee_pct, cfg.slippage_pct));
  }
  out.avg_net_r = nr.length ? pySum(nr) / nr.length : null;
  return out;
}

export function runHistory(plan: Plan, sessions: ReadonlyArray<Session>, cfg: Costs): HistoryResult {
  return summarizeHistory(sessions.length, historyTrades(plan, sessions), cfg);
}

/** Uma linha honesta. Olha só os replays que bateram em um dos lados. */
export function verdict(mc: { counts: { target: number; stop: number; open: number } }, plan: Pick<Plan, "entry" | "stop" | "target" | "target_r">, cfg: Costs): string {
  const c = mc.counts;
  const sides = c.target + c.stop;
  if (sides === 0) return "Sem dados suficientes: nenhum replay bateu no alvo nem no stop.";
  const r = plan.target_r;
  const { entry, stop, target } = plan;
  const risk = entry - stop;
  const cw = roundTripCost(entry, target, cfg.fee_pct, cfg.slippage_pct) / risk;
  const cl = roundTripCost(entry, stop, cfg.fee_pct, cfg.slippage_pct) / risk;
  if (r - cw <= 0) {
    return `Impossível empatar: taxa e slippage de ida e volta custam ${fixedHalfEven(cw, 2)}R, mais que o ganho do alvo (${fmtG(r)}R). A faixa é estreita demais pro custo.`;
  }
  const breakeven = (1 + cl) / (r - cw + 1 + cl);
  const p = c.target / sides;
  const d = (p - breakeven) * 100;
  const base = `alvo veio primeiro em ${fixedHalfEven(p * 100, 0)}% dos que bateram num lado; precisa de ${fixedHalfEven(breakeven * 100, 0)}% para empatar depois das taxas`;
  if (Math.abs(d) < 5) return "Perto de empate: " + base;
  if (d > 0) return (d < 15 ? "Pende para o alvo: " : "Forte para o alvo: ") + base;
  return (d > -15 ? "Pende para o stop: " : "Forte para o stop: ") + base;
}

/** Fração de acerto (entre os que bateram num lado) que empata depois das taxas; null se impossível. */
export function breakevenPct(plan: Pick<Plan, "entry" | "stop" | "target" | "target_r">, cfg: Costs): number | null {
  const risk = plan.entry - plan.stop;
  const cw = roundTripCost(plan.entry, plan.target, cfg.fee_pct, cfg.slippage_pct) / risk;
  const cl = roundTripCost(plan.entry, plan.stop, cfg.fee_pct, cfg.slippage_pct) / risk;
  if (plan.target_r - cw <= 0) return null;
  return ((1 + cl) / (plan.target_r - cw + 1 + cl)) * 100;
}
