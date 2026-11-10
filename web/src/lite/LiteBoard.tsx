// Modo Lite: a conclusão do Pro numa tela só, para quem nunca operou. Lê as mesmas stores e as
// mesmas funções derivadas; não recalcula nem arredonda nada por conta própria.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { TM_REPLAYS, boot, selectSymbol } from "../app/controller";
import { useTmDerived } from "../app/derived";
import * as fmt from "../app/format";
import { DEFAULT_GRID, gridVerdict, summarizeCombo } from "../engine/backtest";
import { CostControl } from "../panels/CostControl";
import { TopBar } from "../panels/TopBar";
import { setMode } from "../state/mode";
import { README_MONTHS, splitCost, useSettings } from "../state/settings";
import { useAnalysis, useMarket } from "../state/stores";
import { LiveDot, NoData, Panel, PanelState, SkeletonStack, Stat } from "../ui";
import { averageSentence, liteVerdict } from "./model";
import "./lite.css";

const COMBOS = DEFAULT_GRID.anchors.length * DEFAULT_GRID.ranges.length * DEFAULT_GRID.stops.length * DEFAULT_GRID.targets.length * DEFAULT_GRID.minRanges.length;

/** O que está carregando agora, em palavras; null quando não há nada pendente. */
function useLoadingText(): string | null {
  const boot_ = useMarket((m) => m.boot);
  const hist = useAnalysis((a) => a.history);
  const tm = useAnalysis((a) => a.tmStatus);
  if (boot_ !== "pronto" && boot_ !== "erro") return "conectando aos dados públicos da Binance";
  if (hist.status === "loading") return `baixando candles${hist.total ? ` (${hist.done} de ${hist.total})` : ""}`;
  if (tm === "loading") return `rodando ${fmt.int(TM_REPLAYS)} simulações`;
  return null;
}

function Verdict() {
  const d = useTmDerived();
  const cost = useSettings((s) => s.cost_pct);
  const symbol = useSettings((s) => s.symbol);
  const universe = useMarket(useShallow((m) => m.universe));
  const plan = useAnalysis((a) => a.plan);
  const note = useAnalysis((a) => a.planNote);
  const tmError = useAnalysis((a) => a.tmError);
  const histError = useAnalysis((a) => a.history.error);
  const offline = useMarket((m) => m.boot === "erro");
  const error = useMarket((m) => m.error);
  const loading = useLoadingText();
  const v = d ? liteVerdict(d.stats.avg_net_r, cost) : null;
  const limited = /418|429/.test(error ?? "");
  return (
    <Panel
      area="verdict"
      title="Veredito"
      sub={d ? `${fmt.int(d.tm.result.replays)} simulações com candles reais` : "simulação com candles reais"}
      state={
        <select className="input lite__pair" aria-label="Moeda" value={symbol} onChange={(e) => selectSymbol(e.target.value)}>
          {universe.some((u) => u.symbol === symbol) ? null : <option value={symbol}>{symbol}</option>}
          {universe.map((u) => (
            <option key={u.symbol} value={u.symbol}>
              {u.symbol}
            </option>
          ))}
        </select>
      }
    >
      <div className="lite__body">
        {d && v ? (
          <>
            <p className="lite__title" data-tone={v.tone} aria-live="polite">
              {v.title}
            </p>
            <div className="lite__hero">
              <Stat size="xl" label="resultado médio" num="avg_net_r" value={d.stats.avg_net_r} format={(x) => fmt.rr(x)} tone={d.stats.avg_net_r < 0 ? "neg" : "signal"} />
              <p className="lite__text">{averageSentence(d.stats.avg_net_r)}</p>
            </div>
            <div role="img" aria-label={`Bateu no alvo em ${fmt.pct(d.mc.pct.target, 1)}, bateu no stop em ${fmt.pct(d.mc.pct.stop, 1)}, nenhum dos dois em ${fmt.pct(d.mc.pct.open, 1)}`}>
              <div className="odds__bar lite__bar">
                <span style={{ width: d.mc.pct.target + "%" }} data-k="target" />
                <span style={{ width: d.mc.pct.open + "%" }} data-k="open" />
                <span style={{ width: d.mc.pct.stop + "%" }} data-k="stop" />
              </div>
            </div>
            <ul className="lite__legend">
              <li>
                <i className="lite__sw" data-k="target" aria-hidden="true" />
                ganhou <b data-num="pct_target">{fmt.pct(d.mc.pct.target, 1)}</b>
              </li>
              <li>
                <i className="lite__sw" data-k="open" aria-hidden="true" />
                nem um nem outro <b data-num="pct_open">{fmt.pct(d.mc.pct.open, 1)}</b>
              </li>
              <li>
                <i className="lite__sw" data-k="stop" aria-hidden="true" />
                perdeu <b data-num="pct_stop">{fmt.pct(d.mc.pct.stop, 1)}</b>
              </li>
            </ul>
          </>
        ) : offline ? (
          <PanelState kind={limited ? "limited" : "error"} title={limited ? "A Binance limitou os pedidos" : "Sem acesso aos dados públicos"} detail={error}>
            <button type="button" className="btn" onClick={() => void boot()}>
              tentar de novo
            </button>
          </PanelState>
        ) : tmError || histError ? (
          <PanelState kind="error" title="A simulação não rodou" detail={tmError ?? histError} />
        ) : !loading && !plan && note ? (
          <PanelState kind="empty" title="Sem rompimento para simular" detail="Esta moeda não teve nenhum rompimento no período carregado." />
        ) : (
          <>
            <p className="lite__text lite__text--dim" role="status">
              {loading ?? "preparando a simulação"}…
            </p>
            <SkeletonStack lines={4} label="Calculando o veredito" />
          </>
        )}
      </div>
    </Panel>
  );
}

