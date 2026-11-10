// Fita de negócios ao vivo do par e telemetria real da própria página.
import { useEffect } from "react";
import { startFpsMeter } from "../app/fps";
import * as fmt from "../app/format";
import { live } from "../app/live";
import { WEIGHT_LIMIT_1M } from "../data/rest";
import { useSettings } from "../state/settings";
import { useAnalysis, useTelemetry, useTicks } from "../state/stores";
import { LiveDot, Meter, Panel, Sparkline } from "../ui";

function Tape() {
  useTicks((t) => t.tape);
  const rows = live.tape.slice(-14).reverse();
  if (!rows.length) return <div className="tape__empty label">esperando o primeiro negócio…</div>;
  const dec = fmt.priceDecimals(rows[0].price);
  return (
    <ul className="tape__list" aria-label="Últimos negócios">
      {rows.map((t, i) => (
        <li key={t.t + ":" + i + ":" + t.price + ":" + t.qty} className="tape__row" data-side={t.sell ? "sell" : "buy"}>
          <span className="tone-mute">{fmt.hhmmss(t.t)}</span>
          <span className="tape__side" aria-label={t.sell ? "agressor vendeu" : "agressor comprou"}>
            {t.sell ? "▼" : "▲"}
          </span>
          <span className="num">{fmt.num(t.price, dec)}</span>
          <span className="num tone-dim">{fmt.num(t.qty, t.qty >= 100 ? 0 : t.qty >= 1 ? 2 : 4)}</span>
        </li>
      ))}
    </ul>
  );
}

function Telemetry() {
  const t = useTelemetry();
  const candlesHist = useAnalysis((a) => a.history.info?.candles ?? 0);
  useEffect(() => startFpsMeter(), []);
  const w = t.rest?.weight1m ?? 0;
  const limited = !!t.rest?.limitedUntil;
  return (
    <dl className="tel">
      <div className="tel__row">
        <dt className="label">peso api 1 min</dt>
        <dd className="num">
          {fmt.int(w)} <span className="tone-mute">/ {fmt.int(WEIGHT_LIMIT_1M)}</span>
        </dd>
        <Meter value={w / WEIGHT_LIMIT_1M} tone={limited ? "neg" : "raw"} marks={[0.7]} label="Peso de API usado no último minuto" />
        <dd className="tel__src label">{t.rest?.weightSource === "cabeçalho" ? "lido de X-MBX-USED-WEIGHT-1M" : "estimado: soma local dos pedidos"}</dd>
        {limited ? <dd className="tel__warn">{t.rest?.banned ? "IP banido (418): parado até o prazo" : "a API pediu para esperar (429)"}</dd> : null}
      </div>
      <div className="tel__row tel__row--spark">
        <dt className="label">latência do ws</dt>
        <dd className="num">{t.wsLatency !== null ? fmt.num(t.wsLatency, 0) + " ms" : "—"}</dd>
        <Sparkline data={t.wsLatencyHistory} label="Latência do WebSocket no último minuto" min={0} />
      </div>
      <div className="tel__row tel__row--inline">
        <dt className="label">mensagens ws</dt>
        <dd className="num">{fmt.int(t.wsRate)}/s</dd>
      </div>
      <div className="tel__row tel__row--inline">
        <dt className="label">candles em memória</dt>
        <dd className="num">{fmt.int(t.sessionCandles + candlesHist)}</dd>
      </div>
      <div className="tel__row tel__row--inline">
        <dt className="label">worker · {t.workerJob || "—"}</dt>
        <dd className="num">{t.workerMs !== null ? fmt.num(t.workerMs, 0) + " ms" : "—"}</dd>
      </div>
      <div className="tel__row tel__row--spark">
        <dt className="label">fps da interface</dt>
        <dd className="num">{t.fps !== null ? fmt.num(t.fps, 0) : "—"}</dd>
        <Sparkline data={t.fpsHistory} label="Quadros por segundo no último minuto" min={0} max={Math.max(60, ...t.fpsHistory)} />
      </div>
    </dl>
  );
}

export function TapePanel() {
  const symbol = useSettings((s) => s.symbol);
  const ws = useTelemetry((t) => t.wsStatus);
  const host = useTelemetry((t) => t.wsHost);
  return (
    <Panel area="tape" title="Fita e telemetria" sub={`${symbol} · negócios agregados`} state={<LiveDot state={ws === "ao vivo" ? "live" : ws === "parado" ? "error" : "busy"} label={ws} />}>
      <div className="tape">
        <Tape />
        <Telemetry />
        <p className="tape__host label" title={host}>
          {host.replace("wss://", "")}
        </p>
      </div>
    </Panel>
  );
}
