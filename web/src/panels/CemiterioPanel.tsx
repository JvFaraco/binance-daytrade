// Cemitério de estratégias: as populares (cursos, corretoras, TradingView, o robô Grid da Binance)
// e as da literatura, na mesma régua do scripts/lab.py. O controle de custo escolhe qual dos 41
// custos pesquisados aparece; nada é recalculado no navegador.
import { useEffect, useMemo } from "react";
import * as fmt from "../app/format";
import { GROUP_TEXT, REASON_TEXT, type LabData, type PairView, type StrategyView, breakevenText, costIndex, isoShort, survivors, views } from "../lab/model";
import { loadLab, useLab } from "../lab/store";
import { useSettings } from "../state/settings";
import { Badge, LiveDot, Panel, PanelState, SkeletonStack } from "../ui";
import { CostControl } from "./CostControl";

const PAIR_STATE: Record<PairView["state"], string> = {
  viva: "viva: ganha do comprar e segurar e passa da barra da sorte",
  ganha: "ganha do comprar e segurar, mas não passa da barra da sorte",
  lucro: "dá lucro, mas perde do comprar e segurar",
  perde: "dá prejuízo",
};

const short = (sym: string) => (sym === "carteira" ? "carteira" : sym.replace(/USDT$/, ""));
const sharpe = (x: number | null) => (x === null ? "—" : fmt.num(x, 2));
const pctOr = (x: number | null, d = 1) => (x === null ? "—" : fmt.signedPct(x, d));
const bePct = (x: number) => fmt.num(x, x < 0.1 ? 3 : 2) + "%";

function Dots({ v }: { v: StrategyView }) {
  return (
    <span className="cem__dots" role="img" aria-label={v.pairs.map((p) => `${short(p.sym)}: ${PAIR_STATE[p.state]}`).join("; ")}>
      {v.pairs.map((p) => (
        <span key={p.sym} className="cem__dot" data-state={p.state} title={`${short(p.sym)}: ${PAIR_STATE[p.state]}`}>
          <span className="cem__dotlbl">{short(p.sym)}</span>
        </span>
      ))}
    </span>
  );
}

