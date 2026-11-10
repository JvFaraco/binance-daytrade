// Meses de candles de 5m por klines paginados, com cache em IndexedDB por par e mês.
// Período = os últimos N meses fechados + o mês corrente até agora, como history.py (month_list + load).
import { type Bar, type KlineRow, IV, parseKlines } from "../engine/core";
import { STORE_KLINES, idbGet, idbSet } from "./idb";
import { packBars, unpackBars } from "./pack";
import type { BinanceRest } from "./rest";

export const KLINES_WEIGHT = 2;
export const KLINES_PAGE = 1000;

interface MonthRecord {
  bars: Float64Array;
  /** mês fechado e baixado até o fim: não precisa pedir de novo */
  complete: boolean;
  updatedAt: number;
}

/** [início, fim) em ms de cada mês: N fechados + o corrente. */
export function monthRanges(nowMs: number, months: number): Array<{ key: string; start: number; end: number }> {
  const d = new Date(nowMs);
  const out: Array<{ key: string; start: number; end: number }> = [];
  for (let i = months; i >= 0; i--) {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1);
    const s = new Date(start);
    out.push({ key: `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}`, start, end });
  }
  return out;
}

export async function getKlines(rest: BinanceRest, symbol: string, limit: number, start?: number, end?: number): Promise<Bar[]> {
  const rows = await rest.get<KlineRow[]>("/api/v3/klines", { symbol, interval: "5m", limit, startTime: start, endTime: end }, KLINES_WEIGHT);
  return parseKlines(rows);
}

export interface HistoryProgress {
  /** pedidos feitos / pedidos estimados */
  done: number;
  total: number;
  /** candles vindos do cache local */
  cached: number;
  /** candles baixados agora */
  fetched: number;
}

export interface HistoryResult {
  bars: Bar[];
  cached: number;
  fetched: number;
  requests: number;
}

/** Candles fechados do par no período, do mais antigo para o mais novo, sem repetição. */
export async function loadHistory(
  rest: BinanceRest,
  symbol: string,
  months: number,
  nowMs: number,
  onProgress: (p: HistoryProgress) => void = () => {},
): Promise<HistoryResult> {
  const ranges = monthRanges(nowMs, months);
  const prog: HistoryProgress = { done: 0, total: 0, cached: 0, fetched: 0 };
  const parts: Bar[][] = new Array(ranges.length);
  const todo: Array<() => Promise<void>> = [];

  await Promise.all(
    ranges.map(async (r, idx) => {
      const key = `${symbol}|${r.key}`;
      const rec = await idbGet<MonthRecord>(STORE_KLINES, key);
      const have = rec ? unpackBars(rec.bars) : [];
      prog.cached += have.length;
      if (rec?.complete) {
        parts[idx] = have;
        return;
      }
      const end = Math.min(r.end, nowMs);
      const from = have.length ? have[have.length - 1].t + IV : r.start;
      const missing = Math.max(0, Math.ceil((end - from) / IV));
      const pages = Math.ceil(missing / KLINES_PAGE);
      prog.total += pages;
      parts[idx] = have;
      if (pages === 0) return;
      todo.push(async () => {
        const got: Bar[] = have.slice();
        let cur = from;
        let pagesLeft = pages;
        while (cur < end) {
          const chunk = await getKlines(rest, symbol, KLINES_PAGE, cur, end - 1);
          prog.done++;
          pagesLeft--;
          if (!chunk.length) break;
          for (const b of chunk) if (b.t >= cur && b.t < end) got.push(b);
          prog.fetched += chunk.length;
          onProgress({ ...prog });
          const nxt = chunk[chunk.length - 1].t + IV;
          if (nxt <= cur) break;
          cur = nxt;
        }
        // a estimativa de páginas pode sobrar (par listado no meio do mês): acerta o total
        if (pagesLeft > 0) prog.total -= pagesLeft;
        parts[idx] = got;
        // só guarda candles fechados; mês fechado fica marcado como completo
        const closed = got.filter((b) => b.t + IV <= nowMs);
        await idbSet(STORE_KLINES, key, { bars: packBars(closed), complete: r.end <= nowMs, updatedAt: nowMs } satisfies MonthRecord);
        onProgress({ ...prog });
      });
    }),
  );
  onProgress({ ...prog });

  // meses em paralelo (até 4); dentro do mês a paginação é sequencial
  let next = 0;
  const run = async () => {
    while (next < todo.length) await todo[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, run));

  const seen = new Set<number>();
  const out: Bar[] = [];
  for (const p of parts) {
    for (const b of p) {
      if (b.t + IV > nowMs || seen.has(b.t)) continue;
      seen.add(b.t);
      out.push(b);
    }
  }
  out.sort((a, b) => a.t - b.t);
  return { bars: out, cached: prog.cached, fetched: prog.fetched, requests: prog.done };
}
