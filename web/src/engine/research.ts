// Porte de scripts/research.py: as hipóteses que a literatura aponta como as únicas que
// sobrevivem a taxa em cripto. Tudo com custo e walk-forward; posições só compradas (spot).
import { type Bar, DAY, HOUR } from "./core";
import { fixedHalfEven, fixedPlus, floorDiv, pyRound, pySum } from "./py";
import type { Costs } from "./timemachine";

export interface AggBar extends Bar {
  n: number;
}

function aggregate(bars: ReadonlyArray<Bar>, bucket: (t: number) => number): AggBar[] {
  const out: AggBar[] = [];
  let cur: AggBar | null = null;
  for (const b of bars) {
    const k = bucket(b.t);
    if (cur === null || cur.t !== k) {
      if (cur) out.push(cur);
      cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1 };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      cur.n += 1;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Candles de 5m -> horários (UTC). Hora com buraco grande sai. */
export function toHourly(bars5m: ReadonlyArray<Bar>): AggBar[] {
  return aggregate(bars5m, (t) => floorDiv(t, HOUR) * HOUR).filter((h) => h.n >= 10);
}

export function toDaily(bars: ReadonlyArray<Bar>, anchorHour = 0): AggBar[] {
  return aggregate(bars, (t) => floorDiv(t - anchorHour * HOUR, DAY) * DAY + anchorHour * HOUR);
}

/** Custo de ida e volta como fração (0.003 para 0.10+0.05 por lado). */
export function costRt(cfg: Costs): number {
  return (2 * (cfg.fee_pct + cfg.slippage_pct)) / 100.0;
}

export function costSide(cfg: Costs): number {
  return (cfg.fee_pct + cfg.slippage_pct) / 100.0;
}

export interface ReturnSummary {
  n: number;
  total: number;
  cagr: number | null;
  sharpe: number | null;
  max_dd: number;
  win_pct: number | null;
}

/** rets: retornos por período (já líquidos). Equity composta. */
export function summarize(rets: ArrayLike<number>, periodsPerYear: number): ReturnSummary {
  const n = rets.length;
  if (!n) return { n: 0, total: 0.0, cagr: null, sharpe: null, max_dd: 0.0, win_pct: null };
  let eq = 1.0;
  let peak = 1.0;
  let dd = 0.0;
  for (let i = 0; i < n; i++) {
    eq *= 1 + rets[i];
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq / peak - 1);
  }
  const years = n / periodsPerYear;
  const mean = pySum(rets) / n;
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) sq[i] = (rets[i] - mean) * (rets[i] - mean);
  const sd = Math.sqrt(pySum(sq) / Math.max(1, n - 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null;
  let nz = 0;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    if (rets[i] !== 0) {
      nz++;
      if (rets[i] > 0) wins++;
    }
  }
  return {
    n,
    total: pyRound((eq - 1) * 100, 2),
    cagr: years > 0 && eq > 0 ? pyRound((Math.pow(eq, 1 / years) - 1) * 100, 2) : null,
    sharpe: sharpe !== null ? pyRound(sharpe, 2) : null,
    max_dd: pyRound(dd * 100, 2),
    win_pct: nz ? pyRound((wins / nz) * 100, 1) : null,
  };
}

export function buyHold(bars: ReadonlyArray<Bar>): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) out.push(bars[i].c / bars[i - 1].c - 1);
  return out;
}

// ---------------------------------------------------------------- 1. efeito de horário

/** [hora, n, média em bps, erro-padrão em bps, t]; sem custo: é diagnóstico. */
export type HourRow = [number, number, number | null, number | null, number | null];

export function hourProfile(hourly: ReadonlyArray<AggBar>): HourRow[] {
  const by: number[][] = Array.from({ length: 24 }, () => []);
  for (let i = 1; i < hourly.length; i++) {
    const prev = hourly[i - 1];
    const cur = hourly[i];
    if (cur.t - prev.t !== HOUR) continue;
    by[floorDiv(cur.t, HOUR) % 24].push(cur.c / prev.c - 1);
  }
  const rows: HourRow[] = [];
  for (let h = 0; h < 24; h++) {
    const xs = by[h];
    if (xs.length < 20) {
      rows.push([h, xs.length, null, null, null]);
      continue;
    }
    const m = pySum(xs) / xs.length;
    const sd = Math.sqrt(pySum(xs.map((x) => (x - m) * (x - m))) / (xs.length - 1));
    const se = sd / Math.sqrt(xs.length);
    rows.push([h, xs.length, m * 1e4, se * 1e4, se > 0 ? m / se : null]);
  }
  return rows;
}

// ---------------------------------------------------------------- 2. sazonalidade

