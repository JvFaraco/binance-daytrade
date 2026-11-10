// Bruto × líquido por estratégia, na mesma unidade (% total composto no período carregado):
// rompimento (com os controles atuais), sazonalidade 21–23 UTC, Donchian diário e comprar e segurar.
import { useMemo } from "react";
import { RESEARCH_LOOKBACKS, SEASON_BUY, SEASON_SELL } from "../app/controller";
import * as fmt from "../app/format";
import { tradeReturns } from "../engine/backtest";
import { researchAtCost, summarize } from "../engine/research";
import { splitCost, useSettings } from "../state/settings";
import { useAnalysis } from "../state/stores";
import { LiveDot, Panel, PanelState, SkeletonStack } from "../ui";

interface RowData {
  key: string;
  name: string;
  detail: string;
  gross: number | null;
  net: number | null;
  /** por que não há número (estado real, não zero) */
  missing?: string;
}

const FIXED_LB = 20;

export function DumbbellPanel() {
  const research = useAnalysis((a) => a.research);
  const breakout = useAnalysis((a) => a.breakout);
  const cost = useSettings((s) => s.cost_pct);
  const months = useSettings((s) => s.months);
  const targetR = useSettings((s) => s.target_r);

  const rows = useMemo<RowData[] | null>(() => {
    if (!research.raw) return null;
    const c = splitCost(cost);
    const r = researchAtCost(research.raw, c);
    const out: RowData[] = [];
    if (breakout.trades) {
      const tr = tradeReturns(breakout.trades, c);
      out.push({
        key: "orb",
        name: "Rompimento",
        detail: `${breakout.trades.length} trades em ${breakout.sessions} sessões · alvo ${fmt.num(targetR, 1)}R · posição cheia`,
        gross: breakout.trades.length ? summarize(tr.gross, 365).total : null,
        net: breakout.trades.length ? summarize(tr.net, 365).total : null,
        missing: breakout.trades.length ? undefined : "nenhum trade no período",
      });
    } else {
      out.push({ key: "orb", name: "Rompimento", detail: "regra dos controles atuais", gross: null, net: null, missing: breakout.status === "error" ? "não calculado" : "calculando" });
    }
    out.push({
      key: "season",
      name: "Sazonalidade",
      detail: `compra ${SEASON_BUY}:00, vende ${SEASON_SELL}:00 UTC · ${r.season.n} dias`,
      gross: r.season.n ? r.season_gross.total : null,
      net: r.season.n ? r.season.total : null,
      missing: r.season.n ? undefined : "sem dias completos",
    });
    const d = r.donchian.find((x) => x.lookback === FIXED_LB);
    out.push({
      key: "don",
      name: `Donchian N=${FIXED_LB}`,
      detail: d && d.net.n ? `diário, só comprado · ${d.entries} entradas em ${d.net.n} dias` : "diário, só comprado",
      gross: d && d.net.n ? d.gross.total : null,
      net: d && d.net.n ? d.net.total : null,
      missing: d && d.net.n ? undefined : "dias insuficientes",
    });
    out.push({
      key: "wf",
      name: "Donchian walk-forward",
      detail: r.trend_wf ? `lookback escolhido só com o passado: ${r.wf_chosen.join(", ")} · ${r.wf_n} dias fora da amostra` : `lookbacks ${RESEARCH_LOOKBACKS.join(", ")}`,
      gross: r.trend_wf_gross ? r.trend_wf_gross.total : null,
      net: r.trend_wf ? r.trend_wf.total : null,
      missing: r.trend_wf ? undefined : `dados insuficientes em ${months} meses: precisa de mais dias (tente 6 ou 12)`,
    });
    out.push({ key: "bh", name: "Comprar e segurar", detail: `${r.bh.n} dias · sem giro, sem custo recorrente`, gross: r.bh.n ? r.bh.total : null, net: r.bh.n ? r.bh.total : null });
    return out;
  }, [research.raw, breakout, cost, months, targetR]);

  const [lo, hi] = useMemo(() => {
    let a = 0;
    let b = 0;
    for (const r of rows ?? []) {
      for (const v of [r.gross, r.net]) {
        if (v === null) continue;
        a = Math.min(a, v);
        b = Math.max(b, v);
      }
    }
    const pad = (b - a) * 0.08 || 1;
    return [a - pad, b + pad];
  }, [rows]);
  const X = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const days = research.raw?.days ?? 0;

  return (
    <Panel
      area="dumb"
      title="Bruto × líquido"
      sub={research.raw ? `% total composto · ${days} dias · ${fmt.ddmmyy(research.raw.firstDay, "UTC")} → ${fmt.ddmmyy(research.raw.lastDay, "UTC")}` : "% total composto por estratégia"}
      state={<LiveDot state={research.status === "error" ? "error" : research.status === "ready" ? "done" : "busy"} label={research.status === "ready" && research.ms !== null ? `${fmt.num(research.ms, 0)} ms` : research.status === "error" ? "erro" : "pesquisa"} />}
    >
      {research.status === "error" ? (
        <PanelState kind="error" title="A pesquisa não rodou" detail={research.error} />
      ) : !rows ? (
        <SkeletonStack lines={8} label="Calculando a pesquisa" />
      ) : (
        <div className="dumb">
          <div className="dumb__legend label">
            <span>
              <i className="dumb__dot" data-k="gross" /> bruto
            </span>
            <span>
              <i className="dumb__dot" data-k="net" /> líquido (custo atual)
            </span>
          </div>
          <ul className="dumb__rows">
            {rows.map((r) => (
              <li key={r.key} className="dumb__row">
                <div className="dumb__name">
                  <span>{r.name}</span>
                  {r.net !== null ? (
                    <span className="num">
                      {r.gross !== null && r.gross !== r.net ? <span className="tone-raw">{fmt.signedPct(r.gross, 1)} → </span> : null}
                      <b className={r.net > 0 ? "tone-pos" : r.net < 0 ? "tone-neg" : ""}>{fmt.signedPct(r.net, 1)}</b>
                    </span>
                  ) : null}
                </div>
                {r.net !== null && r.gross !== null ? (
                  <div className="dumb__track" role="img" aria-label={`${r.name}: bruto ${fmt.signedPct(r.gross, 1)}, líquido ${fmt.signedPct(r.net, 1)}`}>
                    <span className="dumb__zero" style={{ left: X(0) + "%" }} />
                    <span className="dumb__bar" data-sign={r.net >= 0 ? "pos" : "neg"} style={{ left: Math.min(X(r.gross), X(r.net)) + "%", width: Math.abs(X(r.gross) - X(r.net)) + "%" }} />
                    <span className="dumb__pt" data-k="gross" style={{ left: X(r.gross) + "%" }} />
                    <span className="dumb__pt" data-k="net" data-sign={r.net >= 0 ? "pos" : "neg"} style={{ left: X(r.net) + "%" }} />
                  </div>
                ) : (
                  <div className="dumb__missing">{r.missing}</div>
                )}
                <div className="dumb__detail label">{r.detail}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
