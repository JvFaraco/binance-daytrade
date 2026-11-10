// O que o usuário controla. O resto do config é o padrão do core.py (config.example.json).
import { create } from "zustand";
import { type Config, type StopRule, DEFAULTS } from "../engine/core";

export interface Settings {
  symbol: string;
  anchor_utc: string;
  range_minutes: number;
  stop_rule: StopRule;
  target_r: number;
  /** custo por lado em %: taxa + slippage */
  cost_pct: number;
  account: number;
  max_loss_per_trade: number;
  /** meses de histórico para a grade e a pesquisa */
  months: number;
}

export const DEFAULT_COST = DEFAULTS.fee_pct + DEFAULTS.slippage_pct;
export const COST_MAX = 0.2;
export const MONTH_OPTIONS = [3, 6, 12];
/** período em que o README chegou à conclusão do projeto */
export const README_MONTHS = 12;

export const INITIAL: Settings = {
  symbol: "BTCUSDT",
  anchor_utc: DEFAULTS.anchor_utc,
  range_minutes: DEFAULTS.range_minutes,
  stop_rule: "or-mid",
  target_r: 1.5,
  cost_pct: DEFAULT_COST,
  account: DEFAULTS.account,
  max_loss_per_trade: DEFAULTS.max_loss_per_trade,
  months: 3,
};

export const useSettings = create<Settings & { set: (p: Partial<Settings>) => void }>((set) => ({
  ...INITIAL,
  set: (p) => set(p),
}));

/**
 * O custo por lado é dividido em taxa e slippage na proporção do config padrão (0,10 : 0,05).
 * No padrão exato os dois valores são os do config, sem arredondamento.
 */
export function splitCost(cost: number): { fee_pct: number; slippage_pct: number } {
  if (cost === DEFAULT_COST) return { fee_pct: DEFAULTS.fee_pct, slippage_pct: DEFAULTS.slippage_pct };
  const fee = (cost * DEFAULTS.fee_pct) / DEFAULT_COST;
  return { fee_pct: fee, slippage_pct: cost - fee };
}

export function configFrom(s: Settings): Config {
  return {
    ...DEFAULTS,
    anchor_utc: s.anchor_utc,
    range_minutes: s.range_minutes,
    account: s.account,
    max_loss_per_trade: s.max_loss_per_trade,
    ...splitCost(s.cost_pct),
  };
}
