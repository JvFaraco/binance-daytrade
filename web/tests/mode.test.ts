// Modo Lite: precedência URL > salvo > padrão, o texto do veredito e o que cada modo carrega.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as fmt from "../src/app/format";
import { netR } from "../src/engine";
import { averageSentence, liteVerdict, riskedPct } from "../src/lite/model";
import { breakevenR, costK } from "../src/sphere/geometry";
import { DEFAULT_MODE, parseMode, resolveMode } from "../src/state/mode";
import { COST_MAX, restore, splitCost } from "../src/state/settings";

describe("modo: a URL vence o valor salvo, que vence o padrão", () => {
  it("primeira visita, sem URL e sem nada salvo: Lite", () => {
    expect(DEFAULT_MODE).toBe("lite");
    expect(resolveMode("", undefined)).toBe("lite");
    expect(resolveMode("?outra=coisa", null)).toBe("lite");
  });
  it("sem URL, vale o salvo", () => {
    expect(resolveMode("", "pro")).toBe("pro");
    expect(resolveMode("?x=1", "lite")).toBe("lite");
  });
  it("a URL vence o salvo nos dois sentidos", () => {
    expect(resolveMode("?modo=lite", "pro")).toBe("lite");
    expect(resolveMode("?modo=pro", "lite")).toBe("pro");
    expect(resolveMode("?a=1&modo=PRO", "lite")).toBe("pro");
  });
  it("valor inválido na URL não vence nada; valor inválido salvo cai no padrão", () => {
    expect(resolveMode("?modo=banana", "pro")).toBe("pro");
    expect(resolveMode("?modo=", "pro")).toBe("pro");
    expect(resolveMode("", "avançado")).toBe("lite");
    expect(parseMode(" Lite ")).toBe("lite");
    expect(parseMode(null)).toBeNull();
  });
});

describe("preferências salvas", () => {
  it("só volta o que o painel aceita", () => {
    expect(restore({ par: "SOLUSDT", custo: 0.1, meses: 12 })).toEqual({ symbol: "SOLUSDT", cost_pct: 0.1, months: 12 });
    expect(restore({ custo: COST_MAX + 0.01, meses: 7 })).toEqual({});
    expect(restore({ custo: -0.01 })).toEqual({});
    expect(restore({})).toEqual({});
    expect(restore({ custo: 0 })).toEqual({ cost_pct: 0 });
  });
});

describe("veredito do Lite: negativo sem rodeio, positivo sem comemoração", () => {
  it("resultado negativo abre dizendo que perdeu dinheiro", () => {
    for (const avg of [-0.01, -0.61, -1.52, -12]) {
      const v = liteVerdict(avg, 0.15);
      expect(v.tone).toBe("neg");
      expect(v.title).toBe("Perdeu dinheiro depois das taxas.");
    }
    // sem custo não se pode culpar as taxas
    expect(liteVerdict(-0.09, 0).title).toBe("Perdeu dinheiro mesmo sem taxa nenhuma.");
  });
  it("resultado positivo nunca vira promessa", () => {
    for (const avg of [0, 0.01, 0.4, 3]) {
      const v = liteVerdict(avg, 0.15);
      expect(v.tone).toBe("mixed");
      expect(v.title).toContain("não prova nada");
      expect(v.title.toLowerCase()).not.toMatch(/lucr|ganh|funciona|vale a pena|vantagem|dinheiro/);
    }
  });
  it("a porcentagem do valor arriscado tem os mesmos dígitos do R que o Pro mostra", () => {
    const values = [-0.6094567560781433, -0.615, -0.005, -0.004, 0.125, 1.5249, -1.5251, 0.9999, -12.3456, 0];
    for (let i = 0; i < 400; i++) values.push(((i * 7919) % 4001) / 1000 - 2);
    for (const avg of values) {
      const pro = fmt.rr(avg).replace(/\D/g, ""); // "−0,61R" -> "061"
      expect(riskedPct(avg).replace(/\D/g, "")).toBe(String(Number(pro)));
    }
    expect(riskedPct(-0.6094567560781433)).toBe("61%");
    expect(averageSentence(-0.6094567560781433)).toBe("em média, perde 61% do valor arriscado em cada operação");
    expect(averageSentence(0.25)).toBe("em média, ganha 25% do valor arriscado em cada operação");
  });
});

