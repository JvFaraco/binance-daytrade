// Controle de custo (0 a 0,2% por lado). Mudar o custo não refaz sorteio nem simulação:
// só o R líquido é recalculado. O mesmo controle aparece no Pro e no Lite.
import * as fmt from "../app/format";
import { COST_MAX, DEFAULT_COST, splitCost, useSettings } from "../state/settings";

const MARKS = [
  { v: 0, label: "zero", title: "Sem custo nenhum: o resultado bruto" },
  { v: 0.075, label: "bnb", title: "0,075%: só a taxa, pagando com BNB" },
  { v: 0.1, label: "taxa", title: "0,10%: só a taxa padrão da Binance spot" },
  { v: DEFAULT_COST, label: "padrão", title: "0,15%: taxa de 0,10% + slippage de 0,05%, o padrão do config" },
];

/** `plain`: rótulos do modo Lite. O controle, o valor e a store são os mesmos nos dois modos. */
export function CostControl({ plain = false }: { plain?: boolean }) {
  const cost = useSettings((s) => s.cost_pct);
  const set = useSettings((s) => s.set);
  const c = splitCost(cost);
  return (
    <div className="cost">
      <div className="cost__head">
        <label className="label" htmlFor="cost-range">
          {plain ? "taxa em cada compra e em cada venda" : "custo por lado (taxa + slippage)"}
        </label>
        <span className="cost__value num" data-num="cost">
          {fmt.num(cost, 3)}%
        </span>
      </div>
      <input
        id="cost-range"
        className="range"
        type="range"
        min={0}
        max={COST_MAX}
        step={0.005}
        value={cost}
        style={{ ["--fill" as string]: cost / COST_MAX }}
        aria-valuetext={`${fmt.num(cost, 3)}% por lado, ${fmt.num(cost * 2, 2)}% de ida e volta`}
        onChange={(e) => set({ cost_pct: Number(e.target.value) })}
      />
      <div className="cost__marks">
        {(plain ? MARKS.filter((m) => m.v === 0 || m.v === DEFAULT_COST) : MARKS).map((m) => (
          <button key={m.v} type="button" className="cost__mark" style={{ left: (m.v / COST_MAX) * 100 + "%" }} data-on={Math.abs(cost - m.v) < 1e-9} title={m.title} onClick={() => set({ cost_pct: m.v })}>
            {m.label}
          </button>
        ))}
      </div>
      {plain ? null : (
        <div className="cost__split label">
          taxa {fmt.num(c.fee_pct, 3)}% + slippage {fmt.num(c.slippage_pct, 3)}% · ida e volta {fmt.num(cost * 2, 2)}%
        </div>
      )}
    </div>
  );
}
