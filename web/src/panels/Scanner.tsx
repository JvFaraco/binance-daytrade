// Scanner ao vivo: os pares USDT líquidos e o estado do rompimento em cada um, calculado como scan.py.
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectSymbol } from "../app/controller";
import * as fmt from "../app/format";
import type { ScanResult } from "../engine/scan";
import { useSettings } from "../state/settings";
import { useMarket } from "../state/stores";
import { AnimatedNumber, Badge, LiveDot, Panel, PanelState, SkeletonStack, type Tone } from "../ui";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  forming: { label: "formando", tone: "raw" },
  waiting: { label: "esperando", tone: "neutral" },
  triggered: { label: "rompeu", tone: "signal" },
  expired: { label: "expirou", tone: "mute" },
  nodata: { label: "sem dados", tone: "mute" },
  error: { label: "erro", tone: "neg" },
};

const Row = memo(function Row({ symbol, selected, change }: { symbol: string; selected: boolean; change: number }) {
  const r = useMarket((m) => m.bySymbol[symbol]) as ScanResult | undefined;
  const price = useMarket((m) => m.prices[symbol]);
  const hit = useMarket((m) => m.hits.includes(symbol));
  const why = useMarket((m) => m.discarded.find((d) => d[0] === symbol)?.[1]);
  const st = STATUS[r?.status ?? "nodata"];
  const decimals = price !== undefined ? fmt.priceDecimals(price) : 2;
  const detail =
    r?.status === "error"
      ? r.error
      : r?.trigger
        ? why
          ? `rompeu às ${fmt.hhmm(r.trigger.time)}, mas o filtro descartou: ${why}`
          : `fechou ${fmt.pct(r.trigger.pct_over)} acima do topo às ${fmt.hhmm(r.trigger.time)} BRT`
        : undefined;
  return (
    <li>
      <button type="button" className="scan__row" aria-pressed={selected} onClick={() => selectSymbol(symbol)} title={detail}>
        <span className="scan__sym">{symbol.replace(/USDT$/, "")}</span>
        <span className="scan__num tone-raw">
          <AnimatedNumber value={price} format={(v) => fmt.num(v, decimals)} />
        </span>
        <span className="scan__num tone-dim">{fmt.signedPct(change, 1)}</span>
        <span className="scan__num tone-dim">{r?.range_pct !== undefined ? fmt.pct(r.range_pct) : "—"}</span>
        <span className="scan__state">
          <Badge tone={r?.status === "triggered" && !hit ? "neutral" : st.tone} outline={r?.status === "triggered" && !hit}>
            {r?.status === "triggered" && !hit ? "filtrado" : st.label}
          </Badge>
        </span>
      </button>
    </li>
  );
});

function Counts() {
  const c = useMarket(useShallow((m) => m.counts));
  const hits = useMarket((m) => m.hits.length);
  const item = (label: string, n: number, tone: string) => (
    <span className="scan__count">
      <span className={"num " + tone}>{n}</span>
      <span className="label">{label}</span>
    </span>
  );
  return (
    <div className="scan__counts" aria-live="polite">
      {item("válidos", hits, "tone-signal")}
      {item("romperam", c.triggered ?? 0, "tone-dim")}
      {item("esperando", c.waiting ?? 0, "tone-dim")}
      {item("formando", c.forming ?? 0, "tone-dim")}
      {item("expiraram", c.expired ?? 0, "tone-dim")}
    </div>
  );
}

export function Scanner() {
  const boot = useMarket((m) => m.boot);
  const error = useMarket((m) => m.error);
  const done = useMarket((m) => m.bootDone);
  const total = useMarket((m) => m.bootTotal);
  const universe = useMarket(useShallow((m) => m.universe));
  const cached = useMarket((m) => m.universeCached);
  const at = useMarket((m) => m.universeAt);
  const selected = useSettings((s) => s.symbol);
  const ready = boot === "pronto";
  return (
    <Panel
      area="scan"
      title="Scanner"
      sub={ready ? `${universe.length} pares USDT · rompimento da faixa inicial · 5m` : "pares USDT líquidos"}
      state={<LiveDot state={boot === "erro" ? "error" : ready ? "live" : "busy"} label={boot === "erro" ? "erro" : ready ? "ao vivo" : boot} />}
    >
      {boot === "erro" ? (
        <PanelState
          kind={error?.includes("418") || error?.includes("429") ? "limited" : "error"}
          title={error?.includes("418") || error?.includes("429") ? "A API limitou os pedidos" : "Sem acesso aos dados públicos"}
          detail={error}
        />
      ) : !ready ? (
        <>
          <div className="scan__boot label">{boot === "candles" ? `candles da sessão ${done}/${total}` : boot === "universo" ? "lista de pares (ticker 24h)" : "acertando o relógio com a Binance"}</div>
          <SkeletonStack lines={12} label="Carregando o scanner" />
        </>
      ) : (
        <>
          <Counts />
          <div className="scan__head label" aria-hidden="true">
            <span>par /USDT</span>
            <span>preço</span>
            <span>24h</span>
            <span>faixa</span>
            <span>estado</span>
          </div>
          <ul className="scan__list scroll">
            {universe.map((u) => (
              <Row key={u.symbol} symbol={u.symbol} selected={u.symbol === selected} change={u.change_pct} />
            ))}
          </ul>
          <div className="scan__foot label">
            lista de pares de {fmt.hhmm(at)} {cached ? "(cache de 30 min, como o scan.py)" : "(buscada agora)"}
          </div>
        </>
      )}
    </Panel>
  );
}