describe("custo de empate (anel da esfera no Pro, frase de custo no Lite)", () => {
  it("no R bruto de empate o R líquido do motor é zero", () => {
    for (const [entry, stop] of [
      [101.5, 100],
      [75229.23, 74797],
      [0.3179, 0.3173],
      [87.9, 86.23],
    ]) {
      for (const cost of [0.05, 0.075, 0.13, 0.15, 0.2]) {
        const c = splitCost(cost);
        const g = breakevenR(costK(entry, stop), cost / 100);
        const exit = entry + g * (entry - stop);
        expect(Math.abs(netR(entry, exit, stop, c.fee_pct, c.slippage_pct))).toBeLessThan(1e-9);
        expect(g).toBeGreaterThan(0);
      }
      expect(breakevenR(costK(entry, stop), 0)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- o que cada modo carrega

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function resolveFile(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const cand of [base, base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")]) {
    if (existsSync(cand) && /\.(ts|tsx)$/.test(cand)) return cand;
  }
  return null;
}

/** Imports estáticos de um arquivo (os que entram no mesmo pedaço do build). `import type` não conta. */
function staticImports(file: string): { files: string[]; packages: string[]; dynamic: string[] } {
  const code = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const files: string[] = [];
  const packages: string[] = [];
  const dynamic: string[] = [];
  const add = (spec: string, list: string[]) => {
    if (spec.endsWith(".css")) return;
    if (spec.startsWith(".")) {
      const f = resolveFile(file, spec);
      if (f) list.push(f);
    } else if (list !== dynamic) packages.push(spec);
  };
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm)) add(m[1], files);
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], dynamic);
  return { files, packages, dynamic };
}

/** Tudo que é alcançável só por imports estáticos a partir de um arquivo. */
function closure(entry: string): { files: Set<string>; packages: Set<string>; dynamic: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const dynamic = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop() as string;
    if (files.has(f)) continue;
    files.add(f);
    const i = staticImports(f);
    i.packages.forEach((p) => packages.add(p));
    i.dynamic.forEach((d) => dynamic.add(d));
    todo.push(...i.files);
  }
  return { files, packages, dynamic };
}

// caminho relativo a src/ sempre com "/": no Windows o resolve() devolve "\"
const rel = (f: string) => f.slice(src.length + 1).replace(/\\/g, "/");
const HEAVY = /^(three|@react-three\/|postprocessing)/;

describe("o que o Lite não mostra não pesa no Lite", () => {
  const first = closure(resolve(src, "main.tsx"));
  const firstFiles = [...first.files].map(rel);

  it("o carregamento inicial (Lite) não alcança three.js nem os painéis do Pro", () => {
    expect([...first.packages].filter((p) => HEAVY.test(p))).toEqual([]);
    expect(firstFiles).toContain("lite/LiteBoard.tsx");
    for (const proOnly of ["ProBoard.tsx", "sphere/SphereScene.tsx", "panels/SpherePanel.tsx", "panels/Scanner.tsx", "panels/GridPanel.tsx", "panels/DumbbellPanel.tsx", "panels/ParetoPanel.tsx", "panels/TapePanel.tsx", "panels/Pipeline.tsx", "panels/PlanCard.tsx", "panels/OddsPanel.tsx", "panels/Controls.tsx", "panels/CemiterioPanel.tsx"]) {
      expect(firstFiles, proOnly).not.toContain(proOnly);
    }
  });

  it("o Pro entra por import() sob demanda, e a esfera por outro import() dentro dele", () => {
    expect([...first.dynamic].map(rel)).toEqual(["ProBoard.tsx"]);
    const pro = closure(resolve(src, "ProBoard.tsx"));
    expect([...pro.files].map(rel)).toContain("panels/SpherePanel.tsx");
    expect([...pro.packages].filter((p) => HEAVY.test(p))).toEqual([]);
    // (a barra superior, comum aos dois modos, é quem pede o pedaço do Pro; por isso ele aparece aqui também)
    expect([...pro.dynamic].map(rel).sort()).toEqual(["ProBoard.tsx", "sphere/SphereScene.tsx"]);
    const sphere = closure(resolve(src, "sphere/SphereScene.tsx"));
    expect([...sphere.packages].filter((p) => HEAVY.test(p)).sort()).toEqual(["@react-three/drei", "@react-three/fiber", "@react-three/postprocessing", "three"]);
  });

  it("o Lite usa as mesmas funções derivadas e as mesmas stores do Pro", () => {
    const lite = [...closure(resolve(src, "lite/LiteBoard.tsx")).files].map(rel);
    const pro = [...closure(resolve(src, "ProBoard.tsx")).files].map(rel);
    for (const shared of ["app/derived.ts", "state/stores.ts", "state/settings.ts", "engine/timemachine.ts", "engine/backtest.ts", "app/format.ts", "panels/CostControl.tsx"]) {
      expect(lite, shared).toContain(shared);
      expect(pro, shared).toContain(shared);
    }
  });
});
