// Compatibilidade numérica com o Python do repositório.
//
// O motor original usa sum(), round() e o operador % de formatação. Os três têm regras que o
// JavaScript não segue por padrão; aqui elas são reproduzidas para o porte dar o mesmo resultado.

/** sum() do CPython >= 3.12 para floats: soma compensada de Neumaier. */
export function pySum(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n === 0) return 0;
  let hi = 0 + xs[0];
  let lo = 0;
  for (let i = 1; i < n; i++) {
    const x = xs[i];
    const t = hi + x;
    if (Math.abs(hi) >= Math.abs(x)) lo += hi - t + x;
    else lo += x - t + hi;
    hi = t;
  }
  if (lo !== 0 && Number.isFinite(lo)) return hi + lo;
  return hi;
}

/** round(x) do Python: metade vai para o par. */
export function pyRoundInt(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * "%.nf" do Python: arredonda o valor binário exato; empate exato vai para o par.
 * toFixed do JavaScript também usa o valor exato, mas no empate vai para longe do zero.
 */
export function fixedHalfEven(x: number, n: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const up = x.toFixed(n);
  const probe = Math.abs(x).toFixed(Math.min(100, n + 30));
  const dot = probe.indexOf(".");
  const frac = probe.slice(dot + 1);
  if (frac[n] !== "5" || /[1-9]/.test(frac.slice(n + 1))) return up;
  // empate exato: fica com o truncado se o último dígito dele for par
  const trunc = n === 0 ? probe.slice(0, dot) : probe.slice(0, dot + 1 + n);
  const last = trunc.charCodeAt(trunc.length - 1) - 48;
  if (last % 2 !== 0) return up;
  return (x < 0 || Object.is(x, -0) ? "-" : "") + trunc;
}

/** round(x, n) do Python (n >= 0). */
export function pyRound(x: number, n: number): number {
  return Number(fixedHalfEven(x, n));
}

/** "%+.nf" */
export function fixedPlus(x: number, n: number): string {
  const s = fixedHalfEven(x, n);
  return s.startsWith("-") ? s : "+" + s;
}

function stripZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** "%g" do Python (6 dígitos significativos). */
export function fmtG(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mant, expS] = x.toExponential(5).split("e");
  const exp = Number(expS);
  if (exp < -4 || exp >= 6) {
    const a = Math.abs(exp);
    return stripZeros(mant) + "e" + (exp < 0 ? "-" : "+") + (a < 10 ? "0" + a : String(a));
  }
  return stripZeros(fixedHalfEven(x, Math.max(0, 5 - exp)));
}

/** repr()/str() de um float do Python. */
export function pyFloatStr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [mant, expS] = x.toExponential().split("e");
    const exp = Number(expS);
    const e = Math.abs(exp);
    return mant + "e" + (exp < 0 ? "-" : "+") + (e < 10 ? "0" + e : String(e));
  }
  if (Number.isInteger(x)) return (Object.is(x, -0) ? "-0" : String(x)) + ".0";
  return String(x);
}

/** float("...") do Python para os campos de texto da API; lança em vez de devolver NaN. */
export function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  throw new TypeError("float() inválido: " + String(v));
}

/** a // b para inteiros. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}
