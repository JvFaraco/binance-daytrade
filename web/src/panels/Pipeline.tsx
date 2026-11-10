// Pipeline do skill: scan -> plan -> timemachine -> size -> risk. Cada etapa acende quando o cálculo
// real termina e mostra o tempo que levou. Termina em risk: o broker não existe aqui.
import { useEffect, useRef } from "react";
import { stageTime } from "../app/controller";
import { type Stage, type StageId, STAGES, usePipeline } from "../state/stores";
import { Badge, LiveDot, Meter, Panel } from "../ui";

const NAMES: Record<StageId, [string, string]> = {
  scan: ["scan", "estado do rompimento em cada par"],
  plan: ["plan", "entrada, stop e alvo"],
  timemachine: ["timemachine", "replays com candles do próprio par"],
  size: ["size", "quantidade pelos filtros do par"],
  risk: ["risk", "limites do config"],
};

function StageRow({ id, index }: { id: StageId; index: number }) {
  const st = usePipeline((p) => p.stages[id]) as Stage;
  const state = st.status === "running" ? "busy" : st.status === "done" ? "done" : st.status === "error" ? "error" : "idle";
  const ref = useRef<HTMLLIElement>(null);
  // acende de novo cada vez que a etapa termina um cálculo
  useEffect(() => {
    const el = ref.current;
    if (!el || st.runs === 0) return;
    el.classList.remove("is-lit");
    void el.offsetWidth;
    el.classList.add("is-lit");
  }, [st.runs]);
  return (
    <li ref={ref} className="pipe__stage" data-status={st.status} aria-label={`${NAMES[id][0]}: ${st.status}`}>
      <span className="pipe__idx label">{index + 1}</span>
      <span className="pipe__node" aria-hidden="true" />
      <div className="pipe__main">
        <div className="pipe__line1">
          <span className="pipe__name">{NAMES[id][0]}</span>
          <LiveDot state={state} />
          <span className="pipe__ms num">{stageTime(st.ms)}</span>
        </div>
        <div className="pipe__note" title={st.note || NAMES[id][1]}>
          {st.note || NAMES[id][1]}
        </div>
        {st.status === "running" && st.progress !== null ? <Meter value={st.progress} tone="signal" label={`progresso de ${NAMES[id][0]}`} /> : null}
      </div>
    </li>
  );
}

export function Pipeline() {
  const running = usePipeline((p) => STAGES.some((s) => p.stages[s].status === "running"));
  return (
    <Panel area="pipe" title="Pipeline" sub="tempo real de cada etapa" state={<LiveDot state={running ? "busy" : "done"} label={running ? "calculando" : "em dia"} />}>
      <ol className="pipe">
        {STAGES.map((id, i) => (
          <StageRow key={id} id={id} index={i} />
        ))}
        <li className="pipe__stage pipe__stage--off" data-status="off" aria-label="broker: não enviado">
          <span className="pipe__idx label">—</span>
          <span className="pipe__node" aria-hidden="true" />
          <div className="pipe__main">
            <div className="pipe__line1">
              <span className="pipe__name">broker</span>
              <Badge tone="mute">não enviado</Badge>
            </div>
            <div className="pipe__note">este painel só analisa: nenhuma ordem sai daqui</div>
          </div>
        </li>
      </ol>
    </Panel>
  );
}
