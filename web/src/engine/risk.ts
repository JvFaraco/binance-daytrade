// Porte de scripts/risk.py (run_checks): confere a ordem contra os limites do config.
// No painel o estado do dia é sempre vazio: nenhuma ordem é enviada, então nada fica comprometido.
import { type Config, fmtTs, sessionStart, todayUtc } from "./core";
import type { Plan } from "./plan";
import { fixedHalfEven, fixedPlus, fmtG, pySum } from "./py";

export const COMMITTED = ["approved", "entry_unfilled", "entry_filled", "protected", "flattened"];

export type CheckLevel = "ok" | "warn" | "block";

export interface Check {
  name: string;
  level: CheckLevel;
  text: string;
}

export interface StateOrder {
  date?: string;
  status?: string;
  max_loss?: number | string;
}

export interface RiskState {
  orders?: StateOrder[];
}

export interface TimeMachineSummary {
  verdict?: string;
  mc: { avg_net_r: number };
}

export interface RiskOrder {
  max_loss: number;
  reward_risk: number;
  notional: number;
  quote: string;
  paper: boolean;
}

export function runChecks(plan: Plan, order: RiskOrder, cfg: Config, state: RiskState, now: number, tm: TimeMachineSummary | null = null): Check[] {
  const checks: Check[] = [];
  const add = (name: string, level: CheckLevel, text: string) => checks.push({ name, level, text });
  const f2 = (x: number) => fixedHalfEven(x, 2);

  const today = todayUtc(now);
  const day = (state.orders ?? []).filter((r) => r.date === today && COMMITTED.includes(r.status ?? ""));
  const ml = order.max_loss;
  add("perda máxima", ml <= cfg.max_loss_per_trade * 1.0001 ? "ok" : "block", `${f2(ml)} de perda no stop, limite ${f2(cfg.max_loss_per_trade)}`);
  const committed = pySum(day.map((r) => Number(r.max_loss ?? 0)));
  add(
    "limite do dia",
    committed + ml <= cfg.daily_loss_limit * 1.0001 ? "ok" : "block",
    `${f2(committed)} já comprometido hoje + ${f2(ml)} desta ordem, limite ${f2(cfg.daily_loss_limit)}`,
  );
  add("trades no dia", day.length < cfg.max_trades_per_day ? "ok" : "block", `${day.length} hoje, máximo ${Math.trunc(cfg.max_trades_per_day)}`);
  add("retorno/risco", order.reward_risk >= cfg.min_reward_risk ? "ok" : "block", `${f2(order.reward_risk)} depois das taxas, mínimo ${f2(cfg.min_reward_risk)}`);
  const cap = (cfg.account * cfg.max_position_pct) / 100.0;
  add(
    "tamanho da posição",
    order.notional <= cap * 1.0001 ? "ok" : "block",
    `${f2(order.notional)} ${order.quote}, máximo ${f2(cap)} (${fmtG(cfg.max_position_pct)}% do capital)`,
  );
  add(
    "faixa larga o bastante",
    plan.range_pct >= cfg.min_range_pct ? "ok" : "block",
    `faixa de ${f2(plan.range_pct)}%, mínimo ${f2(cfg.min_range_pct)}% (abaixo disso as taxas comem o trade)`,
  );
  const cur = sessionStart(now, plan.params.anchor_utc);
  add("plano é da sessão atual", plan.session_start === cur ? "ok" : "block", `plano de ${fmtTs(plan.session_start, cfg.display_tz)}, sessão atual ${fmtTs(cur, cfg.display_tz)}`);
  add("janela de entrada", now <= plan.window_end ? "ok" : "block", `agora ${fmtTs(now, cfg.display_tz)}, janela até ${fmtTs(plan.window_end, cfg.display_tz)}`);
  add("antes do horário de zerar", now < plan.flat_by ? "ok" : "block", `zerar às ${fmtTs(plan.flat_by, cfg.display_tz)}`);
  if (plan.entry_time) {
    const age = (now - plan.entry_time) / 60000.0;
    add("sinal fresco", age <= cfg.max_signal_age_minutes ? "ok" : "block", `sinal tem ${fixedHalfEven(age, 0)} min, máximo ${Math.trunc(cfg.max_signal_age_minutes)}`);
  }
  if (tm === null) {
    add("time machine", "warn", "não rodou: você não viu as odds desse plano");
  } else {
    const v = tm.verdict ?? "";
    const bad = v.startsWith("Pende para o stop") || v.startsWith("Forte para o stop") || tm.mc.avg_net_r < 0;
    add("time machine", bad ? "warn" : "ok", v + ` | R médio líquido ${fixedPlus(tm.mc.avg_net_r, 2)}`);
  }
  add("modo", order.paper ? "ok" : "warn", order.paper ? "paper (testnet)" : "DINHEIRO REAL");
  return checks;
}

export function riskVerdict(checks: ReadonlyArray<Check>): "PASS" | "BLOCK" {
  return checks.some((c) => c.level === "block") ? "BLOCK" : "PASS";
}
