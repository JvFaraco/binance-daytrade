// Paridade com candles REAIS da Binance. Só roda quando REAL_FIXTURE aponta para a saída de
// tools/real_parity.py (precisa de rede para gerar; por isso fica fora do CI).
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { type Bar, DEFAULTS, closedOnly } from "../src/engine";
import * as backtest from "../src/engine/backtest";
import * as research from "../src/engine/research";
import * as tm from "../src/engine/timemachine";
import { expectSame } from "./helpers";

const path = process.env.REAL_FIXTURE;

describe.skipIf(!path)("paridade com candles reais", () => {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const fx: any = path ? JSON.parse(readFileSync(path, "utf-8")) : null;
  const bars = (fx?.bars ?? []) as Bar[];

  it("time machine: 10.000 replays, histórico e veredito", () => {
    if (!fx.tm) return;
    const t = fx.tm;
    const window = closedOnly(
      bars.filter((b) => b.t >= t.tm_now - 60 * 86400000),
      t.tm_now,
    );
    const ss = tm.fullSessions(window, t.plan.params, t.plan.session_start);
    expectSame(ss.length, t.sessions);
    const mc = tm.runMc(t.plan, ss, DEFAULTS, 10000, 19, 2);
    expectSame(mc, t.mc);
    expectSame(tm.runHistory(t.plan, ss, DEFAULTS), t.history);
    expectSame(tm.verdict(mc, t.plan, DEFAULTS), t.verdict);
  });

  it("grade do backtest: 96 combinações, treino e teste", () => {
    const g = backtest.DEFAULT_GRID;
    const combos = backtest.grid(g.anchors, g.ranges, g.stops, g.targets, g.minRanges);
    expectSame(backtest.evaluate(bars, DEFAULTS, combos, 0.7, DEFAULTS.entry_window_minutes, DEFAULTS.flat_by_hours, DEFAULTS.max_chase_pct), fx.grid);
  });

  it("pesquisa: sazonalidade, Donchian walk-forward e buy & hold", () => {
    const r = research.researchAtCost(research.researchRaw(bars, [10, 20, 30, 40, 55], 21, 23), DEFAULTS);
    expectSame({ season: r.season, trend_wf: r.trend_wf, bh: r.bh }, fx.research);
  });
});
