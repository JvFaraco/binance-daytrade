// Pareto dos sinais rejeitados: por que cada sessão do período não virou trade, com o motivo
// que o motor devolve em cada etapa (scan, plan, size, risk).
import * as fmt from "../app/format";
import { useAnalysis } from "../state/stores";
import { LiveDot, Panel, PanelState, SkeletonStack } from "../ui";

export function ParetoPanel() {
  const rej = useAnalysis((a) => a.rejections);
  const rep = rej.report;
  const rejected = rep ? rep.sessions - rep.accepted : 0;
  // contagem acumulada até cada motivo (para o traço do Pareto)
  const cumulative = rep ? rep.reasons.map((_, i) => rep.reasons.slice(0, i + 1).reduce((a, r) => a + r.count, 0)) : [];
  return (
    <Panel
      area="pareto"
      title="Sinais rejeitados"
      sub={rep ? `${rep.sessions} sessões do período` : "motivos do motor"}
      state={<LiveDot state={rej.status === "error" ? "error" : rej.status === "ready" ? "done" : "busy"} label={rej.status === "ready" ? "" : rej.status === "error" ? "erro" : "…"} />}
    >
      {rej.status === "error" ? (
        <PanelState kind="error" title="Não calculado" detail="O histórico do par não está disponível." />
      ) : !rep ? (
        <SkeletonStack lines={8} label="Classificando as sessões" />
      ) : rep.sessions === 0 ? (
        <PanelState kind="empty" title="Sem sessões completas" detail="O período carregado não tem nenhuma sessão completa para esta âncora." />
      ) : (
        <div className="pareto">
          <div className="pareto__sum">
            <span>
              <b className="num tone-signal">{rep.accepted}</b> <span className="label">aceitos</span>
            </span>
            <span>
              <b className="num">{rejected}</b> <span className="label">rejeitados</span>
            </span>
          </div>
          <ol className="pareto__list scroll">
            {rep.reasons.map((r, i) => {
              const share = rejected ? (r.count / rejected) * 100 : 0;
              const cum = rejected ? (cumulative[i] / rejected) * 100 : 0;
              return (
                <li key={r.key} className="pareto__row" title={`Exemplo do motor: ${r.example}`}>
                  <div className="pareto__line">
                    <span className="pareto__label">
                      <span className="label">{r.stage}</span> {r.label}
                    </span>
                    <span className="num">{r.count}</span>
                  </div>
                  <div className="pareto__track" role="img" aria-label={`${r.label}: ${r.count} sessões, ${fmt.pct(share, 0)} dos rejeitados, acumulado ${fmt.pct(cum, 0)}`}>
                    <span className="pareto__bar" style={{ width: share + "%" }} />
                    <span className="pareto__cum" style={{ left: cum + "%" }} />
                  </div>
                  <div className="pareto__ex">{r.example}</div>
                </li>
              );
            })}
          </ol>
          <p className="pareto__foot label">barra = parte dos rejeitados · traço = acumulado · texto = mensagem real do motor</p>
        </div>
      )}
    </Panel>
  );
}
