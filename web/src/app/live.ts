// Dados de alta frequência fora do React: candles por par, candle em formação e fita.
// Os componentes em canvas leem daqui a cada quadro; as stores só recebem um resumo com teto de frequência.
import type { Bar } from "../engine/core";
import type { Trade } from "../data/stream";

export const live = {
  /** candles de 5m (fechados e o em formação) por par, do mais antigo ao mais novo */
  bars: new Map<string, Bar[]>(),
  last: new Map<string, number>(),
  tape: [] as Trade[],
  /** relógio da Binance menos o local */
  offset: 0,
};

export const TAPE_MAX = 80;
export const BARS_MAX = 320;

/** Agora, no relógio da Binance. */
export function now(): number {
  return Date.now() + live.offset;
}

/** Insere ou substitui o candle pelo horário de abertura. */
export function upsertBar(symbol: string, bar: Bar): void {
  let arr = live.bars.get(symbol);
  if (!arr) {
    arr = [];
    live.bars.set(symbol, arr);
  }
  const n = arr.length;
  if (n && arr[n - 1].t === bar.t) arr[n - 1] = bar;
  else if (!n || arr[n - 1].t < bar.t) {
    arr.push(bar);
    if (arr.length > BARS_MAX) arr.splice(0, arr.length - BARS_MAX);
  } else {
    const i = arr.findIndex((b) => b.t === bar.t);
    if (i >= 0) arr[i] = bar;
  }
  live.last.set(symbol, bar.c);
}
