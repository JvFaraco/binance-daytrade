// Candles como Float64Array (6 números por candle): cabe em IndexedDB sem custo e atravessa
// a fronteira do worker por transferência, sem copiar objeto por objeto.
import type { Bar } from "../engine/core";

export const BAR_FIELDS = 6;

export function packBars(bars: ReadonlyArray<Bar>): Float64Array {
  const a = new Float64Array(bars.length * BAR_FIELDS);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const k = i * BAR_FIELDS;
    a[k] = b.t;
    a[k + 1] = b.o;
    a[k + 2] = b.h;
    a[k + 3] = b.l;
    a[k + 4] = b.c;
    a[k + 5] = b.v;
  }
  return a;
}

export function unpackBars(a: Float64Array): Bar[] {
  const n = Math.floor(a.length / BAR_FIELDS);
  const out = new Array<Bar>(n);
  for (let i = 0; i < n; i++) {
    const k = i * BAR_FIELDS;
    out[i] = { t: a[k], o: a[k + 1], h: a[k + 2], l: a[k + 3], c: a[k + 4], v: a[k + 5] };
  }
  return out;
}
