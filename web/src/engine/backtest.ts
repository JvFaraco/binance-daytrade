// Porte de scripts/backtest.py: a regra de rompimento em meses de dados, com custos,
// treino e teste separados. O número que vale é o do teste.
import { type Bar, type Config, type SessionParams, type Signal, HOUR, netR, orbSignal, stopPrice } from "./core";
import { pyRound, pySum } from "./py";
import { type Costs, type Session, completeSessions } from "./timemachine";

export interface Combo {
  anchor_utc: string;
  range_minutes: number;
  stop_rule: string;
  target_r: number;
  min_range_pct: number;
}

export interface RuleSummary {
  trades: number;
  sum_r: number;
  avg_r: number | null;
  win_pct: number | null;
  max_dd_r: number;
}

export interface ComboResult {
  params: Combo;
  train: RuleSummary;
  test: RuleSummary;
  sessions: [number, number];
}

/** Um trade da regra: o que não depende de custo. */
export interface RuleTrade {
  s: number;
  entry: number;
  exit: number;
  stop: number;
}

export function sessionsFor(bars: ReadonlyArray<Bar>, anchor: string, flatByHours: number): Session[] {
  return completeSessions(bars, anchor, flatByHours);
}

type SignalFn = (s: Session) => Signal;

function signalFor(params: SessionParams): SignalFn {
  const flatMs = Math.trunc(Number(params.flat_by_hours) * HOUR);
  return ({ s, bars }) => orbSignal(bars, s + flatMs, params, s);
}

/** Os trades da regra em cada sessão (entrada com o buffer do limite de compra, como no size.py). */
export function ruleTrades(
  sessions: ReadonlyArray<Session>,
  params: SessionParams,
  entryBufferPct: number,
  stopRule: string,
  targetR: number,
  minRangePct: number,
  maxChasePct: number,
  signal: SignalFn = signalFor(params),
): RuleTrade[] {
  const out: RuleTrade[] = [];
  for (const sess of sessions) {
    const sig = signal(sess);
    if (sig.status !== "triggered" || !sig.trigger) continue;
    if ((sig.range_pct as number) < minRangePct || sig.trigger.pct_over > maxChasePct) continue;
    const t = sig.trigger;
    const entry = t.close * (1 + entryBufferPct / 100.0);
    const stop = stopPrice(sig, stopRule);
    if (stop >= entry) continue;
    const target = entry + targetR * (entry - stop);
    const bars = sess.bars;
    let exit = bars[bars.length - 1].c;
    for (let i = t.slot + 1; i < bars.length; i++) {
      const b = bars[i];
      if (b.l <= stop) {
        exit = stop;
        break;
      }
      if (b.h >= target) {
        exit = target;
        break;
      }
    }
    out.push({ s: sess.s, entry, exit, stop });
  }
  return out;
}

export function tradesNetR(trades: ReadonlyArray<RuleTrade>, cfg: Costs): number[] {
  return trades.map((t) => netR(t.entry, t.exit, t.stop, cfg.fee_pct, cfg.slippage_pct));
}

/** Devolve a lista de R líquidos, um por trade. */
export function runRule(
  sessions: ReadonlyArray<Session>,
  params: SessionParams,
  cfg: Pick<Config, "fee_pct" | "slippage_pct" | "entry_buffer_pct">,
  stopRule: string,
  targetR: number,
  minRangePct: number,
  maxChasePct: number,
): number[] {
  return tradesNetR(ruleTrades(sessions, params, cfg.entry_buffer_pct, stopRule, targetR, minRangePct, maxChasePct), cfg);
}

export function summarize(rs: ReadonlyArray<number>): RuleSummary {
  if (!rs.length) return { trades: 0, sum_r: 0.0, avg_r: null, win_pct: null, max_dd_r: 0.0 };
  let peak = 0.0;
  let run = 0.0;
  let dd = 0.0;
  let wins = 0;
  for (const r of rs) {
    run += r;
    peak = Math.max(peak, run);
    dd = Math.min(dd, run - peak);
    if (r > 0) wins++;
  }
  const total = pySum(rs);
  return {
    trades: rs.length,
    sum_r: pyRound(total, 2),
    avg_r: pyRound(total / rs.length, 3),
    win_pct: pyRound((wins / rs.length) * 100, 1),
    max_dd_r: pyRound(dd, 2),
  };
}

/** itertools.product na mesma ordem do Python: âncora por fora, faixa mínima por dentro. */
export function grid(anchors: string[], ranges: number[], stops: string[], targets: number[], minRanges: number[]): Combo[] {
  const out: Combo[] = [];
  for (const a of anchors)
    for (const rg of ranges)
      for (const st of stops)
        for (const tg of targets) for (const mr of minRanges) out.push({ anchor_utc: a, range_minutes: rg, stop_rule: st, target_r: tg, min_range_pct: mr });
  return out;
}

