// Cemitério de estratégias: leitura do resultado que scripts/lab.py grava em public/cemiterio.json.
// Nada aqui recalcula estratégia: o motor é o Python (com testes). Este arquivo só escolhe a linha
// do custo atual, conta e explica. Leve de propósito: o modo Lite importa daqui.

/** [retorno total %, Sharpe anual, queda máx %, operações, exposição %, Sharpe deflacionado, ganha do C&S, viva] */
export type LabRow = [number | null, number | null, number | null, number | null, number | null, number | null, 0 | 1, 0 | 1];

export type Breakeven = number | null | { gt: number };

export interface LabPair {
  at: LabRow[];
  chosen: number[] | null;
  breakeven: Breakeven;
  pbo: number | null;
  vs?: string;
}

export interface LabStrategy {
  key: string;
  name: string;
  group: "varejo" | "literatura" | "referencia";
  rule: string;
  variants: string[];
  portfolio: boolean;
  by_pair: Record<string, LabPair>;
  pairs_alive: number[];
  alive: (0 | 1)[];
}

export interface LabData {
  version: number;
  engine: string;
  generated: string;
  window: { start: string; end: string; oos_start: string; oos_days: number; blocks: number; block_months: number; warmup_months: number };
  pairs: string[];
  costs: number[];
  default_cost: number;
  trials: number;
  criterion: { dsr: number; min_pairs: number; luck_sharpe: number };
  cols: string[];
  baselines: Record<string, { bh: [number | null, number | null, number | null][]; dca: (number | null)[] }>;
  strategies: LabStrategy[];
  survivors: number[];
  notes: string[];
  universe?: string[];
}

export const COLS = ["ret", "sharpe", "dd", "trades", "exposure", "dsr", "beats_bh", "alive"];

/** Confere o formato antes de usar: arquivo de outra versão vira erro na tela, não número errado. */
export function validateLab(x: unknown): LabData {
  const d = x as LabData;
  if (!d || d.version !== 1) throw new Error("cemiterio.json de versão desconhecida");
  if (!Array.isArray(d.costs) || d.costs.length < 2 || !Array.isArray(d.strategies) || !d.strategies.length) throw new Error("cemiterio.json incompleto");
  if (JSON.stringify(d.cols) !== JSON.stringify(COLS)) throw new Error("colunas do cemiterio.json mudaram");
  for (const s of d.strategies) {
    for (const p of Object.values(s.by_pair)) {
      if (p.at.length !== d.costs.length) throw new Error(`linhas faltando em ${s.key}`);
    }
  }
  return d;
}

/** Índice do custo pesquisado mais próximo do custo do controle (os passos são os mesmos: 0,005%). */
export function costIndex(d: LabData, cost: number): number {
  let best = 0;
  for (let i = 1; i < d.costs.length; i++) {
    if (Math.abs(d.costs[i] - cost) < Math.abs(d.costs[best] - cost) - 1e-12) best = i;
  }
  return best;
}

export type Reason = "viva" | "sorte" | "perde" | "prejuizo";

export interface PairView {
  sym: string;
  row: LabRow;
  /** comprar e segurar no mesmo trecho e custo: [retorno %, Sharpe, queda %] */
  bh: [number | null, number | null, number | null];
  dca: number | null;
  breakeven: Breakeven;
  pbo: number | null;
  chosen: string[];
  state: "viva" | "ganha" | "lucro" | "perde";
}

export interface StrategyView {
  key: string;
  name: string;
  group: LabStrategy["group"];
  rule: string;
  variants: string[];
  portfolio: boolean;
  alive: boolean;
  reason: Reason;
  nPairs: number;
  pairsAlive: number;
  beats: number;
  profit: number;
  bestSharpe: number | null;
  bestDsr: number | null;
  breakeven: Breakeven;
  pairs: PairView[];
}