function Detail({ v, d }: { v: StrategyView; d: LabData }) {
  return (
    <div className="cem__detail">
      <p className="cem__rule">
        {v.rule} Variações testadas: {v.variants.join(" · ")}.{" "}
        {v.portfolio ? "É uma carteira: comparada com comprar e segurar BTC." : `Precisa ganhar do comprar e segurar e passar da sorte em ${d.criterion.min_pairs} de ${v.nPairs} pares.`}
      </p>
      <div className="cem__scroll">
        <table className="cem__table">
          <thead>
            <tr>
              <th scope="col">par</th>
              <th scope="col">líquido</th>
              <th scope="col">comprar e segurar</th>
              <th scope="col">Sharpe</th>
              <th scope="col">queda máx.</th>
              <th scope="col">operações</th>
              <th scope="col" title={`Sharpe deflacionado: probabilidade de o resultado não ser sorte, com ${d.trials} tentativas. Precisa de ${fmt.num(d.criterion.dsr * 100, 0)}%.`}>
                não é sorte
              </th>
              <th scope="col" title="Custo por lado em que o lucro fora da amostra zera">
                equilíbrio
              </th>
              <th scope="col" title="Probabilidade de overfitting (CSCV) entre as variações, no custo padrão">
                overfitting
              </th>
              <th scope="col">variação escolhida</th>
            </tr>
          </thead>
          <tbody>
            {v.pairs.map((p) => (
              <tr key={p.sym} data-state={p.state}>
                <th scope="row">
                  <span className="cem__dot cem__dot--sm" data-state={p.state} aria-hidden="true" /> {short(p.sym)}
                </th>
                <td className={"num " + ((p.row[0] ?? 0) > 0 ? "tone-pos" : "tone-neg")}>{pctOr(p.row[0])}</td>
                <td className="num tone-dim">{pctOr(p.bh[0])}</td>
                <td className="num">
                  <b className={p.row[6] ? "tone-signal" : ""}>{sharpe(p.row[1])}</b> <span className="tone-dim">vs {sharpe(p.bh[1])}</span>
                </td>
                <td className="num tone-neg">{p.row[2] === null ? "—" : fmt.pct(p.row[2], 1)}</td>
                <td className="num">{p.row[3] === null ? "—" : fmt.int(p.row[3])}</td>
                <td className={"num " + ((p.row[5] ?? 0) >= d.criterion.dsr ? "tone-pos" : "tone-dim")}>{p.row[5] === null ? "—" : fmt.pct(p.row[5] * 100, 0)}</td>
                <td className="num">{breakevenText(p.breakeven, bePct)}</td>
                <td className="num tone-dim">{p.pbo === null ? "—" : fmt.pct(p.pbo * 100, 0)}</td>
                <td className="cem__chosen">{[...new Set(p.chosen)].join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ v, d }: { v: StrategyView; d: LabData }) {
  const need = v.portfolio ? 1 : d.criterion.min_pairs;
  return (
    <details className="cem__row" data-alive={v.alive} data-key={v.key}>
      <summary className="cem__sum">
        <span className="cem__name">
          <b>{v.name}</b>
          <Badge tone="mute" outline>
            {GROUP_TEXT[v.group]}
          </Badge>
        </span>
        <Dots v={v} />
        <span className="num cem__cell" data-col="beats" title="Pares em que ganha do comprar e segurar (Sharpe, fora da amostra, depois das taxas)">
          <b className={v.beats >= need ? "tone-signal" : ""}>{v.beats}</b>/{v.nPairs}
        </span>
        <span className="num cem__cell" data-col="profit" title="Pares com lucro fora da amostra, depois das taxas">
          {v.profit}/{v.nPairs}
        </span>
        <span className="num cem__cell" data-col="sharpe" title={`Melhor Sharpe entre os pares; a barra da sorte é ${fmt.num(d.criterion.luck_sharpe, 2)}`}>
          <b className={(v.bestSharpe ?? -9) > d.criterion.luck_sharpe ? "tone-pos" : ""}>{sharpe(v.bestSharpe)}</b>
        </span>
        <span className="num cem__cell" data-col="be" title="Custo por lado em que o lucro zera (mediana dos pares)">
          {breakevenText(v.breakeven, bePct)}
        </span>
        <span className="cem__verdict">
          <Badge tone={v.alive ? "pos" : "neg"} outline={!v.alive}>
            {v.alive ? "viva" : "morta"}
          </Badge>
          <span className="cem__why">{v.alive ? `${v.pairsAlive} de ${v.nPairs} pares` : v.portfolio && v.reason === "prejuizo" ? "dá prejuízo" : REASON_TEXT[v.reason]}</span>
        </span>
      </summary>
      <Detail v={v} d={d} />
    </details>
  );
}

export function CemiterioPanel() {
  const status = useLab((s) => s.status);
  const data = useLab((s) => s.data);
  const error = useLab((s) => s.error);
  const cost = useSettings((s) => s.cost_pct);
  useEffect(() => {
    void loadLab();
  }, []);
  const ci = data ? costIndex(data, cost) : 0;
  const rows = useMemo(() => (data ? views(data, ci) : null), [data, ci]);
  const n = data ? survivors(data, ci) : 0;
  return (
    <Panel
      area="cem"
      title="Cemitério de estratégias"
      sub={
        data
          ? `${data.strategies.length} estratégias · ${data.trials} variações · ${data.pairs.length} pares · fora da amostra ${isoShort(data.window.oos_start)} → ${isoShort(data.window.end)}`
          : "as estratégias famosas na mesma régua"
      }
      state={<LiveDot state={status === "error" ? "error" : status === "ready" ? "done" : "busy"} label={data ? `pesquisa de ${isoShort(data.generated)}` : status === "error" ? "erro" : "carregando"} />}
    >
      {status === "error" ? (
        <PanelState kind="error" title="O resultado da pesquisa não carregou" detail={error}>
          <button type="button" className="btn" onClick={() => void loadLab({ retry: true })}>
            tentar de novo
          </button>
        </PanelState>
      ) : !data || !rows ? (
        <SkeletonStack lines={8} label="Carregando o cemitério" />
      ) : (
        <div className="cem">
          <div className="cem__head">
            <div className="cem__hero" aria-live="polite">
              <b className={"num cem__count " + (n > 0 ? "tone-pos" : "tone-neg")} data-num="lab_survivors">
                {n} de {data.strategies.length}
              </b>
              <span className="cem__lead">
                sobrevivem a <b className="num">{fmt.num(data.costs[ci], 3)}%</b> por lado
              </span>
            </div>
            <p className="cem__crit">
              <b>Viva</b> = ganha do comprar e segurar (Sharpe, fora da amostra, depois das taxas) <b>e</b> passa da barra da sorte em {data.criterion.min_pairs} de {data.pairs.length} pares. A barra:
              com {data.trials} tentativas sem habilidade nenhuma, a melhor chega a Sharpe <b className="num">{fmt.num(data.criterion.luck_sharpe, 2)}</b> só por sorte.
            </p>
            <div className="cem__cost">
              <CostControl id="cost-range-cem" />
            </div>
          </div>
          <div className="cem__bh label">
            <span>comprar e segurar no mesmo trecho:</span>
            {data.pairs.map((p) => {
              const b = data.baselines[p].bh[ci];
              return (
                <span key={p} className="num">
                  {short(p)} <b className={(b[0] ?? 0) >= 0 ? "tone-pos" : "tone-neg"}>{pctOr(b[0], 0)}</b> <span className="tone-dim">Sharpe {sharpe(b[1])}</span>
                </span>
              );
            })}
          </div>
          <div className="cem__legend label" aria-hidden="true">
            <span>C&amp;S = comprar e segurar</span>
            {(["viva", "ganha", "lucro", "perde"] as const).map((k) => (
              <span key={k}>
                <span className="cem__dot cem__dot--sm" data-state={k} /> {k === "viva" ? "viva" : k === "ganha" ? "ganha do C&S, não passa da sorte" : k === "lucro" ? "lucro, perde do C&S" : "prejuízo"}
              </span>
            ))}
          </div>
          <div className="cem__cols label" aria-hidden="true">
            <span>estratégia</span>
            <span>pares</span>
            <span>ganha do C&S</span>
            <span>com lucro</span>
            <span>melhor Sharpe</span>
            <span>equilíbrio</span>
            <span>veredito</span>
          </div>
          <div className="cem__rows">
            {rows.map((v) => (
              <Row key={v.key} v={v} d={data} />
            ))}
          </div>
          <ul className="cem__notes">
            {data.notes.map((t) => (
              <li key={t}>{t}</li>
            ))}
            <li>
              Resultado gerado por <code>{data.engine}</code> com candles públicos da Binance de {isoShort(data.window.start)} a {isoShort(data.window.end)}; walk-forward em blocos de {data.window.block_months} meses (o primeiro só treina). Clique numa linha
              para ver cada par.
            </li>
          </ul>
        </div>
      )}
    </Panel>
  );
}
