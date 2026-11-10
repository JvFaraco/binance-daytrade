// Porte de scripts/scan.py: universo de pares líquidos e o estado do rompimento em cada um.
import { type Bar, type Config, type Signal, type Trigger, ApiError, orbSignal } from "./core";
import { fixedHalfEven, pyFloat } from "./py";

export const STABLE = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1", "AEUR", "EUR", "EURI", "USDE", "XUSD"]);

export interface Ticker {
  symbol?: string;
  quoteVolume?: string | number | null;
  lastPrice?: string | number | null;
  openPrice?: string | number | null;
  priceChangePercent?: string | number | null;
}

export interface UniverseEntry {
  symbol: string;
  quote_volume: number;
  change_pct: number;
}

/** Variação do dia. A versão enxuta (MINI) do ticker não traz o campo pronto. */
export function changePct(t: Ticker): number {
  try {
    if (t.priceChangePercent !== undefined && t.priceChangePercent !== null && t.priceChangePercent !== "") {
      return pyFloat(t.priceChangePercent);
    }
    const o = pyFloat(t.openPrice);
    const c = pyFloat(t.lastPrice);
    return o ? ((c - o) / o) * 100 : 0.0;
  } catch {
    return 0.0;
  }
}

/** Preço colado em 1 e quase sem variação no dia: stablecoin, não serve pra rompimento. */
function looksStable(t: Ticker): boolean {
  let last: number;
  try {
    last = pyFloat(t.lastPrice);
  } catch {
    return false;
  }
  return 0.97 <= last && last <= 1.03 && Math.abs(changePct(t)) < 0.3;
}

/** O que load_tickers guarda de cada ticker MINI (e o que vai para o cache). */
export function slimTickers(raw: ReadonlyArray<Ticker>, quote: string): Ticker[] {
  return raw
    .filter((t) => (t.symbol ?? "").endsWith(quote))
    .map((t) => ({ symbol: t.symbol, quoteVolume: t.quoteVolume ?? null, lastPrice: t.lastPrice ?? null, priceChangePercent: changePct(t) }));
}

export function pickUniverse(tickers: ReadonlyArray<Ticker>, cfg: Pick<Config, "quote" | "min_quote_volume" | "exclude_bases">, top: number): UniverseEntry[] {
  const quote = cfg.quote;
  const exclude = new Set(cfg.exclude_bases ?? []);
  const out: UniverseEntry[] = [];
  for (const t of tickers) {
    const sym = t.symbol ?? "";
    if (!sym.endsWith(quote)) continue;
    const base = sym.slice(0, sym.length - quote.length);
    if (!base || STABLE.has(base)) continue;
    let qv: number;
    try {
      qv = pyFloat(t.quoteVolume);
    } catch {
      continue;
    }
    if (qv < Number(cfg.min_quote_volume)) continue;
    if (exclude.has(base) || looksStable(t)) continue;
    out.push({ symbol: sym, quote_volume: qv, change_pct: changePct(t) });
  }
  out.sort((a, b) => b.quote_volume - a.quote_volume);
  return out.slice(0, top);
}

export interface ScanResult {
  symbol: string;
  status: Signal["status"] | "error";
  quote_volume?: number;
  error?: string;
  range_high?: number;
  range_low?: number;
  range_mid?: number;
  range_pct?: number;
  trigger?: Trigger;
}

/** Um par: o mesmo dicionário que scan_orb monta. */
export function scanOne(u: { symbol: string; quote_volume: number }, bars: ReadonlyArray<Bar>, nowMs: number, cfg: Config): ScanResult {
  const sig = orbSignal(bars, nowMs, cfg);
  const r: ScanResult = { symbol: u.symbol, status: sig.status, quote_volume: u.quote_volume };
  if (sig.range_high !== undefined) {
    r.range_high = sig.range_high;
    r.range_low = sig.range_low;
    r.range_mid = sig.range_mid;
    r.range_pct = sig.range_pct;
  }
  if (sig.trigger) r.trigger = sig.trigger;
  return r;
}

/** fetch(symbol) -> candles fechados. Devolve uma lista de resultados por símbolo. */
export function scanOrb(
  universe: ReadonlyArray<{ symbol: string; quote_volume: number }>,
  nowMs: number,
  cfg: Config,
  fetch: (symbol: string) => ReadonlyArray<Bar>,
): ScanResult[] {
  return universe.map((u) => {
    try {
      return scanOne(u, fetch(u.symbol), nowMs, cfg);
    } catch (e) {
      if (e instanceof ApiError) return { symbol: u.symbol, status: "error", error: e.message };
      throw e;
    }
  });
}

/** Rompimentos que ainda valem: faixa larga o bastante e preço não fugiu. */
export function filterHits(results: ReadonlyArray<ScanResult>, cfg: Pick<Config, "min_range_pct" | "max_chase_pct">): ScanResult[] {
  const hits = results.filter(
    (r) => r.status === "triggered" && (r.range_pct as number) >= Number(cfg.min_range_pct) && (r.trigger as Trigger).pct_over <= Number(cfg.max_chase_pct),
  );
  hits.sort((a, b) => (b.trigger as Trigger).time - (a.trigger as Trigger).time);
  return hits;
}

/** Rompimentos que o filtro descartou, com o motivo. */
export function explainFiltered(results: ReadonlyArray<ScanResult>, cfg: Pick<Config, "min_range_pct" | "max_chase_pct">): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const r of results) {
    if (r.status !== "triggered") continue;
    if ((r.range_pct as number) < Number(cfg.min_range_pct)) {
      out.push([r.symbol, `faixa de ${fixedHalfEven(r.range_pct as number, 2)}%, abaixo do mínimo de ${fixedHalfEven(cfg.min_range_pct, 1)}%`]);
    } else if ((r.trigger as Trigger).pct_over > Number(cfg.max_chase_pct)) {
      out.push([r.symbol, `já fechou ${fixedHalfEven((r.trigger as Trigger).pct_over, 2)}% acima do topo (máximo ${fixedHalfEven(cfg.max_chase_pct, 1)}%)`]);
    }
  }
  return out;
}

export function counts(results: ReadonlyArray<ScanResult>): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of results) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}
