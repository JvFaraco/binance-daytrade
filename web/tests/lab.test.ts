// Cemitério: o resultado do scripts/lab.py lido pelo painel. O TS não recalcula estratégia;
// o que ele conta e explica tem de bater com o que o Python gravou, em todos os 41 custos.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type LabData, type LabRow, type LabStrategy, breakevenText, costIndex, isoShort, liteLabSentence, medianBreakeven, strategyView, survivors, validateLab, views } from "../src/lab/model";
import { COST_MAX, DEFAULT_COST } from "../src/state/settings";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(resolve(here, "../public/cemiterio.json"), "utf8"));
const data = validateLab(raw);

describe("o JSON do lab.py", () => {
  it("tem um custo pesquisado para cada passo do controle", () => {
    expect(data.costs.length).toBe(41);
    expect(data.costs[0]).toBe(0);
    expect(data.costs.at(-1)).toBe(COST_MAX);
    for (let c = 0; c <= COST_MAX + 1e-9; c += 0.005) {
      expect(Math.abs(data.costs[costIndex(data, c)] - c)).toBeLessThan(1e-9);
    }
    // o custo padrão do painel é 0,1 + 0,05 em ponto flutuante: cai no 0,15 pesquisado
    expect(data.costs[costIndex(data, DEFAULT_COST)]).toBe(0.15);
    expect(data.default_cost).toBe(0.15);
  });

  it("cada estratégia tem uma linha por custo em cada par, e os pares do resultado", () => {
    expect(data.pairs).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]);
    for (const s of data.strategies) {
      expect(s.alive.length).toBe(41);
      expect(s.pairs_alive.length).toBe(41);
      expect(Object.keys(s.by_pair).length).toBe(s.portfolio ? 1 : 5);
      for (const p of Object.values(s.by_pair)) expect(p.at.every((r) => r.length === 8)).toBe(true);
    }
    expect(data.trials).toBe(data.strategies.reduce((n, s) => n + s.variants.length, 0));
  });

  it("recusa arquivo de outra versão ou incompleto", () => {
    expect(() => validateLab({ ...raw, version: 2 })).toThrow(/versão/);
    expect(() => validateLab({ ...raw, strategies: [] })).toThrow(/incompleto/);
    expect(() => validateLab({ ...raw, cols: ["ret"] })).toThrow(/colunas/);
    expect(() => validateLab(null)).toThrow();
  });
});

describe("as contagens do painel batem com o Python em todos os custos", () => {
  it("sobreviventes, vivas e pares vivos", () => {
    for (let ci = 0; ci < data.costs.length; ci++) {
      expect(survivors(data, ci)).toBe(data.survivors[ci]);
      for (const s of data.strategies) {
        const v = strategyView(data, s, ci);
        expect(v.alive).toBe(s.alive[ci] === 1);
        expect(v.pairsAlive).toBe(s.pairs_alive[ci]);
        if (!s.portfolio) expect(v.alive).toBe(s.pairs_alive[ci] >= data.criterion.min_pairs);
        // ganha do comprar e segurar = a coluna do Python, não uma conta nova
        expect(v.beats).toBe(Object.values(s.by_pair).filter((p) => p.at[ci][6] === 1).length);
      }
    }
  });

  it("a tabela põe as vivas primeiro e depois quem chegou mais perto", () => {
    const ci = costIndex(data, 0);
    const rows = views(data, ci);
    expect(rows.length).toBe(data.strategies.length);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      expect(Number(a.alive) >= Number(b.alive)).toBe(true);
      if (a.alive === b.alive) expect(a.beats / a.nPairs >= b.beats / b.nPairs - 1e-12).toBe(true);
    }
  });
});

function fake(rows: LabRow[], portfolio = false): { d: LabData; s: LabStrategy } {
  const by_pair = Object.fromEntries(rows.map((r, i) => [portfolio ? "carteira" : data.pairs[i], { at: Array(41).fill(r), chosen: [0], breakeven: null, pbo: null, ...(portfolio ? { vs: "BTCUSDT" } : {}) }]));
  const alivePairs = rows.filter((r) => r[7]).length;
  const s: LabStrategy = {
    key: "x",
    name: "X",
    group: "varejo",
    rule: "r",
    variants: ["a"],
    portfolio,
    by_pair,
    pairs_alive: Array(41).fill(alivePairs),
    alive: Array(41).fill(portfolio ? alivePairs : alivePairs >= 3 ? 1 : 0),
  };
  return { d: { ...data, strategies: [s] }, s };
}

describe("o motivo de cada morte", () => {
  const W: LabRow = [10, 1.5, -20, 10, 50, 0.97, 1, 1]; // viva no par
  const G: LabRow = [10, 1.0, -20, 10, 50, 0.4, 1, 0]; // ganha do C&S, não passa da sorte
  const L: LabRow = [5, 0.2, -20, 10, 50, 0.1, 0, 0]; // lucro, perde do C&S
  const P: LabRow = [-5, -0.2, -20, 10, 50, 0.0, 0, 0]; // prejuízo
  it("viva com 3 de 5 pares vivos", () => {
    const { d, s } = fake([W, W, W, L, P]);
    const v = strategyView(d, s, 0);
    expect([v.alive, v.reason, v.pairsAlive]).toEqual([true, "viva", 3]);
    expect(v.pairs.map((p) => p.state)).toEqual(["viva", "viva", "viva", "lucro", "perde"]);
  });
  it("ganha do comprar e segurar em pares suficientes, mas não passa da sorte", () => {
    const { d, s } = fake([G, G, G, L, P]);
    expect(strategyView(d, s, 0).reason).toBe("sorte");
  });
  it("perde do comprar e segurar", () => {
    expect(strategyView(...Object.values(fake([G, L, L, P, P])) as [LabData, LabStrategy], 0).reason).toBe("perde");
  });
  it("prejuízo em todos os pares", () => {
    expect(strategyView(...Object.values(fake([P, P, P, P, P])) as [LabData, LabStrategy], 0).reason).toBe("prejuizo");
  });
  it("carteira: um par só, comparada com BTC", () => {
    const { d, s } = fake([G], true);
    const v = strategyView(d, s, 0);
    expect(v.nPairs).toBe(1);
    expect(v.reason).toBe("sorte");
    expect(v.pairs[0].sym).toBe("carteira");
    expect(v.pairs[0].bh).toEqual(data.baselines.BTCUSDT.bh[0]);
  });
});

describe("textos", () => {
  it("custo de equilíbrio", () => {
    const f = (x: number) => x.toFixed(2) + "%";
    expect(breakevenText(null, f)).toBe("nunca");
    expect(breakevenText(0.5, f)).toBe("0.50%");
    expect(breakevenText({ gt: 2 }, f)).toBe("> 2.00%");
    expect(medianBreakeven([null, 0.3, { gt: 2 }])).toBe(0.3);
    expect(medianBreakeven([null, null, 0.3])).toBeNull();
    expect(medianBreakeven([])).toBeNull();
  });
  it("datas e a frase do Lite", () => {
    expect(isoShort("2024-02-01")).toBe("01/02/24");
    expect(liteLabSentence(0)).toBe("sobrevivem às taxas"); // "0 de 15 sobrevivem"
    expect(liteLabSentence(1)).toBe("sobrevive às taxas");
    expect(liteLabSentence(2)).toBe("sobrevivem às taxas");
  });
});
