// Preço ao vivo do par escolhido: candles de 5m da sessão, a faixa inicial e o candle de rompimento.
// Tudo desenhado em canvas a partir dos candles reais (REST + WebSocket).
import * as fmt from "../app/format";
import { STATUS_LABEL } from "../engine/plan";
import { useSettings } from "../state/settings";
import { useAnalysis, useMarket, useTelemetry } from "../state/stores";
import { LiveDot, NoData, Panel, SkeletonStack, Stat } from "../ui";
import { PriceChart } from "./PriceChart";

function Readout() {
  const symbol = useSettings((s) => s.symbol);
  const price = useMarket((m) => m.prices[symbol]);
  const signal = useAnalysis((a) => a.signal);
  const dec = price !== undefined ? fmt.priceDecimals(price) : 2;
  const p = (v: number | undefined) => (v === undefined ? "—" : fmt.num(v, dec));
  return (
    <div className="price__read">
      <Stat label="último" value={price} format={(v) => fmt.num(v, dec)} tone="raw" />
      <Stat label="topo da faixa" text={p(signal?.range_high)} tone="signal" />
      <Stat label="fundo da faixa" text={p(signal?.range_low)} />
      <Stat label="largura" text={signal?.range_pct !== undefined ? fmt.pct(signal.range_pct) : "—"} />
      <Stat label="janela até" text={signal ? fmt.hhmm(signal.window_end) : "—"} hint={signal ? `zerar ${fmt.hhmm(signal.flat_by)} BRT` : undefined} />
      <div className="price__status" aria-live="polite">
        <span className="label">estado do sinal</span>
        <span className={signal?.status === "triggered" ? "tone-signal" : "tone-dim"}>
          {signal ? STATUS_LABEL[signal.status].toLowerCase() + (signal.trigger ? ` às ${fmt.hhmm(signal.trigger.time)} BRT` : "") : "—"}
        </span>
      </div>
    </div>
  );
}

export function PricePanel() {
  const symbol = useSettings((s) => s.symbol);
  const range = useSettings((s) => s.range_minutes);
  const anchor = useSettings((s) => s.anchor_utc);
  const ready = useMarket((m) => m.boot === "pronto");
  const offline = useMarket((m) => m.boot === "erro");
  const ws = useTelemetry((t) => t.wsStatus);
  return (
    <Panel
      area="price"
      title="Preço ao vivo"
      sub={`${symbol} · 5m · âncora ${anchor} UTC · faixa de ${range} min · horários em BRT`}
      state={<LiveDot state={ws === "ao vivo" ? "live" : ws === "parado" ? "error" : "busy"} label={ws} />}
    >
      {ready ? (
        <>
          <div className="price__chart">
            <PriceChart />
          </div>
          <Readout />
        </>
      ) : offline ? (
        <NoData />
      ) : (
        <SkeletonStack lines={7} label="Carregando candles" />
      )}
    </Panel>
  );
}
