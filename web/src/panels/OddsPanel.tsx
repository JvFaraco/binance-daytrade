// Ao lado da esfera: as odds do plano e o controle de custo. Arrastar o custo muda a esfera e
// estes números juntos, sem refazer os sorteios: só o R líquido de cada replay é recalculado.
import { useTmDerived } from "../app/derived";
import * as fmt from "../app/format";
import { useAnalysis, useMarket } from "../state/stores";
import { LiveDot, Meter, NoData, Panel, SkeletonStack, Stat, Tooltip } from "../ui";
import { CostControl } from "./CostControl";

export function OddsPanel() {
  const d = useTmDerived();
  const status = useAnalysis((a) => a.tmStatus);
  const offline = useMarket((m) => m.boot === "erro");
  const tone = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "neutral");
  return (
    <Panel area="stats" title="Odds do plano" sub="líquido de taxa e slippage · não é previsão" state={<LiveDot state={status === "loading" ? "busy" : d ? "done" : "idle"} label={d ? "calculado" : status === "loading" ? "calculando" : "—"} />}>
      <div className="odds">
        {d ? (
          <>
            <div className="odds__hero">
              <Stat size="xl" label="R médio líquido" num="avg_net_r" value={d.stats.avg_net_r} format={(v) => fmt.rr(v)} tone={tone(d.stats.avg_net_r)} />
              <Stat size="lg" label="R líquido > 0" value={d.stats.win_pct} format={(v) => fmt.pct(v, 1)} tone={tone(d.stats.win_pct - 50)} />
            </div>
            <div className="odds__row">
              <Stat label="p5" value={d.stats.p5} format={(v) => fmt.rr(v)} tone={tone(d.stats.p5)} />
              <Stat label="p50" value={d.stats.p50} format={(v) => fmt.rr(v)} tone={tone(d.stats.p50)} />
              <Stat label="p95" value={d.stats.p95} format={(v) => fmt.rr(v)} tone={tone(d.stats.p95)} />
              <Tooltip side="right" text="Maior queda da soma de R líquido, acumulando os replays na ordem em que foram sorteados.">
                <Stat label="máx. dd" value={d.stats.max_dd_r} format={(v) => fmt.num(v, 0) + "R"} tone="neg" />
              </Tooltip>
            </div>
            <div className="odds__out" role="img" aria-label={`Alvo primeiro em ${fmt.pct(d.mc.pct.target, 1)}, stop primeiro em ${fmt.pct(d.mc.pct.stop, 1)}, nenhum dos dois em ${fmt.pct(d.mc.pct.open, 1)}`}>
              <div className="odds__bar">
                <span style={{ width: d.mc.pct.target + "%" }} data-k="target" />
                <span style={{ width: d.mc.pct.open + "%" }} data-k="open" />
                <span style={{ width: d.mc.pct.stop + "%" }} data-k="stop" />
              </div>
              <div className="odds__barLabels label">
                <span>
                  alvo <span data-num="pct_target">{fmt.pct(d.mc.pct.target, 1)}</span>
                </span>
                <span>
                  aberto <span data-num="pct_open">{fmt.pct(d.mc.pct.open, 1)}</span>
                </span>
                <span>
                  stop <span data-num="pct_stop">{fmt.pct(d.mc.pct.stop, 1)}</span>
                </span>
              </div>
            </div>
            <div className="odds__even">
              <div className="odds__evenHead">
                <span className="label">alvo antes do stop</span>
                <span className="num">
                  <span data-num="hit_rate">{d.hitRate !== null ? fmt.pct(d.hitRate, 0) : "—"}</span>{" "}
                  <span className="tone-mute">
                    · empata com <span data-num="breakeven">{d.breakeven !== null ? fmt.pct(d.breakeven, 0) : "impossível"}</span>
                  </span>
                </span>
              </div>
              <Meter value={(d.hitRate ?? 0) / 100} tone={d.breakeven !== null && d.hitRate !== null && d.hitRate >= d.breakeven ? "pos" : "neg"} marks={d.breakeven !== null ? [d.breakeven / 100] : []} label="Acerto observado contra o acerto que empata" />
            </div>
            {d.blocks ? (
              <Tooltip side="right" text={`Os mesmos ${fmt.int(d.blocks.replays)} replays, mas copiando trechos seguidos de sessões reais (em média ${d.blocks.mean_block} candles) em vez de candles soltos: mantém a sequência de calmaria e agitação que o sorteio solto perde. Nenhum dos dois até zerar: ${fmt.pct(d.blocks.pct.open, 1)}.`}>
                <p className="odds__blocks num">
                  <span className="label">em blocos</span>{" "}
                  <b className={d.blocks.avg_net_r >= 0 ? "tone-pos" : "tone-neg"} data-num="blocks_avg">
                    {fmt.rr(d.blocks.avg_net_r)}
                  </b>{" "}
                  <span className="tone-mute">
                    · alvo {fmt.pct(d.blocks.pct.target, 1)} · stop {fmt.pct(d.blocks.pct.stop, 1)}
                  </span>
                </p>
              </Tooltip>
            ) : null}
            <p className="odds__verdict" aria-live="polite">
              {d.verdict}
            </p>
            <p className="odds__hist">
              <span className="label">histórico real</span>{" "}
              {d.history.fired
                ? `${d.history.fired} disparos em ${d.history.sessions} sessões · ${d.history.target} alvo · ${d.history.stop} stop · ${d.history.open} abertos · R médio `
                : `a regra não disparou em nenhuma das ${d.history.sessions} sessões`}
              {d.history.fired && d.history.avg_net_r !== null ? (
                <span className={d.history.avg_net_r >= 0 ? "tone-pos" : "tone-neg"} data-num="hist_avg">
                  {fmt.rr(d.history.avg_net_r)}
                </span>
              ) : null}
              {d.history.fired && d.history.fired < 30 ? <span className="tone-mute"> · amostra pequena</span> : null}
            </p>
          </>
        ) : offline ? (
          <NoData />
        ) : (
          <SkeletonStack lines={7} label="Calculando as odds" />
        )}
        <CostControl />
      </div>
    </Panel>
  );
}
