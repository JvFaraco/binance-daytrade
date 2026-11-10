// Por que cada sessão do histórico NÃO virou trade: a mesma cadeia do skill, etapa por etapa,
// com as mensagens que o motor devolve (scan -> plan -> size -> risk). Não existe no Python como
// função única; só encadeia scan.explain_filtered, plan.build_plan, size.size_order e risk.run_checks.
import { type Config, HOUR, TraderError, orbSignal } from "./core";
import { buildPlan } from "./plan";
import { runChecks } from "./risk";
import { explainFiltered } from "./scan";
import { type Rules, sizeOrder } from "./size";
import type { Session } from "./timemachine";

export interface Rejection {
  key: string;
  /** etapa do pipeline que recusou */
  stage: "scan" | "plan" | "size" | "risk";
  label: string;
  count: number;
  /** uma mensagem real do motor para esse motivo */
  example: string;
}

export interface RejectionReport {
  sessions: number;
  accepted: number;
  reasons: Rejection[];
}

function sizeCategory(msg: string): [string, string] {
  if (msg.startsWith("quantidade")) return ["size-min-qty", "quantidade abaixo do mínimo do par"];
  if (msg.startsWith("valor da ordem")) return ["size-min-notional", "valor da ordem abaixo do mínimo"];
  if (msg.startsWith("preços incoerentes")) return ["size-incoherent", "preços incoerentes após arredondar"];
  if (msg.startsWith("a quantidade vendável")) return ["size-sell-min", "quantidade vendável abaixo do mínimo"];
  if (msg.startsWith("limite d")) return ["size-percent-price", "fora da faixa de preço permitida"];
  return ["size-other", "recusado no dimensionamento"];
}

/**
 * Para cada sessão: o primeiro motivo de recusa, na ordem do pipeline. O risk é avaliado um
 * minuto depois do rompimento, com o dia vazio, como se o sinal tivesse acabado de aparecer.
 */
export function rejectionReport(sessions: ReadonlyArray<Session>, symbol: string, cfg: Config, stopRule: string, targetR: number, rules: Rules | null): RejectionReport {
  const by = new Map<string, Rejection>();
  const hit = (key: string, stage: Rejection["stage"], label: string, example: string) => {
    const r = by.get(key);
    if (r) r.count++;
    else by.set(key, { key, stage, label, count: 1, example });
  };
  let accepted = 0;
  const flatMs = Math.trunc(Number(cfg.flat_by_hours) * HOUR);
  for (const { s, bars } of sessions) {
    const sig = orbSignal(bars, s + flatMs, cfg, s);
    if (sig.status === "nodata") {
      hit("scan-nodata", "scan", "sem candles da faixa", "SEM DADOS: faltam candles da faixa");
      continue;
    }
    if (sig.status !== "triggered" || !sig.trigger) {
      hit("scan-expired", "scan", "janela acabou sem rompimento", "EXPIROU: a janela de entrada acabou sem rompimento");
      continue;
    }
    const why = explainFiltered([{ symbol, status: sig.status, range_pct: sig.range_pct, trigger: sig.trigger }], cfg);
    if (why.length) {
      const narrow = (sig.range_pct as number) < Number(cfg.min_range_pct);
      hit(narrow ? "scan-narrow" : "scan-chase", "scan", narrow ? "faixa estreita demais" : "preço já fugiu do topo", why[0][1]);
      continue;
    }
    let plan;
    try {
      plan = buildPlan(symbol, sig, cfg, stopRule, targetR, null, sig.trigger.time);
    } catch (e) {
      if (!(e instanceof TraderError)) throw e;
      hit("plan-refused", "plan", "plano recusado", e.message);
      continue;
    }
    if (!rules) {
      accepted++;
      continue;
    }
    let order;
    try {
      order = sizeOrder(plan, cfg, rules, null);
    } catch (e) {
      if (!(e instanceof TraderError)) throw e;
      const [key, label] = sizeCategory(e.message);
      hit(key, "size", label, e.message);
      continue;
    }
    const checks = runChecks(plan, order, cfg, { orders: [] }, sig.trigger.time + 60000, null);
    const block = checks.find((c) => c.level === "block");
    if (block) {
      hit("risk-" + block.name, "risk", block.name, block.text);
      continue;
    }
    accepted++;
  }
  const reasons = [...by.values()].sort((a, b) => b.count - a.count);
  return { sessions: sessions.length, accepted, reasons };
}
