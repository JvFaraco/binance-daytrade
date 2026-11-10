// Porte de scripts/plan.py: plano de entrada/stop/alvo a partir do sinal.
import { type Config, type SessionParams, type Signal, type StopRule, IV, TraderError, fmtTs, stopPrice } from "./core";
import { fixedHalfEven, floorDiv, fmtG } from "./py";

export interface Plan {
  symbol: string;
  side: "BUY";
  session_start: number;
  window_end: number;
  flat_by: number;
  range_high: number;
  range_low: number;
  range_mid: number;
  range_pct: number;
  entry: number;
  entry_time: number | null;
  entry_slot: number;
  stop: number;
  stop_rule: StopRule | string;
  target_r: number;
  target: number;
  risk_per_unit: number;
  params: SessionParams;
}

export function buildPlan(
  symbol: string,
  sig: Signal,
  cfg: Config,
  stopRule: string,
  targetR: number,
  entryIn: number | null = null,
  now: number | null = null,
): Plan {
  if (sig.status !== "triggered" && entryIn === null) {
    throw new TraderError(`sem rompimento (status: ${sig.status}). Não há plano pra montar.`);
  }
  if (sig.range_high === undefined) {
    throw new TraderError(`faixa inicial ainda não existe (status: ${sig.status})`);
  }
  const t = sig.trigger;
  const entry = entryIn !== null ? Number(entryIn) : (t as NonNullable<typeof t>).close;
  const stop = stopPrice(sig, stopRule);
  if (!(stop < entry)) {
    throw new TraderError(`o stop (${fmtG(stop)}) precisa ficar abaixo da entrada (${fmtG(entry)})`);
  }
  if (entry > sig.range_high * (1 + Number(cfg.max_chase_pct) / 100.0)) {
    throw new TraderError(
      `entrada ${fmtG(entry)} está ${fixedHalfEven((entry / sig.range_high - 1) * 100, 1)}% acima do topo da faixa (${fmtG(sig.range_high)}); ` +
        `o máximo é ${fixedHalfEven(cfg.max_chase_pct, 1)}%. Isso não é mais um rompimento.`,
    );
  }
  const risk = entry - stop;
  return {
    symbol: symbol.toUpperCase(),
    side: "BUY",
    session_start: sig.session_start,
    window_end: sig.window_end,
    flat_by: sig.flat_by,
    range_high: sig.range_high,
    range_low: sig.range_low as number,
    range_mid: sig.range_mid as number,
    range_pct: sig.range_pct as number,
    entry,
    entry_time: t ? t.time : null,
    entry_slot: t ? t.slot : floorDiv((now as number) - sig.session_start, IV) - 1,
    stop,
    stop_rule: stopRule,
    target_r: targetR,
    target: entry + targetR * risk,
    risk_per_unit: risk,
    params: {
      anchor_utc: cfg.anchor_utc,
      range_minutes: cfg.range_minutes,
      entry_window_minutes: cfg.entry_window_minutes,
      flat_by_hours: cfg.flat_by_hours,
    },
  };
}

export const STATUS_LABEL: Record<Signal["status"], string> = {
  forming: "FORMANDO: a faixa inicial ainda não fechou",
  nodata: "SEM DADOS: faltam candles da faixa",
  waiting: "ESPERANDO: nenhum candle de 5m fechou acima do topo da faixa",
  expired: "EXPIROU: a janela de entrada acabou sem rompimento",
  triggered: "ROMPEU",
};

/** O mesmo texto de plan.py check. */
export function describe(sig: Signal, cfg: Pick<Config, "display_tz">): string {
  const tz = cfg.display_tz;
  const lines = [
    `Sessão desde ${fmtTs(sig.session_start, tz)} | faixa até ${fmtTs(sig.range_end, tz)} | janela de entrada até ${fmtTs(sig.window_end, tz)} | zerar até ${fmtTs(sig.flat_by, tz)}`,
  ];
  if (sig.range_high !== undefined) {
    lines.push(
      `Faixa: ${fmtG(sig.range_low as number)} a ${fmtG(sig.range_high)} (${fixedHalfEven(sig.range_pct as number, 2)}% de largura, meio ${fmtG(sig.range_mid as number)})`,
    );
  }
  lines.push(STATUS_LABEL[sig.status]);
  if (sig.trigger) {
    const t = sig.trigger;
    lines.push(`Primeiro fechamento acima do topo: ${fmtG(t.close)} às ${fmtTs(t.time, tz)} (${fixedHalfEven(t.pct_over, 2)}% acima)`);
  }
  return lines.join("\n");
}
