// Visualização central: os replays do Time Machine como fios numa esfera.
import { type KeyboardEvent, Suspense, lazy, useEffect, useRef, useState } from "react";
import * as fmt from "../app/format";
import { netR } from "../engine/core";
import { OUTCOME_STOP, OUTCOME_TARGET } from "../engine/timemachine";
import { splitCost, useSettings } from "../state/settings";
import { useAnalysis } from "../state/stores";
import { useSphereHover } from "../sphere/hover";
import { Badge, LiveDot, Meter, Panel, PanelState, SkeletonStack } from "../ui";

const Scene = lazy(() => import("../sphere/SphereScene"));

function webglOk(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Dados do fio destacado: resultado bruto e líquido daquele replay, com o custo atual. */
function HoverCard() {
  const hover = useSphereHover((s) => s.hover);
  const tm = useAnalysis((a) => a.tm);
  const cost = useSettings((s) => s.cost_pct);
  if (!hover || !tm || hover.replay >= tm.result.replays) return null;
  const r = tm.result;
  const i = hover.replay;
  const c = splitCost(cost);
  const gross = (r.exit[i] - r.entry) / (r.entry - r.stop);
  const net = netR(r.entry, r.exit[i], r.stop, c.fee_pct, c.slippage_pct);
  const o = r.outcome[i];
  const mins = (r.len[i] - 1) * 5;
  const style = hover.x === null || hover.y === null ? { left: 12, bottom: 44 } : { left: Math.min(hover.x + 14, 9999), top: hover.y + 14 };
  return (
    <div className="sphere__hover" style={style} role="status">
      <div className="label">replay nº {fmt.int(i + 1)}</div>
      <div className="sphere__hoverR">
        <span className={net >= 0 ? "tone-pos" : "tone-neg"}>{fmt.rr(net)}</span>
        <span className="label">líquido</span>
      </div>
      <div className="tone-raw num">{fmt.rr(gross)} bruto</div>
      <div className="tone-dim">
        {o === OUTCOME_TARGET ? "bateu no alvo" : o === OUTCOME_STOP ? "bateu no stop" : "aberto até zerar"} · {fmt.duration(mins * 60000)} depois da entrada
      </div>
    </div>
  );
}

export function SpherePanel() {
  const tm = useAnalysis((a) => a.tm);
  const status = useAnalysis((a) => a.tmStatus);
  const progress = useAnalysis((a) => a.tmProgress);
  const error = useAnalysis((a) => a.tmError);
  const plan = useAnalysis((a) => a.plan);
  const source = useAnalysis((a) => a.planSource);
  const note = useAnalysis((a) => a.planNote);
  const hist = useAnalysis((a) => a.history);
  const symbol = useSettings((s) => s.symbol);
  const wrap = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(true);
  const [gl] = useState(webglOk);

  // só desenha com o painel na tela e a aba visível
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let onScreen = true;
    const update = () => setActive(onScreen && document.visibilityState === "visible");
    const io = new IntersectionObserver((entries) => {
      onScreen = entries[0]?.isIntersecting ?? true;
      update();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tm) return;
    const b = tm.result.sphere;
    const cur = useSphereHover.getState().hover;
    if (e.key === "Escape") {
      useSphereHover.setState({ hover: null });
      return;
    }
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const d = ((cur?.drawn ?? -1) + dir + b.drawn) % b.drawn;
    useSphereHover.setState({ hover: { drawn: d, replay: b.pathReplay[d], x: null, y: null } });
  };

  const busy = status === "loading" || hist.status === "loading";
  const r = tm?.result;
  const sub = r
    ? `${fmt.int(r.replays)} replays · seed ${r.seed} · ${r.sessions} sessões de ${symbol} · candles de 5m do mesmo horário ±${r.window}`
    : "replays do plano com candles de 5m do próprio par";
  const k = r ? (2 * r.entry) / (r.entry - r.stop) : 1;

  return (
    <Panel
      area="sphere"
      title="Time Machine"
      sub={sub}
      state={
        <>
          {source === "replay" && plan ? <Badge tone="signal" title={note ?? undefined}>replay de {fmt.ddmm(plan.entry_time ?? plan.session_start)}</Badge> : null}
          {source === "live" ? <Badge tone="signal">sessão atual</Badge> : null}
          <LiveDot state={status === "error" ? "error" : busy ? "busy" : tm ? "done" : "idle"} label={busy ? (status === "loading" ? `${Math.round(progress * 100)}%` : "histórico") : tm ? `${fmt.num(r?.mcMs ?? 0, 0)} ms` : "—"} />
        </>
      }
    >
      <div
        className="sphere"
        ref={wrap}
        tabIndex={tm ? 0 : -1}
        role="group"
        aria-label={tm ? `Esfera com ${fmt.int(r?.sphere.drawn ?? 0)} replays do plano. Use as setas esquerda e direita para percorrer os replays; Esc limpa a seleção.` : "Esfera do Time Machine"}
        onKeyDown={onKey}
      >
        {tm && r && gl ? (
          <Suspense fallback={<SkeletonStack lines={6} label="Carregando a visualização 3D" />}>
            <Scene buffers={r.sphere} k={k} targetR={tm.plan.target_r} active={active} labels={labels} />
          </Suspense>
        ) : null}
        {tm && r && !gl ? <PanelState kind="error" title="WebGL indisponível" detail="A esfera precisa de WebGL. Os números ao lado continuam valendo: eles não dependem do desenho." /> : null}
        {!tm && status === "error" ? <PanelState kind="error" title="O Time Machine não rodou" detail={error} /> : null}
        {!tm && status !== "error" && hist.status === "error" ? <PanelState kind={hist.error?.includes("418") || hist.error?.includes("429") ? "limited" : "error"} title="Sem histórico para simular" detail={hist.error} /> : null}
        {!tm && status !== "error" && hist.status !== "error" && !busy && !plan && note ? (
          <PanelState kind="empty" title="Sem plano para simular" detail={`${note} Também não há rompimento no histórico carregado com estes controles.`} />
        ) : null}
        {!tm && status !== "error" && hist.status !== "error" && (busy || (!plan && !note)) ? (
          <div className="sphere__loading">
            <SkeletonStack lines={5} label="Carregando o Time Machine" />
            <div className="sphere__loadingBar">
              <span className="label">{hist.status === "loading" ? `histórico de ${symbol}: ${hist.note || "pedindo candles"} (${hist.done}/${hist.total || "?"} pedidos)` : status === "loading" ? "sorteando candles de 5m" : "esperando o plano"}</span>
              <Meter value={hist.status === "loading" ? (hist.total ? hist.done / hist.total : 0) : progress} tone="signal" label="Progresso" />
            </div>
          </div>
        ) : null}
        {tm && r ? (
          <>
            <div className="sphere__rings" ref={labels} aria-hidden="true">
              <span className="sphere__ring tone-pos" data-ring="target">
                alvo {fmt.rr(tm.plan.target_r, 1)}
              </span>
              <span className="sphere__ring tone-signal" data-ring="entry">
                entrada 0R
              </span>
              <span className="sphere__ring tone-neg" data-ring="stop">
                stop {fmt.rr(-1, 0)}
              </span>
              <span className="sphere__ring sphere__ring--even" data-ring="even" />
            </div>
            <div className="sphere__legend">
              <b>1 fio = 1 replay</b>
              <span>tempo da sessão → longitude</span>
              <span>R do caminho → latitude</span>
              <span>
                cor = R líquido <span className="tone-pos">positivo</span> / <span className="tone-neg">negativo</span>
              </span>
              <span className="tone-mute">{r.sphere.drawn < r.replays ? `${fmt.int(r.sphere.drawn)} de ${fmt.int(r.replays)} fios desenhados; as estatísticas usam todos` : `${fmt.int(r.sphere.drawn)} fios desenhados`}</span>
              <span className="tone-mute">arraste para girar · passe o mouse num fio</span>
            </div>
            <div className="sphere__plan">
              <span className="label">plano simulado</span>
              <span className="num tone-pos">alvo {fmt.price(r.target)}</span>
              <span className="num tone-signal">entrada {fmt.price(r.entry)}</span>
              <span className="num tone-neg">stop {fmt.price(r.stop)}</span>
              <span className="tone-mute num">
                candles de {fmt.ddmm(r.from)} a {fmt.ddmm(r.to)}
              </span>
            </div>
            {busy ? (
              <div className="sphere__rerun">
                <Meter value={progress} tone="signal" label="Progresso dos replays" />
              </div>
            ) : null}
            <HoverCard />
          </>
        ) : null}
      </div>
    </Panel>
  );
}