/**
 * Compra na abertura da hora buyH, vende no fechamento de sellH-1. Um trade por dia.
 * Devolve o retorno BRUTO de cada dia; o líquido é bruto - custo de ida e volta.
 */
export function seasonGross(hourly: ReadonlyArray<AggBar>, buyH: number, sellH: number): number[] {
  const byDay = new Map<number, Map<number, AggBar>>();
  for (const h of hourly) {
    const d = floorDiv(h.t, DAY);
    let m = byDay.get(d);
    if (!m) {
      m = new Map();
      byDay.set(d, m);
    }
    m.set(floorDiv(h.t, HOUR) % 24, h);
  }
  const rets: number[] = [];
  for (const d of [...byDay.keys()].sort((a, b) => a - b)) {
    const hs = byDay.get(d) as Map<number, AggBar>;
    const b = hs.get(buyH);
    const s = hs.get(sellH - 1);
    if (!b || !s) continue;
    rets.push(s.c / b.o - 1);
  }
  return rets;
}

export function seasonReturns(hourly: ReadonlyArray<AggBar>, buyH: number, sellH: number, cfg: Costs): number[] {
  const c = costRt(cfg);
  return seasonGross(hourly, buyH, sellH).map((g) => g - c);
}

// ---------------------------------------------------------------- 3. tendência (Donchian diário)

/** Retorno diário bruto da posição e os dias em que um lado de custo é cobrado (entrada ou saída). */
export interface DonchianRaw {
  gross: Float64Array;
  charged: Uint8Array;
  entries: number;
}

/**
 * Só comprado. Entra quando o fechamento é o maior dos últimos `lookback` dias; sai quando é o
 * menor dos últimos lookback*exitFrac dias. Executa no fechamento do dia do sinal.
 */
export function donchianRaw(daily: ReadonlyArray<Bar>, lookback: number, exitFrac = 0.5): DonchianRaw {
  const exLb = Math.max(2, Math.trunc(lookback * exitFrac));
  const m = Math.max(0, daily.length - lookback);
  const gross = new Float64Array(m);
  const charged = new Uint8Array(m);
  let pos = 0;
  let entries = 0;
  for (let i = lookback; i < daily.length; i++) {
    const prevC = daily[i - 1].c;
    const curC = daily[i].c;
    const r = pos ? curC / prevC - 1 : 0.0;
    let hi = -Infinity;
    for (let k = i - lookback; k < i; k++) if (daily[k].c > hi) hi = daily[k].c;
    let lo = Infinity;
    for (let k = i - exLb; k < i; k++) if (daily[k].c < lo) lo = daily[k].c;
    const j = i - lookback;
    gross[j] = r;
    if (pos && curC <= lo) {
      pos = 0;
      charged[j] = 1;
    } else if (!pos && curC >= hi) {
      pos = 1;
      charged[j] = 1;
      entries++;
    }
  }
  return { gross, charged, entries };
}

export function donchianNet(raw: DonchianRaw, cfg: Costs): number[] {
  const c = costSide(cfg);
  const out = new Array<number>(raw.gross.length);
  for (let i = 0; i < out.length; i++) out[i] = raw.charged[i] ? raw.gross[i] - c : raw.gross[i];
  return out;
}

export function donchianReturns(daily: ReadonlyArray<Bar>, lookback: number, cfg: Costs, exitFrac = 0.5): number[] {
  return donchianNet(donchianRaw(daily, lookback, exitFrac), cfg);
}

/** A contagem de entradas que o relatório do research.py mostra ("~N entradas"). */
export function reportEntries(dr: ReadonlyArray<number>): number {
  let n = dr.length && dr[0] !== 0 ? 1 : 0;
  for (let i = 1; i < dr.length; i++) if (dr[i] !== 0 && dr[i - 1] === 0) n++;
  return n;
}

// ---------------------------------------------------------------- walk-forward

/**
 * Divide em nBlocks; no bloco k usa os params que maximizaram `metric` nos blocos < k.
 * Devolve [retornos fora da amostra concatenados, params escolhidos por bloco].
 */
export function walkForward<P>(
  seriesFn: (p: P) => ArrayLike<number>,
  paramsList: ReadonlyArray<P>,
  nBlocks: number,
  metric: keyof ReturnSummary = "total",
): [number[], P[]] {
  const all = paramsList.map((p) => ({ p, rets: Array.from(seriesFn(p)) }));
  const L = Math.min(...all.map((a) => a.rets.length));
  if (L < nBlocks * 10) return [[], []];
  const size = floorDiv(L, nBlocks);
  const oos: number[] = [];
  const chosen: P[] = [];
  const tails = all.map((a) => ({ p: a.p, rets: a.rets.slice(a.rets.length - L) }));
  for (let k = 1; k < nBlocks; k++) {
    let best: (typeof tails)[number] | null = null;
    let bestV: number | null = null;
    for (const a of tails) {
      const train = a.rets.slice(0, k * size);
      const v = train.length ? summarize(train, 1)[metric] : null;
      if (v !== null && (bestV === null || v > bestV)) {
        best = a;
        bestV = v;
      }
    }
    if (best === null) continue;
    oos.push(...best.rets.slice(k * size, (k + 1) * size));
    chosen.push({ ...best.p });
  }
  return [oos, chosen];
}

