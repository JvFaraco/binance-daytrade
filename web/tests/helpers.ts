import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
let cached: any = null;

/** O arquivo que tools/export_parity.py gera antes dos testes (ver vitest.setup.ts). */
export function fixture(): any {
  if (!cached) cached = JSON.parse(readFileSync(resolve(here, ".fixtures/parity.json"), "utf-8"));
  return cached;
}

/**
 * sum() do Python só passou a usar soma compensada na 3.12. Com um Python mais antigo a soma
 * ingênua difere no último bit, então a comparação aceita 1e-12 relativo; da 3.12 em diante é exata.
 */
export function exactSums(): boolean {
  const [maj, min] = fixture().meta.python as number[];
  return maj > 3 || (maj === 3 && min >= 12);
}

function diffNumber(a: number, b: number, tol: number): boolean {
  if (a === b) return true; // inclui 0 === -0
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (tol > 0) return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  return false;
}

/** Primeira diferença entre o que o TS devolveu e o que o Python exportou, ou null. */
export function firstDiff(actual: any, expected: any, tol = 0, path = "$"): string | null {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined ? null : `${path}: esperado null, veio ${JSON.stringify(actual)}`;
  }
  if (typeof expected === "number") {
    if (typeof actual !== "number" || !diffNumber(actual, expected, tol)) return `${path}: esperado ${expected}, veio ${actual}`;
    return null;
  }
  if (typeof expected !== "object") {
    return actual === expected ? null : `${path}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected)) {
    const a = ArrayBuffer.isView(actual) ? Array.from(actual as unknown as ArrayLike<number>) : actual;
    if (!Array.isArray(a)) return `${path}: esperado lista, veio ${typeof actual}`;
    if (a.length !== expected.length) return `${path}: tamanho ${a.length}, esperado ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const d = firstDiff(a[i], expected[i], tol, `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (actual === null || typeof actual !== "object") return `${path}: esperado objeto, veio ${JSON.stringify(actual)}`;
  const ak = Object.keys(actual).filter((k) => actual[k] !== undefined);
  const ek = Object.keys(expected);
  for (const k of ek) {
    if (!(k in actual) || actual[k] === undefined) {
      if (expected[k] === null) continue;
      return `${path}.${k}: faltou no TS`;
    }
    const d = firstDiff(actual[k], expected[k], tol, `${path}.${k}`);
    if (d) return d;
  }
  for (const k of ak) if (!(k in expected)) return `${path}.${k}: sobrou no TS (${JSON.stringify(actual[k])})`;
  return null;
}

/** Igualdade exata com a saída do Python (tol > 0 só onde documentado). */
export function expectSame(actual: any, expected: any, tol = 0): void {
  expect(firstDiff(actual, expected, tol)).toBeNull();
}

/** Resultado ou mensagem do TraderError, no formato do exportador. */
export function attempt<T>(fn: () => T): { ok: T } | { error: string } {
  try {
    return { ok: fn() };
  } catch (e) {
    if (e instanceof Error && e.name === "TraderError") return { error: e.message };
    throw e;
  }
}
