// Modo Lite: a mesma conclusão do Pro para quem nunca operou. Lê as mesmas stores e as mesmas
// funções derivadas; não recalcula nem arredonda nada por conta própria.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { TM_REPLAYS, boot, selectSymbol } from "../app/controller";
import { useTmDerived } from "../app/derived";
import * as fmt from "../app/format";
import { DEFAULT_GRID, gridVerdict, summarizeCombo } from "../engine/backtest";
import { CostControl } from "../panels/CostControl";
import { PriceChart } from "../panels/PriceChart";
import { TopBar } from "../panels/TopBar";
import { setMode } from "../state/mode";
import { MONTH_OPTIONS, README_MONTHS, splitCost, useSettings } from "../state/settings";
import { useAnalysis, useMarket, useTelemetry } from "../state/stores";
import { LiveDot, Meter, NoData, Panel, PanelState, Segmented, SkeletonStack, Stat } from "../ui";
import { GLOSSARY, averageSentence, liteVerdict, statusSentence, variationsSentences } from "./model";
import "./lite.css";

const COMBOS = DEFAULT_GRID.anchors.length * DEFAULT_GRID.ranges.length * DEFAULT_GRID.stops.length * DEFAULT_GRID.targets.length * DEFAULT_GRID.minRanges.length;

/** O que está carregando agora, em palavras; null quando não há nada pendente. */
function useLoadingText(): string | null {
  const boot_ = useMarket((m) => m.boot);
  const hist = useAnalysis((a) => a.history);
  const tm = useAnalysis((a) => a.tmStatus);
  const symbol = useSettings((s) => s.symbol);
  if (boot_ !== "pronto" && boot_ !== "erro") return "conectando aos dados públicos da Binance";
  if (hist.status === "loading") return `baixando candles de ${symbol}${hist.total ? ` (${hist.done} de ${hist.total} pedidos)` : ""}`;
  if (tm === "loading") return `rodando ${fmt.int(TM_REPLAYS)} simulações`;
  return null;
}