/** A grade padrão do backtest.py (96 combinações). */
export const DEFAULT_GRID = {
  anchors: ["00:00", "13:00"],
  ranges: [30, 60],
  stops: ["or-mid", "or-low"],
  targets: [1, 1.5, 2, 3],
  minRanges: [0.5, 1.0, 1.5],
};

export interface ComboTrades {
  params: Combo;
  train: RuleTrade[];
  test: RuleTrade[];
  sessions: [number, number];
}

/**
 * Os trades de cada combinação no treino e no teste. O sinal de cada sessão só depende da
 * âncora e da largura da faixa, então é calculado uma vez e reaproveitado (mesmo resultado).
 */
export function evaluateTrades(
  bars: ReadonlyArray<Bar>,
  entryBufferPct: number,
  combos: ReadonlyArray<Combo>,
  split: number,
  entryWindow: number,
  flatBy: number,
  maxChase: number,
  onCombo?: (index: number, result: ComboTrades) => void,
): ComboTrades[] {
  const results: ComboTrades[] = [];
  const cache = new Map<string, [Session[], Session[]]>();
  const sigCache = new Map<string, Map<number, Signal>>();
  combos.forEach((c, index) => {
    const key = c.anchor_utc;
    let pair = cache.get(key);
    if (!pair) {
      const ss = sessionsFor(bars, c.anchor_utc, flatBy);
      const cut = Math.trunc(ss.length * split);
      pair = [ss.slice(0, cut), ss.slice(cut)];
      cache.set(key, pair);
    }
    const [train, test] = pair;
    const params: SessionParams = { anchor_utc: c.anchor_utc, range_minutes: c.range_minutes, entry_window_minutes: entryWindow, flat_by_hours: flatBy };
    const sk = `${c.anchor_utc}|${c.range_minutes}`;
    let sigs = sigCache.get(sk);
    if (!sigs) {
      sigs = new Map();
      sigCache.set(sk, sigs);
    }
    const raw = signalFor(params);
    const memo = sigs;
    const signal: SignalFn = (sess) => {
      let v = memo.get(sess.s);
      if (!v) {
        v = raw(sess);
        memo.set(sess.s, v);
      }
      return v;
    };
    const r: ComboTrades = {
      params: c,
      train: ruleTrades(train, params, entryBufferPct, c.stop_rule, c.target_r, c.min_range_pct, maxChase, signal),
      test: ruleTrades(test, params, entryBufferPct, c.stop_rule, c.target_r, c.min_range_pct, maxChase, signal),
      sessions: [train.length, test.length],
    };
    results.push(r);
    if (onCombo) onCombo(index, r);
  });
  return results;
}

export function summarizeCombo(t: ComboTrades, cfg: Costs): ComboResult {
  return { params: t.params, train: summarize(tradesNetR(t.train, cfg)), test: summarize(tradesNetR(t.test, cfg)), sessions: t.sessions };
}

export function evaluate(
  bars: ReadonlyArray<Bar>,
  cfg: Pick<Config, "fee_pct" | "slippage_pct" | "entry_buffer_pct">,
  combos: ReadonlyArray<Combo>,
  split: number,
  entryWindow: number,
  flatBy: number,
  maxChase: number,
): ComboResult[] {
  return evaluateTrades(bars, cfg.entry_buffer_pct, combos, split, entryWindow, flatBy, maxChase).map((t) => summarizeCombo(t, cfg));
}

/** As contas do fim do relatório do backtest.py. */
export interface GridVerdict {
  /** combinações com 20+ trades no treino, da melhor para a pior no treino */
  ranked: number[];
  /** das `top` melhores do treino, quantas seguiram positivas no teste */
  topPositive: number;
  topN: number;
  /** de todas com 10+ trades no teste, quantas deram R total positivo */
  allPositive: number;
  allN: number;
}

export function gridVerdict(res: ReadonlyArray<ComboResult>, top = 5): GridVerdict {
  const ranked = res
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.train.trades >= 20)
    .sort((a, b) => b.r.train.sum_r - a.r.train.sum_r)
    .map((x) => x.i);
  const head = ranked.slice(0, top);
  return {
    ranked,
    topPositive: head.filter((i) => res[i].test.sum_r > 0).length,
    topN: head.length,
    allPositive: res.filter((r) => r.test.trades >= 10 && r.test.sum_r > 0).length,
    allN: res.filter((r) => r.test.trades >= 10).length,
  };
}