// ---------------------------------------------------------------- relatório

/** A linha de resumo do research.py. */
export function fmtSummary(s: ReturnSummary): string {
  if (!s.n) return "sem dados";
  return (
    `total ${fixedPlus(s.total, 1)}% | CAGR ${s.cagr !== null ? fixedPlus(s.cagr, 1) + "%" : "-"} | ` +
    `Sharpe ${s.sharpe !== null ? fixedHalfEven(s.sharpe, 2) : "-"} | DD máx ${fixedHalfEven(s.max_dd, 1)}% | ${s.n} períodos` +
    (s.win_pct !== null ? ` | acerto ${fixedHalfEven(s.win_pct, 0)}%` : "")
  );
}

/** Tudo que o painel precisa de um par, sem custo aplicado: o líquido sai daqui para qualquer taxa. */
export interface ResearchRaw {
  hours: number;
  days: number;
  firstDay: number;
  lastDay: number;
  hourProfile: HourRow[];
  buyH: number;
  sellH: number;
  seasonGross: number[];
  lookbacks: number[];
  donchian: DonchianRaw[];
  buyHold: number[];
}

export function researchRaw(bars: ReadonlyArray<Bar>, lookbacks: number[], buyH: number, sellH: number): ResearchRaw {
  const hourly = toHourly(bars);
  const daily = toDaily(bars);
  return {
    hours: hourly.length,
    days: daily.length,
    firstDay: daily.length ? daily[0].t : 0,
    lastDay: daily.length ? daily[daily.length - 1].t : 0,
    hourProfile: hourProfile(hourly),
    buyH,
    sellH,
    seasonGross: seasonGross(hourly, buyH, sellH),
    lookbacks,
    donchian: lookbacks.map((lb) => donchianRaw(daily, lb)),
    buyHold: buyHold(daily),
  };
}

export interface ResearchResult {
  season: ReturnSummary;
  season_gross: ReturnSummary;
  donchian: Array<{ lookback: number; net: ReturnSummary; gross: ReturnSummary; entries: number }>;
  trend_wf: ReturnSummary | null;
  trend_wf_gross: ReturnSummary | null;
  wf_chosen: number[];
  wf_n: number;
  bh: ReturnSummary;
  bh_oos: ReturnSummary | null;
  cost_rt: number;
}

/** Aplica o custo aos retornos crus: os mesmos números de research.run_symbol. */
export function researchAtCost(raw: ResearchRaw, cfg: Costs): ResearchResult {
  const c = costRt(cfg);
  const sr = raw.seasonGross.map((g) => g - c);
  const nets = raw.donchian.map((d) => donchianNet(d, cfg));
  const params = raw.lookbacks.map((lb, i) => ({ lookback: lb, i }));
  const [oos, chosen] = walkForward((p) => nets[p.i], params, 4);
  // o mesmo trecho e os mesmos lookbacks escolhidos, mas sem custo: o "bruto" da estratégia que rodou
  const grossOos: number[] = [];
  if (oos.length) {
    const L = Math.min(...nets.map((n) => n.length));
    const size = floorDiv(L, 4);
    chosen.forEach((p, k) => {
      const g = raw.donchian[p.i].gross;
      const tail = g.subarray(g.length - L);
      grossOos.push(...tail.subarray((k + 1) * size, (k + 2) * size));
    });
  }
  return {
    season: summarize(sr, 365),
    // research.py soma o custo de volta ao líquido para mostrar o bruto
    season_gross: summarize(
      sr.map((r) => r + c),
      365,
    ),
    donchian: raw.lookbacks.map((lb, i) => ({
      lookback: lb,
      net: summarize(nets[i], 365),
      gross: summarize(raw.donchian[i].gross, 365),
      entries: reportEntries(nets[i]),
    })),
    trend_wf: oos.length ? summarize(oos, 365) : null,
    trend_wf_gross: oos.length ? summarize(grossOos, 365) : null,
    wf_chosen: chosen.map((p) => p.lookback),
    wf_n: oos.length,
    bh: summarize(raw.buyHold, 365),
    bh_oos: oos.length ? summarize(raw.buyHold.slice(raw.buyHold.length - oos.length), 365) : null,
    cost_rt: c,
  };
}