/** Custo de equilíbrio típico entre os pares: a mediana (com "nunca" como o menor valor). */
export function medianBreakeven(xs: Breakeven[]): Breakeven {
  if (!xs.length) return null;
  const rank = (b: Breakeven) => (b === null ? -1 : typeof b === "number" ? b : b.gt + 1);
  const sorted = [...xs].sort((a, b) => rank(a) - rank(b));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function strategyView(d: LabData, s: LabStrategy, ci: number): StrategyView {
  const pairs: PairView[] = Object.entries(s.by_pair).map(([sym, p]) => {
    const row = p.at[ci];
    const base = d.baselines[p.vs ?? sym] ?? d.baselines[d.pairs[0]];
    const state: PairView["state"] = row[7] ? "viva" : row[6] ? "ganha" : (row[0] ?? 0) > 0 ? "lucro" : "perde";
    return {
      sym: p.vs ? "carteira" : sym,
      row,
      bh: base.bh[ci],
      dca: p.vs ? null : base.dca[ci],
      breakeven: p.breakeven,
      pbo: p.pbo,
      chosen: (p.chosen ?? []).map((i) => s.variants[i] ?? "?"),
      state,
    };
  });
  const beats = pairs.filter((p) => p.row[6]).length;
  const profit = pairs.filter((p) => (p.row[0] ?? 0) > 0).length;
  const pairsAlive = s.pairs_alive[ci];
  const need = s.portfolio ? 1 : d.criterion.min_pairs;
  const alive = s.alive[ci] === 1;
  const reason: Reason = alive ? "viva" : beats >= need ? "sorte" : profit === 0 ? "prejuizo" : "perde";
  const sharpes = pairs.map((p) => p.row[1]).filter((x): x is number => x !== null);
  const dsrs = pairs.map((p) => p.row[5]).filter((x): x is number => x !== null);
  return {
    key: s.key,
    name: s.name,
    group: s.group,
    rule: s.rule,
    variants: s.variants,
    portfolio: s.portfolio,
    alive,
    reason,
    nPairs: pairs.length,
    pairsAlive,
    beats,
    profit,
    bestSharpe: sharpes.length ? Math.max(...sharpes) : null,
    bestDsr: dsrs.length ? Math.max(...dsrs) : null,
    breakeven: medianBreakeven(pairs.map((p) => p.breakeven)),
    pairs,
  };
}

/** Linhas para a tabela: vivas primeiro, depois quem chegou mais perto (mais pares ganhando, maior DSR). */
export function views(d: LabData, ci: number): StrategyView[] {
  return d.strategies
    .map((s) => strategyView(d, s, ci))
    .sort((a, b) => Number(b.alive) - Number(a.alive) || b.beats / b.nPairs - a.beats / a.nPairs || (b.bestDsr ?? -1) - (a.bestDsr ?? -1));
}

export function survivors(d: LabData, ci: number): number {
  return d.strategies.reduce((n, s) => n + s.alive[ci], 0);
}

export const REASON_TEXT: Record<Reason, string> = {
  viva: "viva",
  sorte: "ganha do comprar e segurar, mas não passa da barra da sorte",
  perde: "perde do comprar e segurar",
  prejuizo: "dá prejuízo em todos os pares",
};

export const GROUP_TEXT: Record<LabStrategy["group"], string> = {
  varejo: "popular",
  literatura: "estudos",
  referencia: "do projeto",
};

/** "0,72%", "nunca" ou "> 2%": o custo por lado em que o lucro fora da amostra zera. */
export function breakevenText(b: Breakeven, fmtPct: (x: number) => string): string {
  if (b === null) return "nunca";
  if (typeof b === "number") return fmtPct(b);
  return "> " + fmtPct(b.gt);
}

/** "2024-02-01" -> "01/02/24" */
export function isoShort(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

/** A frase do Lite. */
export function liteLabSentence(n: number): string {
  return n === 1 ? "sobrevive às taxas" : "sobrevivem às taxas";
}
