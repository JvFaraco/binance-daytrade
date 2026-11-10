// Porte de scripts/size.py: tamanho da posição a partir do plano e do prejuízo máximo por trade,
// com os filtros do par vindos de exchangeInfo.
//
// O que NÃO foi portado de propósito: "plan_fingerprint". Ele só existe para o broker.py casar a
// ordem com a checagem de risco antes de enviar, e este painel não envia ordem nenhuma.
import { type Config, TraderError, lossPerUnit, roundTripCost } from "./core";
import { Dec, ceilStep, dstr, floorStep } from "./decimal";
import type { Plan } from "./plan";
import { fixedHalfEven, fmtG, pyFloatStr, pyRound } from "./py";

export interface ExchangeFilter {
  filterType: string;
  [k: string]: unknown;
}

export interface ExchangeSymbol {
  symbol?: string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
  isSpotTradingAllowed?: boolean;
  ocoAllowed?: boolean;
  otoAllowed?: boolean;
  orderTypes?: string[];
  filters?: ExchangeFilter[];
}

export interface ExchangeInfo {
  symbols?: ExchangeSymbol[];
}

export interface Rules {
  base: string;
  quote: string;
  tick: string;
  step: string;
  min_qty: string;
  max_qty: string;
  min_notional: string;
  max_notional: string;
  market_min_qty: string;
  market_max_qty: string;
  market_step: string;
  bid_mult_up: number;
  ask_mult_down: number;
  oco_allowed: boolean;
  oto_allowed: boolean;
  max_algo_orders: number;
}

const NEED = ["LIMIT", "LIMIT_MAKER", "STOP_LOSS_LIMIT", "MARKET"];

function need<T>(obj: Record<string, unknown> | undefined, key: string): T {
  if (!obj || !(key in obj)) throw new TraderError(`exchangeInfo sem o filtro '${key}'`);
  return obj[key] as T;
}

/** Regras do par, direto do exchangeInfo (fonte: binance-spot-api-docs, filters.md). */
export function parseRules(info: ExchangeInfo, symbol: string): Rules {
  const s = (info.symbols ?? []).find((x) => x.symbol === symbol);
  if (!s) throw new TraderError(`par ${symbol} não encontrado em exchangeInfo`);
  if (s.status !== "TRADING") throw new TraderError(`${symbol} não está em TRADING (status: ${s.status ?? "None"})`);
  if (s.isSpotTradingAllowed === false) throw new TraderError(`${symbol} não permite spot (isSpotTradingAllowed=false)`);
  const types = new Set(s.orderTypes ?? []);
  const missing = NEED.filter((t) => !types.has(t)).sort();
  if (types.size && missing.length) {
    throw new TraderError(`${symbol} não aceita os tipos de ordem necessários: faltam ${missing.join(", ")}`);
  }
  const f: Record<string, Record<string, unknown>> = {};
  for (const x of s.filters ?? []) f[x.filterType] = x;
  const notional = f.NOTIONAL ?? f.MIN_NOTIONAL ?? {};
  const pps = f.PERCENT_PRICE_BY_SIDE ?? {};
  const mls = f.MARKET_LOT_SIZE ?? {};
  const price = need<Record<string, unknown>>(f, "PRICE_FILTER");
  const lot = need<Record<string, unknown>>(f, "LOT_SIZE");
  return {
    base: need<string>(s as Record<string, unknown>, "baseAsset"),
    quote: need<string>(s as Record<string, unknown>, "quoteAsset"),
    tick: need<string>(price, "tickSize"),
    step: need<string>(lot, "stepSize"),
    min_qty: need<string>(lot, "minQty"),
    max_qty: (lot.maxQty as string | undefined) ?? "0",
    min_notional: (notional.minNotional as string | undefined) ?? "0",
    max_notional: (notional.maxNotional as string | undefined) ?? "0",
    market_min_qty: (mls.minQty as string | undefined) ?? "0",
    market_max_qty: (mls.maxQty as string | undefined) ?? "0",
    market_step: (mls.stepSize as string | undefined) ?? "0",
    bid_mult_up: Number(pps.bidMultiplierUp || 0),
    ask_mult_down: Number(pps.askMultiplierDown || 0),
    oco_allowed: Boolean(s.ocoAllowed ?? true),
    oto_allowed: Boolean(s.otoAllowed ?? false),
    max_algo_orders: Math.trunc(Number((f.MAX_NUM_ALGO_ORDERS ?? {}).maxNumAlgoOrders || 0)),
  };
}

/**
 * PERCENT_PRICE_BY_SIDE: compra <= média*bidMultiplierUp; venda >= média*askMultiplierDown.
 * A Binance recusa a ordem (ou o stop nunca vira ordem válida) se isso falhar.
 */
