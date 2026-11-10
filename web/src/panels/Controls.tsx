// Controles da regra. Mudar qualquer um refaz o pipeline de verdade (scan -> plan -> timemachine -> size -> risk).
import { useShallow } from "zustand/react/shallow";
import { selectSymbol } from "../app/controller";
import type { StopRule } from "../engine/core";
import { MONTH_OPTIONS, useSettings } from "../state/settings";
import { useMarket } from "../state/stores";
import { Segmented } from "../ui";

const ANCHORS = ["00:00", "08:00", "13:00"];

export function Controls() {
  const s = useSettings();
  const universe = useMarket(useShallow((m) => m.universe));
  const custom = !ANCHORS.includes(s.anchor_utc);
  const num = (v: string, min: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return (
    <section className="ctl" style={{ gridArea: "ctl" }} aria-label="Controles da regra">
      <label className="field">
        <span className="label">par</span>
        <select className="input" value={s.symbol} onChange={(e) => selectSymbol(e.target.value)}>
          {universe.length ? null : <option value={s.symbol}>{s.symbol}</option>}
          {universe.map((u) => (
            <option key={u.symbol} value={u.symbol}>
              {u.symbol}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="label">âncora da sessão (UTC)</span>
        <div className="ctl__row">
          <Segmented label="Âncora da sessão em UTC" value={custom ? "outra" : s.anchor_utc} options={[...ANCHORS.map((a) => ({ value: a, label: a })), { value: "outra", label: "outra" }]} onChange={(v) => s.set({ anchor_utc: v === "outra" ? "21:00" : v })} />
          {custom ? (
            <input className="input" type="time" aria-label="Outra âncora (UTC)" value={s.anchor_utc} step={300} onChange={(e) => /^\d\d:\d\d$/.test(e.target.value) && s.set({ anchor_utc: e.target.value })} />
          ) : null}
        </div>
      </div>
      <div className="field">
        <span className="label">faixa inicial</span>
        <Segmented
          label="Duração da faixa inicial"
          value={s.range_minutes}
          options={[
            { value: 30, label: "30 min" },
            { value: 60, label: "60 min" },
          ]}
          onChange={(v) => s.set({ range_minutes: v })}
        />
      </div>
      <div className="field">
        <span className="label">stop</span>
        <Segmented<StopRule>
          label="Regra de stop"
          value={s.stop_rule}
          options={[
            { value: "or-mid", label: "meio da faixa" },
            { value: "or-low", label: "fundo da faixa" },
          ]}
          onChange={(v) => s.set({ stop_rule: v })}
        />
      </div>
      <div className="field">
        <span className="label">alvo em R</span>
        <Segmented label="Alvo em múltiplos do risco" value={s.target_r} options={[1, 1.5, 2, 3].map((v) => ({ value: v, label: String(v).replace(".", ",") + "R" }))} onChange={(v) => s.set({ target_r: v })} />
      </div>
      <label className="field">
        <span className="label">capital (USDT)</span>
        <input className="input" type="number" inputMode="decimal" min={10} step={100} value={s.account} onChange={(e) => s.set({ account: num(e.target.value, 10, s.account) })} />
      </label>
      <label className="field">
        <span className="label">perda máx. por trade</span>
        <input className="input" type="number" inputMode="decimal" min={0.1} step={1} value={s.max_loss_per_trade} onChange={(e) => s.set({ max_loss_per_trade: num(e.target.value, 0.1, s.max_loss_per_trade) })} />
      </label>
      <div className="field">
        <span className="label">histórico (grade e pesquisa)</span>
        <Segmented label="Meses de histórico" value={s.months} options={MONTH_OPTIONS.map((m) => ({ value: m, label: m + " meses" }))} onChange={(v) => s.set({ months: v })} />
      </div>
    </section>
  );
}
