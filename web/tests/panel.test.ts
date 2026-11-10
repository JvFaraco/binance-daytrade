// Peças que só existem no painel (não têm equivalente direto no Python): elas apenas encadeiam
// ou reempacotam o que o motor portado calcula, e os testes conferem essa coerência.
import { describe, expect, it } from "vitest";
import { type Bar, DEFAULTS, HOUR, orbSignal } from "../src/engine";
import * as backtest from "../src/engine/backtest";
import { rejectionReport } from "../src/engine/rejections";
import * as size from "../src/engine/size";
import * as tm from "../src/engine/timemachine";
import { packBars, unpackBars } from "../src/data/pack";
import { monthRanges } from "../src/data/history";
import { LAT_MAX, POINT_STRIDE, buildSphereBuffers, latitudeOf, pointOnSphere } from "../src/sphere/geometry";
import { configFrom, DEFAULT_COST, INITIAL, splitCost } from "../src/state/settings";
import { fixture } from "./helpers";

const fx = fixture();

describe("motivos de rejeição (scan -> plan -> size -> risk)", () => {
  const rules = size.parseRules(fx.size_risk.rules[0].info, "BTCUSDT");

  it("cada sessão cai em exatamente um motivo ou é aceita", () => {
    const sessions = backtest.sessionsFor(fx.backtest.random.bars as Bar[], "13:00", 8);
    const rep = rejectionReport(sessions, "BTCUSDT", DEFAULTS, "or-mid", 1.5, rules);
    const total = rep.reasons.reduce((a, r) => a + r.count, 0) + rep.accepted;
    expect(total).toBe(sessions.length);
    expect(rep.sessions).toBe(sessions.length);
    // ordenado do mais frequente para o menos
    for (let i = 1; i < rep.reasons.length; i++) expect(rep.reasons[i - 1].count).toBeGreaterThanOrEqual(rep.reasons[i].count);
  });

  it("as contagens do scan batem com orb_signal e com os filtros do scan.py", () => {
    const sessions = backtest.sessionsFor(fx.backtest.random.bars as Bar[], "13:00", 8);
    let expired = 0;
    let narrow = 0;
    let chase = 0;
    for (const { s, bars } of sessions) {
      const sig = orbSignal(bars, s + 8 * HOUR, DEFAULTS, s);
      if (sig.status !== "triggered") expired++;
      else if ((sig.range_pct as number) < DEFAULTS.min_range_pct) narrow++;
      else if ((sig.trigger?.pct_over as number) > DEFAULTS.max_chase_pct) chase++;
    }
    const rep = rejectionReport(sessions, "BTCUSDT", DEFAULTS, "or-mid", 1.5, rules);
    const count = (k: string) => rep.reasons.find((r) => r.key === k)?.count ?? 0;
    expect(count("scan-expired")).toBe(expired);
    expect(count("scan-narrow")).toBe(narrow);
    expect(count("scan-chase")).toBe(chase);
  });

  it("no rompimento conhecido, 1,5R é recusado pelo risk (retorno/risco) com a mensagem do motor", () => {
    const sessions = backtest.sessionsFor(fx.timemachine.known.bars as Bar[], "13:00", 8);
    const rep = rejectionReport(sessions, "BTCUSDT", DEFAULTS, "or-mid", 1.5, rules);
    expect(rep.accepted).toBe(0);
    expect(rep.reasons).toHaveLength(1);
    expect(rep.reasons[0].key).toBe("risk-retorno/risco");
    expect(rep.reasons[0].example).toMatch(/depois das taxas, mínimo 1\.00/);
    // com alvo de 3R e sem custo o mesmo sinal passa em tudo
    const free = rejectionReport(sessions, "BTCUSDT", { ...DEFAULTS, fee_pct: 0, slippage_pct: 0 }, "or-mid", 3, rules);
    expect(free.accepted).toBe(sessions.length);
  });
});

describe("geometria da esfera", () => {
  const t = fx.timemachine;
  const sessions = tm.fullSessions(t.bars as Bar[], t.plan.params, t.before);
  const raw = tm.runMcRaw(t.plan, sessions, 2000, 19, 2, { recordPaths: true });

  it("um fio por replay, com os pontos e segmentos certos", () => {
    const g = buildSphereBuffers(raw, t.plan.target_r, 2000);
    expect(g.drawn).toBe(2000);
    let pts = 0;
    for (let i = 0; i < raw.replays; i++) pts += raw.len[i];
    expect(g.points.length).toBe(pts * POINT_STRIDE);
    expect(g.index.length).toBe((pts - raw.replays) * 2);
    // o R de saída gravado em cada ponto é o do replay; o último ponto do fio está nesse R
    const risk = raw.entry - raw.stop;
    for (let d = 0; d < g.drawn; d += 37) {
      const i = g.pathReplay[d];
      const exitR = (raw.exit[i] - raw.entry) / risk;
      const lastPt = (g.pathStart[d] + g.pathCount[d] - 1) * POINT_STRIDE;
      expect(g.points[g.pathStart[d] * POINT_STRIDE + 1]).toBe(0);
      expect(Math.abs(g.points[lastPt + 1] - exitR)).toBeLessThan(1e-5);
      expect(Math.abs(g.points[lastPt + 4] - exitR)).toBeLessThan(1e-5);
      expect(g.points[lastPt + 3]).toBe(1);
    }
    // índices sempre dentro do próprio fio
    for (let k = 0; k < g.index.length; k += 2) expect(g.index[k + 1] - g.index[k]).toBe(1);
  });

  it("desenhar menos fios não muda os replays, só a amostra", () => {
    const g = buildSphereBuffers(raw, t.plan.target_r, 500);
    expect(g.drawn).toBe(500);
    expect(g.replays).toBe(2000);
    expect(Array.from(g.pathReplay.slice(0, 3))).toEqual([0, 4, 8]);
  });

  it("stop fica no sul, alvo no norte, entrada no equador; pontos na esfera unitária", () => {
    const rs = Math.max(1, t.plan.target_r);
    expect(latitudeOf(0, rs)).toBe(0);
    expect(latitudeOf(-1, rs)).toBeLessThan(0);
    expect(latitudeOf(t.plan.target_r, rs)).toBeCloseTo(LAT_MAX, 10);
    const out = new Float32Array(3);
    pointOnSphere(0.3, 0.7, 1.1, rs, out, 0);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 5);
  });
});

describe("dados e controles", () => {
  it("candles compactados voltam idênticos", () => {
    const bars = (fx.timemachine.bars as Bar[]).slice(0, 500);
    expect(unpackBars(packBars(bars))).toEqual(bars);
  });

  it("período = N meses fechados + o mês corrente, como history.month_list", () => {
    const now = Date.UTC(2026, 10, 2, 14, 0);
    const r = monthRanges(now, 3);
    expect(r.map((x) => x.key)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(r[0].start).toBe(Date.UTC(2026, 7, 1));
    expect(monthRanges(Date.UTC(2026, 0, 15), 2).map((x) => x.key)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("o custo padrão dos controles é exatamente o do config (0,10 + 0,05)", () => {
    expect(splitCost(DEFAULT_COST)).toEqual({ fee_pct: DEFAULTS.fee_pct, slippage_pct: DEFAULTS.slippage_pct });
    expect(configFrom(INITIAL)).toEqual(DEFAULTS);
    const half = splitCost(0.09);
    expect(half.fee_pct + half.slippage_pct).toBeCloseTo(0.09, 12);
    expect(splitCost(0)).toEqual({ fee_pct: 0, slippage_pct: 0 });
  });
});