function Cost() {
  return (
    <Panel area="cost" title="Taxa" sub="arraste e veja o resultado mudar">
      <div className="lite__body">
        <CostControl plain />
      </div>
    </Panel>
  );
}

function Variations() {
  const grid = useAnalysis((a) => a.grid);
  const hist = useAnalysis((a) => a.history);
  const cost = useSettings((s) => s.cost_pct);
  const months = useSettings((s) => s.months);
  const symbol = useSettings((s) => s.symbol);
  const offline = useMarket((m) => m.boot === "erro");
  // a mesma conta do painel da grade no Pro: resumo de cada combinação no custo atual e as contagens do relatório
  const verdict = useMemo(() => (grid.result ? gridVerdict(grid.result.combos.map((c) => summarizeCombo(c, splitCost(cost)))) : null), [grid.result, cost]);
  const info = grid.result;
  const shownMonths = info ? grid.months : months;
  const shownSymbol = info ? grid.symbol : symbol;
  const stale = !!info && (grid.months !== months || grid.symbol !== symbol);
  const loading = grid.status === "loading" || hist.status === "loading";
  return (
    <Panel area="vary" title="E mudando a regra?" sub={`${COMBOS} variações testadas`} state={<LiveDot state={grid.status === "error" ? "error" : loading ? "busy" : verdict ? "done" : "idle"} label={loading ? "calculando" : ""} />}>
      <div className="lite__body" data-stale={stale}>
        {verdict ? (
          <div className="lite__count" aria-live="polite">
            {verdict.allN ? (
              <>
                <b className={verdict.allPositive > 0 ? "tone-signal" : "tone-neg"} data-num="grid_all">
                  {verdict.allPositive} de {verdict.allN}
                </b>
                <span className="lite__text">deram lucro em dados que não tinham visto</span>
              </>
            ) : (
              <span className="lite__text">Nenhuma variação operou vezes suficientes para comparar.</span>
            )}
          </div>
        ) : grid.status === "error" || (hist.status === "error" && !verdict) ? (
          <PanelState kind={/418|429/.test(grid.error ?? hist.error ?? "") ? "limited" : "error"} title="O teste não rodou" detail={grid.error ?? hist.error} />
        ) : offline ? (
          <NoData />
        ) : (
          <SkeletonStack lines={2} label="Testando as variações" />
        )}
        <p className="lite__text lite__text--dim">
          {shownMonths} meses de {shownSymbol}. A conclusão do projeto {shownMonths === README_MONTHS ? "usa este mesmo período" : `usa ${README_MONTHS} meses`}: 0 de 88.
        </p>
      </div>
    </Panel>
  );
}

function Foot() {
  return (
    <section className="lite__foot" style={{ gridArea: "foot" }}>
      <p className="lite__text lite__text--dim">Simulação, não previsão. Não é recomendação de investimento.</p>
      <button type="button" className="btn" onClick={() => setMode("pro")}>
        ver todos os dados
      </button>
    </section>
  );
}

export function LiteBoard() {
  return (
    <>
      <TopBar />
      <Verdict />
      <Cost />
      <Variations />
      <Foot />
    </>
  );
}
