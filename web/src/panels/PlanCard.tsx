// Cartão do plano: entrada/stop/alvo, tamanho pela lógica do size.py com os filtros reais do par,
// checagens do risk.py e o desenho da ordem OTOCO como ela seria. Nada disso é enviado.
import * as fmt from "../app/format";
import type { Check } from "../engine/risk";
import { useSettings } from "../state/settings";
import { useAnalysis, useMarket } from "../state/stores";
import { Badge, LiveDot, NoData, Panel, PanelState, SkeletonStack, Stat } from "../ui";

const LEVEL: Record<Check["level"], string> = { ok: "ok", warn: "aviso", block: "block" };

function Otoco() {
  const order = useAnalysis((a) => a.order);
  if (!order) return null;
  const otoco = order.mode === "otoco";
  const q = (s: string) => s.replace(".", ",");
  return (
    <figure className="otoco" aria-label={`Como seria a ordem ${otoco ? "OTOCO" : "em dois passos"}: compra limite de ${order.entry.quantity} ${order.base} a ${order.entry.price}; se executar, alvo em ${order.exit.target} e stop em ${order.exit.stop} como par OCO. Ordem não enviada.`}>
      <div className="otoco__head">
        <span className="label">{otoco ? "ordem otoco · como seria" : "dois passos (ioc, depois oco) · como seria"}</span>
        <Badge tone="signal">não enviada</Badge>
      </div>
      <div className="otoco__flow">
        <div className="otoco__node" data-k="buy">
          <span className="label">compra · limit {order.entry.timeInForce}</span>
          <span className="num tone-signal">≤ {q(order.entry.price)}</span>
          <span className="num">
            × {q(order.entry.quantity)} {order.base}
          </span>
        </div>
        <svg className="otoco__wires" viewBox="0 0 40 64" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 32 H14 V12 H40" />
          <path d="M0 32 H14 V52 H40" />
        </svg>
        <div className="otoco__legs">
          <div className="otoco__node" data-k="target">
            <span className="label">alvo · limit maker</span>
            <span className="num tone-pos">
              {q(order.exit.target)} × {q(order.exit.quantity)}
            </span>
          </div>
          <span className="otoco__oco label">oco: um cancela o outro</span>
          <div className="otoco__node" data-k="stop">
            <span className="label">stop · stop-limit</span>
            <span className="num tone-neg">gatilho {q(order.exit.stop)}</span>
            <span className="num tone-dim">limite {q(order.exit.stop_limit)}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

function Checks() {
  const checks = useAnalysis((a) => a.checks);
  const verdict = useAnalysis((a) => a.riskVerdict);
  const source = useAnalysis((a) => a.planSource);
  if (!checks) return null;
  // "modo" (paper/real) é sobre onde o broker enviaria; aqui não há envio
  const rows = checks.filter((c) => c.name !== "modo");
  return (
    <div className="risk">
      <div className="risk__head">
        <span className="label">risk.py · limites do config</span>
        <Badge tone={verdict === "PASS" ? "pos" : "neg"}>{verdict}</Badge>
      </div>
      {source === "replay" ? <p className="risk__note">Avaliado agora sobre um rompimento passado: sessão, janela e idade do sinal bloqueiam por definição.</p> : null}
      <ul className="risk__list scroll" aria-live="polite">
        {rows.map((c) => (
          <li key={c.name} className="risk__row" data-level={c.level}>
            <span className="risk__lvl label">{LEVEL[c.level]}</span>
            <span className="risk__name">{c.name}</span>
            <span className="risk__text" title={c.text}>
              {c.text}
            </span>
          </li>
        ))}
        <li className="risk__row" data-level="ok">
          <span className="risk__lvl label">—</span>
          <span className="risk__name">envio</span>
          <span className="risk__text">nenhuma ordem é enviada por este painel</span>
        </li>
      </ul>
    </div>
  );
}

export function PlanCard() {
  const plan = useAnalysis((a) => a.plan);
  const source = useAnalysis((a) => a.planSource);
  const note = useAnalysis((a) => a.planNote);
  const order = useAnalysis((a) => a.order);
  const orderError = useAnalysis((a) => a.orderError);
  const rules = useAnalysis((a) => a.rules);
  const hist = useAnalysis((a) => a.history.status);
  const symbol = useSettings((s) => s.symbol);
  const stop = useSettings((s) => s.stop_rule);
  const offline = useMarket((m) => m.boot === "erro");
  const p = (v: number) => fmt.price(v, rules?.tick);
  const tz = "BRT";
  return (
    <Panel
      area="plan"
      title="Plano"
      sub={`${symbol} · stop no ${stop === "or-mid" ? "meio" : "fundo"} da faixa · tamanho e risco`}
      state={plan ? <Badge tone="signal">{source === "live" ? "sessão atual" : `replay ${fmt.ddmm(plan.entry_time ?? plan.session_start)}`}</Badge> : <LiveDot state={hist === "loading" ? "busy" : "idle"} label={hist === "loading" ? "histórico" : "sem plano"} />}
    >
      {!plan ? (
        offline ? (
          <NoData />
        ) : hist === "loading" || (!note && hist !== "error") ? (
          <SkeletonStack lines={9} label="Montando o plano" />
        ) : (
          <PanelState kind="empty" title="Sem plano" detail={note ?? "Sem histórico para procurar um rompimento."} />
        )
      ) : (
        <div className="plan">
          {source === "replay" ? (
            <p className="plan__note">
              <span className="label">sessão atual</span> {note} Mostrando o último rompimento do histórico: {fmt.ddmm(plan.entry_time ?? plan.session_start)} às {fmt.hhmm(plan.entry_time ?? plan.session_start)} {tz}.
            </p>
          ) : null}
          <div className="plan__prices">
            <Stat label="entrada" text={p(plan.entry)} tone="signal" hint={`topo ${p(plan.range_high)}`} />
            <Stat label="stop" text={p(plan.stop)} tone="neg" hint={`risco ${fmt.pct((plan.risk_per_unit / plan.entry) * 100)}`} />
            <Stat label="alvo" text={p(plan.target)} tone="pos" hint={`${fmt.num(plan.target_r, 1)}R bruto`} />
            <Stat label="R:R líquido" value={order?.reward_risk ?? null} format={(v) => fmt.num(v, 2)} tone={order ? (order.reward_risk >= 1 ? "pos" : "neg") : "neutral"} hint="após custos" />
          </div>
          {order ? (
            <div className="plan__size">
              <Stat label={`qtd ${order.base}`} text={order.qty.replace(".", ",")} />
              <Stat label={`valor ${order.quote}`} value={order.notional} format={(v) => fmt.num(v)} tone="raw" />
              <Stat label="no stop" value={-order.max_loss} format={(v) => fmt.num(v)} tone="neg" hint="perda máx." />
              <Stat label="no alvo" value={order.reward_at_target} format={(v) => fmt.signed(v)} tone={order.reward_at_target > 0 ? "pos" : "neg"} hint="líquido" />
            </div>
          ) : (
            <div className="plan__refused" role="status">
              <span className="label">size.py recusou</span>
              <span>{orderError ?? (rules ? "calculando" : "lendo os filtros do par (exchangeInfo)")}</span>
            </div>
          )}
          <Otoco />
          <Checks />
        </div>
      )}
    </Panel>
  );
}
