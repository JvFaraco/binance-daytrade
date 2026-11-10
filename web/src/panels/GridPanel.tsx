// Mapa da grade do backtest: as 96 combinações do backtest.py, treino × teste.
// Alternar para o teste mostra os "vencedores" do treino fora da amostra.
import { type KeyboardEvent, useMemo, useState } from "react";
import * as fmt from "../app/format";
import { type ComboResult, DEFAULT_GRID, gridVerdict, summarizeCombo } from "../engine/backtest";
import { MONTH_OPTIONS, README_MONTHS, splitCost, useSettings } from "../state/settings";
import { useAnalysis, useMarket } from "../state/stores";
import { LiveDot, Meter, NoData, Panel, PanelState, Segmented } from "../ui";

type View = "train" | "test";
const COLS = DEFAULT_GRID.targets.length * DEFAULT_GRID.minRanges.length; // 12
const ROWS = DEFAULT_GRID.anchors.length * DEFAULT_GRID.ranges.length * DEFAULT_GRID.stops.length; // 8
const MIN_TRADES: Record<View, number> = { train: 20, test: 10 }; // os mesmos cortes do relatório do backtest.py

function describe(r: ComboResult): string {
  const p = r.params;
  const side = (label: string, s: ComboResult["train"], n: number) =>
    s.trades ? `${label} (${n} sessões): ${s.trades} trades, R total ${fmt.signed(s.sum_r)}, acerto ${fmt.pct(s.win_pct ?? 0, 1)}, DD ${fmt.num(s.max_dd_r)}R` : `${label} (${n} sessões): nenhum trade`;
  return `âncora ${p.anchor_utc} · faixa ${p.range_minutes} min · stop ${p.stop_rule === "or-mid" ? "meio" : "fundo"} · alvo ${fmt.num(p.target_r, 1)}R · faixa ≥ ${fmt.num(p.min_range_pct, 1)}% — ${side("treino", r.train, r.sessions[0])} | ${side("teste", r.test, r.sessions[1])}`;
}

