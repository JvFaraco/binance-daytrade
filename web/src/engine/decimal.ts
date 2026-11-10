// Decimal mínimo (BigInt) para os arredondamentos de passo do core.py:
// floor_step/ceil_step = (Decimal(str(x)) / passo).to_integral_value(ROUND_DOWN|ROUND_UP) * passo.
//
// Diferença conhecida: o Python divide com 28 dígitos de precisão antes de truncar; aqui a divisão
// inteira é exata. Os dois só divergem com quocientes acima de ~1e20, fora de qualquer preço real.

const RE = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

export class Dec {
  constructor(
    readonly c: bigint,
    readonly e: number,
  ) {}

  /** Decimal(str(x)): o número pelo menor texto que o representa, ou o texto como veio. */
  static from(x: number | string | Dec): Dec {
    if (x instanceof Dec) return x;
    const s = typeof x === "number" ? String(x) : x;
    const m = RE.exec(s);
    if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new SyntaxError("decimal inválido: " + s);
    const frac = m[3] ?? "";
    const c = BigInt(m[2] + frac || "0");
    return new Dec(m[1] === "-" ? -c : c, Number(m[4] ?? 0) - frac.length);
  }

  cmp(o: Dec): number {
    const e = Math.min(this.e, o.e);
    const a = this.c * pow10(this.e - e);
    const b = o.c * pow10(o.e - e);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  lt(o: Dec): boolean {
    return this.cmp(o) < 0;
  }

  isPositive(): boolean {
    return this.c > 0n;
  }

  static min(a: Dec, b: Dec): Dec {
    return b.cmp(a) < 0 ? b : a;
  }

  /** float(d) */
  toNumber(): number {
    return Number(this.c.toString() + "e" + this.e);
  }

  /** core.dstr: normaliza (sem zeros à direita) e escreve em notação fixa. */
  toString(): string {
    let c = this.c;
    let e = this.e;
    if (c === 0n) return "0";
    while (c % 10n === 0n) {
      c /= 10n;
      e += 1;
    }
    const neg = c < 0n;
    let d = (neg ? -c : c).toString();
    if (e >= 0) d += "0".repeat(e);
    else if (-e >= d.length) d = "0." + "0".repeat(-e - d.length) + d;
    else d = d.slice(0, d.length + e) + "." + d.slice(d.length + e);
    return (neg ? "-" : "") + d;
  }
}

function quantize(x: number | string | Dec, step: number | string | Dec, up: boolean): Dec {
  const X = Dec.from(x);
  const S = Dec.from(step);
  if (S.c === 0n) throw new RangeError("passo zero");
  const e = Math.min(X.e, S.e);
  const xi = X.c * pow10(X.e - e);
  const si = S.c * pow10(S.e - e);
  let q = xi / si; // trunca em direção ao zero (ROUND_DOWN)
  if (up && xi % si !== 0n) q += xi < 0n !== si < 0n ? -1n : 1n; // ROUND_UP: para longe do zero
  return new Dec(q * S.c, S.e);
}

export function floorStep(x: number | string | Dec, step: number | string | Dec): Dec {
  return quantize(x, step, false);
}

export function ceilStep(x: number | string | Dec, step: number | string | Dec): Dec {
  return quantize(x, step, true);
}

export function dstr(d: Dec): string {
  return d.toString();
}
