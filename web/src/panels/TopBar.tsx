// Barra superior: par escolhido, preço, relógio e o aviso permanente de que nada é enviado.
import { useEffect, useState } from "react";
import { live } from "../app/live";
import { preloadPro } from "../app/proChunk";
import { type Mode, setMode, useMode } from "../state/mode";
import * as fmt from "../app/format";
import { useSettings } from "../state/settings";
import { useMarket, useTelemetry } from "../state/stores";
import { AnimatedNumber, Badge, LiveDot, Segmented } from "../ui";

function Clock() {
  const [t, setT] = useState(() => Date.now() + live.offset);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now() + live.offset), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="top__clock" aria-label="Relógio da Binance">
      <span className="num">{fmt.hhmmss(t, "UTC")}</span>
      <span className="label">UTC</span>
      <span className="num tone-dim">{fmt.hhmmss(t)}</span>
      <span className="label">BRT</span>
    </div>
  );
}

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "lite", label: "Lite" },
  { value: "pro", label: "Pro" },
];

/** Lite (para quem nunca operou) ou Pro (tudo). Os dois mostram os mesmos números. */
function ModeSwitch() {
  const mode = useMode((s) => s.mode);
  return (
    <span className="top__mode" onPointerEnter={preloadPro} onFocus={preloadPro}>
      <span className="label" aria-hidden="true">
        modo
      </span>
      <Segmented<Mode> label="Modo do painel: Lite mostra o essencial em linguagem simples; Pro mostra todos os dados" value={mode} options={MODES} onChange={setMode} />
    </span>
  );
}

export function TopBar() {
  const symbol = useSettings((s) => s.symbol);
  const price = useMarket((m) => m.prices[symbol]);
  const change = useMarket((m) => m.universe.find((u) => u.symbol === symbol)?.change_pct);
  const ws = useTelemetry((t) => t.wsStatus);
  const dec = price !== undefined ? fmt.priceDecimals(price) : 2;
  return (
    <header className="top" style={{ gridArea: "top" }}>
      <div className="top__brand">
        <h1 className="top__title">binance-daytrade</h1>
        <span className="label">painel de análise · spot · rompimento da faixa inicial</span>
      </div>
      <div className="top__pair">
        <span className="top__sym">{symbol}</span>
        <span className="top__price tone-raw">
          <AnimatedNumber value={price} format={(v) => fmt.num(v, dec)} />
        </span>
        <span className="top__change tone-dim num">{change !== undefined ? `${fmt.signedPct(change)} 24h` : ""}</span>
      </div>
      <ModeSwitch />
      <div className="top__right">
        <Clock />
        <span className="top__ws">
          <LiveDot state={ws === "ao vivo" ? "live" : ws === "parado" ? "error" : "busy"} label={`ws ${ws}`} />
        </span>
        <Badge tone="signal">somente análise — nenhuma ordem é enviada</Badge>
      </div>
    </header>
  );
}
