// Números derivados dos replays crus para o custo atual. Mudar o custo não refaz sorteio nenhum:
// só o R líquido é recalculado (é a mesma conta do core.net_r).
import { useMemo } from "react";
import { type HistoryResult, type McCostStats, type McResult, breakevenPct, mcCostStats, summarizeHistory, summarizeMc, verdict } from "../engine/timemachine";
import { configFrom, useSettings } from "../state/settings";
import { type TmState, useAnalysis } from "../state/stores";
import { rawOf } from "./controller";

export interface TmDerived {
  tm: TmState;
  mc: McResult;
  stats: McCostStats;
  history: HistoryResult;
  verdict: string;
  /** % de acerto (entre os que bateram num lado) que empata; null = impossível empatar */
  breakeven: number | null;
  /** % de acerto observado entre os que bateram num lado */
  hitRate: number | null;
  /** os mesmos replays no modo em blocos (só no Pro) */
  blocks: (McResult & { mean_block: number }) | null;
}

export function useConfig() {
  const s = useSettings();
  return useMemo(() => configFrom(s), [s]);
}

export function useTmDerived(): TmDerived | null {
  const tm = useAnalysis((a) => a.tm);
  const cost = useSettings((s) => s.cost_pct);
  return useMemo(() => {
    if (!tm) return null;
    const cfg = configFrom({ ...useSettings.getState(), cost_pct: cost });
    const raw = rawOf(tm);
    const mc = summarizeMc(raw, cfg);
    const sides = mc.counts.target + mc.counts.stop;
    const b = tm.result.blocks;
    return {
      tm,
      mc,
      stats: mcCostStats(raw, tm.sortedExit, cfg),
      history: summarizeHistory(tm.result.sessions, tm.result.history, cfg),
      verdict: verdict(mc, tm.plan, cfg),
      breakeven: breakevenPct(tm.plan, cfg),
      hitRate: sides ? (mc.counts.target / sides) * 100 : null,
      blocks: b ? { ...summarizeMc({ ...raw, exit: b.exit, outcome: b.outcome }, cfg), mean_block: b.meanBlock } : null,
    };
  }, [tm, cost]);
}