export function checkPercentPrice(rules: Pick<Rules, "bid_mult_up" | "ask_mult_down">, avgPrice: number | null | undefined, entryLimit: number, stopLimit: number): string[] {
  if (!avgPrice) return [];
  const probs: string[] = [];
  if (rules.bid_mult_up && entryLimit > avgPrice * rules.bid_mult_up) {
    probs.push(`limite de compra ${fmtG(entryLimit)} acima do permitido (${fmtG(avgPrice)} x ${fmtG(rules.bid_mult_up)})`);
  }
  if (rules.ask_mult_down && stopLimit < avgPrice * rules.ask_mult_down) {
    probs.push(`limite do stop ${fmtG(stopLimit)} abaixo do permitido (${fmtG(avgPrice)} x ${fmtG(rules.ask_mult_down)}): a venda do stop seria recusada`);
  }
  return probs;
}

export interface Order {
  symbol: string;
  base: string;
  quote: string;
  mode: "otoco" | "two-step";
  entry: { side: "BUY"; type: "LIMIT"; timeInForce: "FOK" | "IOC"; quantity: string; price: string };
  exit: { side: "SELL"; kind: "OCO"; quantity: string; target: string; stop: string; stop_limit: string };
  qty: string;
  step: string;
  market_step: string;
  notional: number;
  max_loss: number;
  reward_at_target: number;
  reward_risk: number;
  paper: boolean;
}

export type SizeConfig = Pick<
  Config,
  "entry_buffer_pct" | "stop_limit_buffer_pct" | "fee_pct" | "slippage_pct" | "max_loss_per_trade" | "account" | "max_position_pct" | "fee_in_bnb" | "entry_mode" | "paper"
>;

export function sizeOrder(plan: Plan, cfg: SizeConfig, rules: Rules, avgPrice: number | null = null): Order {
  const { tick, step } = rules;
  const stop = floorStep(plan.stop, tick);
  const target = ceilStep(plan.target, tick);
  const entryLimit = ceilStep(plan.entry * (1 + cfg.entry_buffer_pct / 100.0), tick);
  const stopLimit = floorStep(stop.toNumber() * (1 - cfg.stop_limit_buffer_pct / 100.0), tick);
  const e = entryLimit.toNumber();
  const s = stop.toNumber();
  const t = target.toNumber();
  if (!(s < e && e < t)) {
    throw new TraderError(`preços incoerentes depois de arredondar: stop ${pyFloatStr(s)}, entrada ${pyFloatStr(e)}, alvo ${pyFloatStr(t)}`);
  }
  const probs = checkPercentPrice(rules, avgPrice, e, stopLimit.toNumber());
  if (probs.length) throw new TraderError(probs.join("; "));
  const lpu = lossPerUnit(e, s, cfg.fee_pct, cfg.slippage_pct);
  let qty = floorStep(cfg.max_loss_per_trade / lpu, step);
  const cap = floorStep((cfg.account * cfg.max_position_pct) / 100.0 / e, step);
  qty = Dec.min(qty, cap);
  if (Dec.from(rules.max_qty).isPositive()) qty = Dec.min(qty, floorStep(rules.max_qty, step));
  if (Dec.from(rules.max_notional).isPositive()) qty = Dec.min(qty, floorStep(Number(rules.max_notional) / e, step));
  if (qty.lt(Dec.from(rules.min_qty))) {
    throw new TraderError(`quantidade ${dstr(qty)} abaixo do mínimo ${rules.min_qty}: o risco permitido é pequeno demais pra esse stop`);
  }
  const notional = qty.toNumber() * e;
  if (notional < Number(rules.min_notional)) {
    throw new TraderError(`valor da ordem ${fixedHalfEven(notional, 2)} abaixo do mínimo ${rules.min_notional} da Binance`);
  }
  // A comissão de uma compra é cobrada na moeda comprada (salvo pagando em BNB), então a
  // quantidade vendável fica menor que a comprada. As pernas de saída vendem só o que sobra.
  const sellQty = cfg.fee_in_bnb ? qty : floorStep(qty.toNumber() * (1 - cfg.fee_pct / 100.0), step);
  if (sellQty.lt(Dec.from(rules.min_qty)) || sellQty.toNumber() * s < Number(rules.min_notional)) {
    throw new TraderError(`a quantidade vendável depois da taxa (${dstr(sellQty)}) fica abaixo do mínimo do par`);
  }
  const mode = rules.oto_allowed && (cfg.entry_mode ?? "otoco") === "otoco" ? "otoco" : "two-step";
  const win = t - e - roundTripCost(e, t, cfg.fee_pct, cfg.slippage_pct);
  return {
    symbol: plan.symbol,
    base: rules.base,
    quote: rules.quote,
    mode,
    entry: { side: "BUY", type: "LIMIT", timeInForce: mode === "otoco" ? "FOK" : "IOC", quantity: dstr(qty), price: dstr(entryLimit) },
    exit: { side: "SELL", kind: "OCO", quantity: dstr(sellQty), target: dstr(target), stop: dstr(stop), stop_limit: dstr(stopLimit) },
    qty: dstr(qty),
    step: String(rules.step),
    market_step: String(rules.market_step),
    notional: pyRound(notional, 2),
    max_loss: pyRound(qty.toNumber() * lpu, 2),
    reward_at_target: pyRound(qty.toNumber() * win, 2),
    reward_risk: pyRound(win / lpu, 3),
    paper: Boolean(cfg.paper),
  };
}