export function GridPanel() {
  const grid = useAnalysis((a) => a.grid);
  const hist = useAnalysis((a) => a.history);
  const cost = useSettings((s) => s.cost_pct);
  const months = useSettings((s) => s.months);
  const set = useSettings((s) => s.set);
  const symbol = useSettings((s) => s.symbol);
  const offline = useMarket((m) => m.boot === "erro");
  const [view, setView] = useState<View>("train");
  const [cursor, setCursor] = useState<number | null>(null);

  const results = useMemo(() => (grid.result ? grid.result.combos.map((c) => summarizeCombo(c, splitCost(cost))) : null), [grid.result, cost]);
  const verdict = useMemo(() => (results ? gridVerdict(results) : null), [results]);
  const scale = useMemo(() => {
    if (!results) return 1;
    let m = 1;
    for (const r of results) m = Math.max(m, Math.abs(r.train.sum_r), Math.abs(r.test.sum_r));
    return m;
  }, [results]);
  const top = verdict ? verdict.ranked.slice(0, 5) : [];

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!results) return;
    const cur = cursor ?? 0;
    const move: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS };
    if (!(e.key in move)) return;
    e.preventDefault();
    setCursor(Math.max(0, Math.min(results.length - 1, cursor === null ? 0 : cur + move[e.key])));
  };

  const info = grid.result;
  const loading = grid.status === "loading" || hist.status === "loading" || (grid.status === "idle" && hist.status !== "error");
  // o rótulo descreve o resultado que está na tela, não o que foi pedido e ainda está carregando
  const shownMonths = info ? grid.months : months;
  const shownSymbol = info ? grid.symbol : symbol;
  const stale = !!info && (grid.months !== months || grid.symbol !== symbol);
  const sub = info
    ? `${shownSymbol} · ${shownMonths} meses · ${fmt.ddmmyy(info.first, "UTC")} → ${fmt.ddmmyy(info.last, "UTC")} · ${fmt.int(info.candles)} candles de 5m · treino 70% / teste 30%`
    : `${symbol} · ${months} meses de candles de 5m · treino 70% / teste 30%`;

  return (
    <Panel
      area="grid"
      title="Grade do backtest"
      sub={sub}
      state={
        <>
          <Segmented<View>
            label="Amostra exibida"
            value={view}
            options={[
              { value: "train", label: "treino" },
              { value: "test", label: "teste" },
            ]}
            onChange={setView}
          />
          <LiveDot state={grid.status === "error" ? "error" : loading ? "busy" : "done"} label={loading ? (hist.status === "loading" ? "histórico" : `${grid.done}/${grid.total}`) : grid.ms !== null ? `${fmt.num(grid.ms, 0)} ms` : ""} />
        </>
      }
    >
      {offline && !results ? (
        <NoData />
      ) : grid.status === "error" || (hist.status === "error" && !results) ? (
        <PanelState kind={(grid.error ?? hist.error ?? "").match(/418|429/) ? "limited" : "error"} title="A grade não rodou" detail={grid.error ?? hist.error} />
      ) : (
        <div className="grid" data-stale={stale} data-months={info ? shownMonths : 0} data-symbol={info ? shownSymbol : ""}>
          <div className="grid__cols label" aria-hidden="true">
            <span />
            {DEFAULT_GRID.targets.map((t) => (
              <span key={t} className="grid__colGroup">
                alvo {fmt.num(t, 1)}R
              </span>
            ))}
          </div>
          <div className="grid__body">
            <div className="grid__rows label" aria-hidden="true">
              {DEFAULT_GRID.anchors.flatMap((a) => DEFAULT_GRID.ranges.flatMap((rg) => DEFAULT_GRID.stops.map((st) => <span key={a + rg + st}>{`${a} ${rg}m ${st === "or-mid" ? "meio" : "fundo"}`}</span>)))}
            </div>
            <div
              className="grid__cells"
              data-view={view}
              role="group"
              tabIndex={0}
              aria-label={`Mapa das ${ROWS * COLS} combinações no ${view === "train" ? "treino" : "teste"}. Use as setas para percorrer.`}
              onKeyDown={onKey}
              onMouseLeave={() => setCursor(null)}
            >
              {Array.from({ length: ROWS * COLS }, (_, i) => {
                const r = results?.[i];
                if (!r) {
                  return <span key={i} className="grid__cell" data-state={i < grid.done ? "lit" : "wait"} style={{ animationDelay: (i % 12) * 30 + "ms" }} />;
                }
                const s = r[view];
                const thin = s.trades < MIN_TRADES[view];
                const v = s.sum_r;
                // teto de opacidade por cor: acima disso o número claro perde contraste AA sobre a célula
                const cap = thin ? 0.22 : v > 0 ? 0.45 : 0.55;
                const a = s.trades ? 0.1 + (cap - 0.1) * Math.min(1, Math.abs(v) / scale) : 0;
                const rank = top.indexOf(i);
                return (
                  <span
                    key={i}
                    className="grid__cell"
                    data-state="done"
                    data-sign={s.trades === 0 ? "none" : v > 0 ? "pos" : "neg"}
                    data-thin={thin}
                    data-top={rank >= 0}
                    data-cursor={cursor === i}
                    style={{ ["--a" as string]: a, animationDelay: i * 5 + "ms" }}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => setCursor(i)}
                  >
                    {rank >= 0 ? <b className="grid__rank">{rank + 1}</b> : null}
                    <span className="grid__val num">{s.trades ? fmt.signed(v, 1) : "·"}</span>
                  </span>
                );
              })}
            </div>
          </div>
          <div className="grid__minr label" aria-hidden="true">
            <span />
            {DEFAULT_GRID.targets.flatMap((t) => DEFAULT_GRID.minRanges.map((m) => <span key={t + "-" + m}>≥{fmt.num(m, 1)}%</span>))}
          </div>
          <p className="grid__detail" aria-live="polite">
            {results && cursor !== null ? describe(results[cursor]) : "Cada célula: R total líquido da combinação. Borda âmbar = as 5 melhores do treino (com 20+ trades). Tracejado = poucos trades. Toque, passe o mouse ou use as setas para ver os números."}
          </p>
          {loading && (!results || stale) ? (
            <div className="grid__progress" role="status">
              <span className="label">
                {hist.status === "loading" ? `${symbol} · ${months} meses · baixando candles: ${hist.note || "…"} (${hist.done}/${hist.total || "?"} pedidos)` : `calculando combinações ${grid.done}/${grid.total}`}
              </span>
              <Meter value={hist.status === "loading" ? (hist.total ? hist.done / hist.total : 0) : grid.total ? grid.done / grid.total : 0} tone="signal" label="Progresso da grade" />
            </div>
          ) : null}
          <div className="grid__foot">
            {verdict ? (
              <p className="grid__verdict" aria-live="polite">
                {verdict.topN ? (
                  <>
                    <b className={verdict.topPositive > verdict.topN / 2 ? "tone-pos" : "tone-neg"} data-num="grid_top">
                      {verdict.topPositive} de {verdict.topN}
                    </b>{" "}
                    melhores do treino seguiram positivas no teste.{" "}
                  </>
                ) : (
                  <>Nenhuma combinação disparou 20 vezes no treino neste período. </>
                )}
                Com 10+ trades no teste:{" "}
                <b className={verdict.allPositive > 0 ? "tone-signal" : "tone-neg"} data-num="grid_all">
                  {verdict.allPositive} de {verdict.allN}
                </b>{" "}
                com R total positivo.
              </p>
            ) : (
              <p className="grid__verdict tone-mute">O número que vale é o do teste: sessões que a escolha do treino nunca viu.</p>
            )}
            <div className="grid__period">
              <Segmented label="Meses de histórico" value={months} options={MONTH_OPTIONS.map((m) => ({ value: m, label: m + " m" }))} onChange={(v) => set({ months: v })} />
              <span className="label grid__readme">
                mostrando {shownMonths} {shownMonths === README_MONTHS ? "meses, o mesmo período da conclusão do README (0 de 88, em BTC e SOL)" : `meses · o README conclui (0 de 88) com ${README_MONTHS} meses em BTC e SOL`}
              </span>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