function Verdict() {
  const d = useTmDerived();
  const cost = useSettings((s) => s.cost_pct);
  const symbol = useSettings((s) => s.symbol);
  const anchor = useSettings((s) => s.anchor_utc);
  const range = useSettings((s) => s.range_minutes);
  const stop = useSettings((s) => s.stop_rule);
  const targetR = useSettings((s) => s.target_r);
  const source = useAnalysis((a) => a.planSource);
  const plan = useAnalysis((a) => a.plan);
  const note = useAnalysis((a) => a.planNote);
  const tmError = useAnalysis((a) => a.tmError);
  const histError = useAnalysis((a) => a.history.error);
  const offline = useMarket((m) => m.boot === "erro");
  const error = useMarket((m) => m.error);
  const loading = useLoadingText();
  const v = d ? liteVerdict(d.stats.avg_net_r, cost) : null;
  const when = plan ? (plan.entry_time ?? plan.session_start) : 0;
  const limited = /418|429/.test(error ?? "");
  return (
    <Panel area="verdict" title="Veredito" sub={`${symbol} · simulação com candles reais do próprio par`} state={<LiveDot state={offline ? "error" : loading ? "busy" : d ? "done" : "idle"} label={offline ? "erro" : loading ? "calculando" : d ? "calculado" : "—"} />}>
      <div className="lite__body">
        {d && v ? (
          <>
            <p className="lite__title" data-tone={v.tone} aria-live="polite">
              {v.title}
            </p>
            <div className="lite__hero">
              <Stat size="xl" label="resultado médio por operação" num="avg_net_r" value={d.stats.avg_net_r} format={(x) => fmt.rr(x)} tone={d.stats.avg_net_r < 0 ? "neg" : "signal"} />
              <p className="lite__text">
                Em {fmt.int(d.tm.result.replays)} simulações do {source === "live" ? "rompimento de hoje" : `último rompimento (${fmt.ddmm(when)} às ${fmt.hhmm(when)})`} de {symbol}, {averageSentence(d.stats.avg_net_r)}
              </p>
            </div>
            <p className="lite__text lite__text--dim">
              {d.history.fired ? (
                <>
                  No histórico real, sem simulação: nas {d.history.sessions} sessões anteriores a regra disparou {d.history.fired} {d.history.fired === 1 ? "vez" : "vezes"}, com resultado médio de{" "}
                  <b className={(d.history.avg_net_r ?? 0) < 0 ? "tone-neg" : "tone-signal"} data-num="hist_avg">
                    {fmt.rr(d.history.avg_net_r ?? 0)}
                  </b>
                  {d.history.fired < 30 ? " (poucos casos para concluir sozinho)." : "."}
                </>
              ) : (
                `No histórico real, a regra não disparou em nenhuma das ${d.history.sessions} sessões anteriores.`
              )}
            </p>
            {v.tone === "mixed" ? <p className="lite__text lite__text--warn">Um resultado positivo numa simulação de um par não é vantagem comprovada. Veja abaixo o que acontece quando a regra é testada em dados que ela nunca viu.</p> : null}
            <p className="lite__rule">
              Regra testada: sessão a partir de {anchor} UTC · faixa da primeira {range === 60 ? "hora" : `${range} min`} · stop no {stop === "or-mid" ? "meio" : "fundo"} da faixa · alvo de {fmt.num(targetR, 1)}R. Dá para mudar no modo Pro.
            </p>
          </>
        ) : offline ? (
          <PanelState kind={limited ? "limited" : "error"} title={limited ? "A Binance limitou os pedidos" : "Sem acesso aos dados públicos"} detail={error}>
            <button type="button" className="btn" onClick={() => void boot()}>
              tentar de novo
            </button>
            <span className="label">nenhum número é mostrado sem dado real</span>
          </PanelState>
        ) : tmError || histError ? (
          <PanelState kind="error" title="A simulação não rodou" detail={tmError ?? histError} />
        ) : !loading && !plan && note ? (
          <PanelState kind="empty" title="Sem rompimento para simular" detail={`${note} Também não há rompimento deste par no histórico carregado.`} />
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

function Chances() {
  const d = useTmDerived();
  const order = useAnalysis((a) => a.order);
  const orderError = useAnalysis((a) => a.orderError);
  const account = useSettings((s) => s.account);
  const maxLoss = useSettings((s) => s.max_loss_per_trade);
  const offline = useMarket((m) => m.boot === "erro");
  return (
    <Panel area="chances" title="Quantas vezes dá certo" sub="de todas as simulações">
      <div className="lite__body">
        {d ? (
          <>
            <div role="img" aria-label={`Bateu no alvo em ${fmt.pct(d.mc.pct.target, 1)}, bateu no stop em ${fmt.pct(d.mc.pct.stop, 1)}, não bateu em nenhum dos dois em ${fmt.pct(d.mc.pct.open, 1)}`}>
              <div className="odds__bar lite__bar">
                <span style={{ width: d.mc.pct.target + "%" }} data-k="target" />
                <span style={{ width: d.mc.pct.open + "%" }} data-k="open" />
                <span style={{ width: d.mc.pct.stop + "%" }} data-k="stop" />
              </div>
            </div>
            <ul className="lite__list">
              <li>
                <i className="lite__sw" data-k="target" aria-hidden="true" />
                <b data-num="pct_target">{fmt.pct(d.mc.pct.target, 1)}</b> bateram no alvo (ganho)
              </li>
              <li>
                <i className="lite__sw" data-k="stop" aria-hidden="true" />
                <b data-num="pct_stop">{fmt.pct(d.mc.pct.stop, 1)}</b> bateram no stop (perda)
              </li>
              <li>
                <i className="lite__sw" data-k="open" aria-hidden="true" />
                <b data-num="pct_open">{fmt.pct(d.mc.pct.open, 1)}</b> não bateram em nenhum dos dois até o fim da sessão
              </li>
            </ul>
            <p className="lite__text">
              {d.breakeven !== null ? (
                <>
                  Para empatar, o alvo teria de vir antes do stop em <b data-num="breakeven">{fmt.pct(d.breakeven, 0)}</b> das vezes. Veio em <b data-num="hit_rate">{d.hitRate !== null ? fmt.pct(d.hitRate, 0) : "—"}</b>.
                </>
              ) : (
                <>
                  Com este custo é <b data-num="breakeven">impossível</b> empatar: mesmo acertando sempre, o ganho do alvo não paga as taxas. O alvo veio antes do stop em <b data-num="hit_rate">{d.hitRate !== null ? fmt.pct(d.hitRate, 0) : "—"}</b> das vezes.
                </>
              )}
            </p>
            <Meter value={(d.hitRate ?? 0) / 100} tone={d.breakeven !== null && d.hitRate !== null && d.hitRate >= d.breakeven ? "signal" : "neg"} marks={d.breakeven !== null ? [d.breakeven / 100] : []} label="Quantas vezes o alvo veio antes do stop, contra o necessário para empatar" />
            {order ? (
              <p className="lite__text lite__money">
                Em dinheiro, com {fmt.num(account, 0)} {order.quote} de capital e no máximo {fmt.num(maxLoss, 0)} de perda por operação: se bater no alvo,{" "}
                <b className={order.reward_at_target > 0 ? "tone-pos" : "tone-neg"} data-num="at_target">
                  {fmt.signed(order.reward_at_target)}
                </b>
                ; se bater no stop,{" "}
                <b className="tone-neg" data-num="at_stop">
                  {fmt.num(-order.max_loss)}
                </b>{" "}
                {order.quote}, já com as taxas.
              </p>
            ) : orderError ? (
              <p className="lite__text lite__text--dim">Não dá para montar esta operação com o capital configurado: {orderError}</p>
            ) : null}
          </>
        ) : offline ? (
          <NoData />
        ) : (
          <SkeletonStack lines={6} label="Contando as simulações" />
        )}
      </div>
    </Panel>
  );
}

function Cost() {
  const d = useTmDerived();
  const targetR = useSettings((s) => s.target_r);
  const impossible = d ? d.evenR > targetR : false;
  return (
    <Panel area="cost" title="Quanto o custo pesa" sub="arraste e veja o veredito mudar">
      <div className="lite__body">
        <CostControl plain />
        {d ? (
          <p className="lite__text" aria-live="polite">
            {impossible ? (
              <>
                Com este custo o preço teria de andar <b data-num="even_r">{fmt.rr(d.evenR)}</b> a seu favor só para pagar as taxas, mais do que o alvo de {fmt.rr(targetR, 1)}. Não há como empatar.
              </>
            ) : (
              <>
                Só para pagar os custos, o preço precisa andar <b data-num="even_r">{fmt.rr(d.evenR)}</b> a seu favor. O alvo fica em {fmt.rr(targetR, 1)}; o stop, em {fmt.rr(-1, 0)}.
              </>
            )}
          </p>
        ) : null}
        <p className="lite__text lite__text--dim">R é o valor arriscado: a distância entre a entrada e o stop. Quanto mais estreita a faixa do dia, mais o custo pesa em R.</p>
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
  const set = useSettings((s) => s.set);
  const offline = useMarket((m) => m.boot === "erro");
  // a mesma conta do painel da grade no Pro: resumo de cada combinação no custo atual e as contagens do relatório
  const verdict = useMemo(() => (grid.result ? gridVerdict(grid.result.combos.map((c) => summarizeCombo(c, splitCost(cost)))) : null), [grid.result, cost]);
  const info = grid.result;
  const shownMonths = info ? grid.months : months;
  const shownSymbol = info ? grid.symbol : symbol;
  const stale = !!info && (grid.months !== months || grid.symbol !== symbol);
  const loading = grid.status === "loading" || hist.status === "loading";
  const text = verdict ? variationsSentences(verdict) : null;
  return (
    <Panel
      area="vary"
      title="E se mudar a regra?"
      sub={info ? `${shownSymbol} · ${shownMonths} meses · ${fmt.ddmmyy(info.first, "UTC")} a ${fmt.ddmmyy(info.last, "UTC")}` : `${symbol} · ${months} meses`}
      state={<LiveDot state={grid.status === "error" ? "error" : loading ? "busy" : verdict ? "done" : "idle"} label={loading ? "calculando" : ""} />}
    >
      <div className="lite__body" data-stale={stale}>
        {verdict && text ? (
          <>
            <p className="lite__text">
              Testamos {COMBOS} variações da regra (horário da sessão, tamanho da faixa, stop e alvo) em {shownMonths} meses de {shownSymbol}. Cada uma foi escolhida numa parte dos dados e conferida em outra, que ela nunca viu.
            </p>
            <dl className="lite__counts" aria-live="polite">
              <div>
                <dt>{text.top}</dt>
                {verdict.topN ? (
                  <dd className={verdict.topPositive > verdict.topN / 2 ? "tone-signal" : "tone-neg"} data-num="grid_top">
                    {verdict.topPositive} de {verdict.topN}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt>{text.all}</dt>
                {verdict.allN ? (
                  <dd className={verdict.allPositive > 0 ? "tone-signal" : "tone-neg"} data-num="grid_all">
                    {verdict.allPositive} de {verdict.allN}
                  </dd>
                ) : null}
              </div>
            </dl>
          </>
        ) : grid.status === "error" || (hist.status === "error" && !verdict) ? (
          <PanelState kind={/418|429/.test(grid.error ?? hist.error ?? "") ? "limited" : "error"} title="O teste das variações não rodou" detail={grid.error ?? hist.error} />
        ) : offline ? (
          <NoData />
        ) : (
          <SkeletonStack lines={5} label="Testando as variações" />
        )}
        {loading && (stale || !verdict) ? (
          <div className="lite__progress" role="status">
            <span className="label">{hist.status === "loading" ? `${symbol} · ${months} meses · baixando candles (${hist.done} de ${hist.total || "?"} pedidos)` : `calculando ${grid.done} de ${grid.total}`}</span>
            <Meter value={hist.status === "loading" ? (hist.total ? hist.done / hist.total : 0) : grid.total ? grid.done / grid.total : 0} tone="signal" label="Progresso do teste" />
          </div>
        ) : null}
        <div className="lite__period">
          <Segmented label="Meses de histórico" value={months} options={MONTH_OPTIONS.map((m) => ({ value: m, label: m + " meses" }))} onChange={(v) => set({ months: v })} />
          <span className="lite__text lite__text--dim">
            Mostrando {shownMonths} meses. {shownMonths === README_MONTHS ? "É o mesmo período da conclusão do projeto (0 de 88, em BTC e SOL)." : `A conclusão do projeto (0 de 88) usa ${README_MONTHS} meses, em BTC e SOL.`}
          </span>
        </div>
      </div>
    </Panel>
  );
}

function Now() {
  const symbol = useSettings((s) => s.symbol);
  const universe = useMarket(useShallow((m) => m.universe));
  const ready = useMarket((m) => m.boot === "pronto");
  const offline = useMarket((m) => m.boot === "erro");
  const signal = useAnalysis((a) => a.signal);
  const ws = useTelemetry((t) => t.wsStatus);
  return (
    <Panel area="now" title="Agora" sub="preço ao vivo · candles de 5 minutos · horários de Brasília" state={<LiveDot state={ws === "ao vivo" ? "live" : ws === "parado" ? "error" : "busy"} label={ws} />}>
      <div className="lite__body">
        <div className="lite__nowHead">
          <label className="field">
            <span className="label">moeda</span>
            <select className="input" value={symbol} onChange={(e) => selectSymbol(e.target.value)}>
              {universe.some((u) => u.symbol === symbol) ? null : <option value={symbol}>{symbol}</option>}
              {universe.map((u) => (
                <option key={u.symbol} value={u.symbol}>
                  {u.symbol}
                </option>
              ))}
            </select>
          </label>
          <p className="lite__text" aria-live="polite">
            {signal && ready ? statusSentence(signal, (ms) => fmt.hhmm(ms)) : offline ? "Sem dados ao vivo." : "Carregando os candles de hoje…"}
          </p>
        </div>
        {ready ? (
          <div className="lite__chart">
            <PriceChart />
          </div>
        ) : offline ? (
          <NoData />
        ) : (
          <SkeletonStack lines={6} label="Carregando o gráfico" />
        )}
        <p className="lite__text lite__text--dim">A caixa âmbar é a faixa inicial. A linha tracejada é o topo da faixa: fechar acima dela é o rompimento.</p>
      </div>
    </Panel>
  );
}

function Foot() {
  return (
    <section className="lite__foot" style={{ gridArea: "foot" }}>
      <details className="lite__glossary">
        <summary>O que significa cada termo</summary>
        <dl>
          {GLOSSARY.map(([term, text]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="lite__more">
        <p className="lite__text lite__text--dim">Isto é simulação com candles recentes do próprio par, não previsão. Não é recomendação de investimento. Day trade perde dinheiro para a maioria.</p>
        <button type="button" className="btn" onClick={() => setMode("pro")}>
          ver todos os dados no modo Pro
        </button>
      </div>
    </section>
  );
}

export function LiteBoard() {
  return (
    <>
      <TopBar />
      <Verdict />
      <Chances />
      <Cost />
      <Variations />
      <Now />
      <Foot />
    </>
  );
}
