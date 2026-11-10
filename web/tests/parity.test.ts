// Paridade com o motor Python: cada caso de tools/export_parity.py é refeito em TypeScript e
// comparado com o que scripts/*.py devolveram para os mesmos candles sintéticos.
import { describe, expect, it } from "vitest";
import {
  type Bar,
  type Config,
  DEFAULTS,
  Dec,
  PyRandom,
  buildPlan,
  ceilStep,
  closedOnly,
  describe as describeSignal,
  fixedHalfEven,
  fixedPlus,
  floorStep,
  fmtG,
  fmtTs,
  lossPerUnit,
  netR,
  orbSignal,
  parseKlines,
  parseTargetR,
  pyFloatStr,
  pyRound,
  pyRoundInt,
  pySum,
  roundTripCost,
  sessionStart,
  todayUtc,
  utcMs,
} from "../src/engine";
import * as backtest from "../src/engine/backtest";
import * as research from "../src/engine/research";
import * as risk from "../src/engine/risk";
import * as scan from "../src/engine/scan";
import * as size from "../src/engine/size";
import * as tm from "../src/engine/timemachine";
import { attempt, exactSums, expectSame, fixture } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx = fixture();
const cfgWith = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, ...over });
// somas longas: exatas com Python >= 3.12 (soma compensada), 1e-12 relativo antes disso
const SUM_TOL = exactSums() ? 0 : 1e-12;

describe("config", () => {
  it("DEFAULTS é igual a core.DEFAULTS", () => {
    expectSame(DEFAULTS, fx.core.defaults);
  });
});

describe("random.Random (Mersenne Twister do CPython)", () => {
  for (const c of fx.rng) {
    it(`seed ${c.seed}: random(), getrandbits() e choice()`, () => {
      const r = new PyRandom(c.seed);
      expect(c.random.map(() => r.random())).toEqual(c.random);
      expect([1, 5, 13, 32, 31, 8].map((k) => r.getrandbits(k))).toEqual(c.bits);
      const r2 = new PyRandom(c.seed);
      for (const n of [1, 2, 3, 7, 96, 1000, 4096, 100003]) {
        expect(c.choices[String(n)].map(() => r2.randbelow(n))).toEqual(c.choices[String(n)]);
      }
    });
  }
});

describe("números: round(), %g, %.nf, repr(), sum(), Decimal", () => {
  it("round e formatação", () => {
    for (const row of fx.numbers.fmt) {
      const x = row.x as number;
      expect(pyRoundInt(x) === row.r0, `round(${x})`).toBe(true);
      expect([x, pyRound(x, 1), pyRound(x, 2), pyRound(x, 3)]).toEqual([x, row.r1, row.r2, row.r3]);
      expect([x, fmtG(x), fixedHalfEven(x, 2), fixedHalfEven(x, 1), fixedHalfEven(x, 0), fixedPlus(x, 2), pyFloatStr(x)]).toEqual([
        x,
        row.g,
        row.f2,
        row.f1,
        row.f0,
        row.pf2,
        row.repr,
      ]);
    }
  });
  it("sum() com soma compensada", () => {
    for (const s of fx.numbers.sums) expectSame(pySum(s.vals), s.sum, SUM_TOL);
  });
  it("floor_step / ceil_step / dstr", () => {
    for (const s of fx.numbers.steps) {
      const f = floorStep(s.x, s.step);
      const c = ceilStep(s.x, s.step);
      expect([s.x, s.step, f.toString(), c.toString(), f.toNumber(), c.toNumber()]).toEqual([s.x, s.step, s.floor, s.ceil, s.floor_f, s.ceil_f]);
    }
    expect(Dec.from("9000.00000000").isPositive()).toBe(true);
    expect(Dec.from("0.00").isPositive()).toBe(false);
  });
});

describe("core", () => {
  it("orb_signal em todos os estados", () => {
    for (const c of fx.core.signals) {
      const cfg = cfgWith(c.cfg ?? {});
      const closed = closedOnly(c.bars as Bar[], c.now);
      expect(closed.length).toBe(c.n_closed);
      expectSame(orbSignal(closed, c.now, cfg), c.sig);
    }
  });
  it("session_start, utc_ms, today_utc, fmt_ts", () => {
    for (const c of fx.core.session_start) expect(sessionStart(c.ts, c.anchor)).toBe(c.out);
    for (const c of fx.core.utc_ms) expect(utcMs(c.text)).toBe(c.out);
    for (const c of fx.core.today) expect(todayUtc(c.ms)).toBe(c.out);
    for (const c of fx.core.fmt_ts) expect(fmtTs(c.ms, c.tz)).toBe(c.out);
  });
  it("custos: round_trip_cost, net_r, loss_per_unit", () => {
    for (const c of fx.core.costs) {
      expectSame(
        { rt: roundTripCost(c.entry, c.exit, c.fee, c.slip), net_r: netR(c.entry, c.exit, c.stop, c.fee, c.slip), lpu: lossPerUnit(c.entry, c.stop, c.fee, c.slip) },
        { rt: c.rt, net_r: c.net_r, lpu: c.lpu },
      );
    }
  });
  it("parse_klines e parse_target_r", () => {
    expectSame(parseKlines(fx.core.klines.rows), fx.core.klines.out);
    for (const c of fx.core.targets) expectSame(attempt(() => parseTargetR(c.text)), c.out);
  });
});

describe("scan", () => {
  it("pick_universe", () => {
    for (const c of fx.scan.universe) expectSame(scan.pickUniverse(fx.scan.tickers, cfgWith(c.cfg), c.top), c.out);
  });
  it("scan_orb, filter_hits, explain_filtered, contagens", () => {
    const o = fx.scan.orb;
    const res = scan.scanOrb(o.universe, o.now, DEFAULTS, (s) => closedOnly(o.data[s] as Bar[], o.now));
    expectSame(res, o.results);
    expectSame(scan.filterHits(res, DEFAULTS), o.hits);
    expectSame(scan.explainFiltered(res, DEFAULTS), o.explain);
    expectSame(scan.counts(res), o.counts);
  });
});

describe("plan", () => {
  it("build_plan (e as recusas)", () => {
    for (const c of fx.plan.cases) {
      expectSame(attempt(() => buildPlan(c.symbol, c.sig, DEFAULTS, c.stop_rule, c.target_r, c.entry, c.now)), c.out);
    }
  });
  it("describe", () => {
    for (const c of fx.plan.describe) expect(describeSignal(c.sig, DEFAULTS)).toBe(c.out);
  });
});

describe("timemachine", () => {
  const t = fx.timemachine;
  const sessions = tm.fullSessions(t.bars as Bar[], t.plan.params, t.before);

  it("full_sessions e build_pool", () => {
    expect(sessions.map((s) => s.s)).toEqual(t.sessions);
    const holed = (t.bars as Bar[]).slice();
    holed.splice(100, 1);
    expect(tm.fullSessions(holed, t.plan.params, t.before).length).toBe(t.sessions_holed);
    const pool = tm.buildPool(sessions, 96, 2);
    expect(pool.map((p) => p.length / 4)).toEqual(t.pool_lens);
    const p = pool[t.pool_sample.slot];
    expectSame(Array.from(p.subarray(0, 4)), t.pool_sample.first);
    expectSame(Array.from(p.subarray(p.length - 4)), t.pool_sample.last);
  });

  it("percentile", () => {
    for (const c of t.percentile) expectSame(tm.percentile(c.vals, c.p), c.out);
  });

  for (const c of t.mc) {
    it(`run_mc: ${c.replays} replays, seed ${c.seed}, janela ${c.window}, custos ${JSON.stringify(c.cfg)}`, () => {
      expectSame(tm.runMc(t.plan, sessions, cfgWith(c.cfg), c.replays, c.seed, c.window), c.out, SUM_TOL);
    });
  }

  for (const c of t.mc_blocks) {
    it(`run_mc_blocks: ${c.replays} replays, seed ${c.seed}, bloco ${c.mean_block ?? "automático"}, custos ${JSON.stringify(c.cfg)}`, () => {
      expectSame(tm.runMcBlocks(t.plan, sessions, cfgWith(c.cfg), c.replays, c.seed, c.mean_block), c.out, SUM_TOL);
    });
  }

  it("block_length", () => {
    for (const c of t.block_lengths) expect(tm.blockLength(c.n_sessions, c.n)).toBe(c.out);
  });

  it("run_mc com outros planos (stop no fundo da faixa; alvo e stop apertados)", () => {
    for (const c of t.mc_other) expectSame(tm.runMc(c.plan, sessions, DEFAULTS, c.replays, c.seed, c.window), c.out, SUM_TOL);
  });

  it("candle que toca alvo e stop conta como stop", () => {
    const ss = tm.fullSessions(t.wide.bars as Bar[], t.plan.params, t.before);
    expectSame(tm.runMc(t.plan, ss, DEFAULTS, t.wide.replays, t.wide.seed, t.wide.window), t.wide.out, SUM_TOL);
  });

  it("run_history", () => {
    expectSame(tm.runHistory(t.plan, sessions, DEFAULTS), t.history, SUM_TOL);
    const ss = tm.fullSessions(t.known.bars as Bar[], t.plan.params, t.before);
    expectSame(tm.runHistory(t.plan, ss, DEFAULTS), t.known.history, SUM_TOL);
    const low = { ...t.plan, stop_rule: "or-low", target_r: 1.0 };
    expectSame(tm.runHistory(low, ss, cfgWith({ fee_pct: 0.075 })), t.known.history_low, SUM_TOL);
  });

  it("empate exato: mínima igual ao stop e máxima igual ao alvo contam como toque", () => {
    for (const c of t.ties) {
      const ss = tm.fullSessions(c.bars as Bar[], t.plan.params, t.before);
      expectSame(tm.runMc(c.plan, ss, DEFAULTS, 300, 19, 1), c.out, SUM_TOL);
    }
    const ss = tm.fullSessions(t.known_tie.bars as Bar[], t.plan.params, t.before);
    expectSame(tm.runHistory(t.plan, ss, DEFAULTS), t.known_tie.history, SUM_TOL);
    expectSame(tm.runHistory({ ...t.plan, stop: 99.0, stop_rule: "or-low", target_r: 5.0 }, ss, DEFAULTS), t.known_tie.history_low, SUM_TOL);
    expectSame(backtest.evaluate(t.known_tie.bars, cfgWith({ entry_buffer_pct: 0 }), t.known_tie.combos, 0.5, 240, 8, 1.0), t.known_tie.backtest);
  });

  it("verdict", () => {
    for (const c of t.verdicts) expect(tm.verdict({ counts: c.counts }, c.plan, DEFAULTS)).toBe(c.out);
  });

  it("os replays crus dão o mesmo resumo para qualquer custo, sem sortear de novo", () => {
    const raw = tm.runMcRaw(t.plan, sessions, 3000, 19, 2, { recordPaths: true });
    const free = t.mc.find((c: any) => c.replays === 3000 && c.cfg.fee_pct === 0);
    expectSame(tm.summarizeMc(raw, cfgWith(free.cfg)), free.out, SUM_TOL);
    const sorted = Float64Array.from(raw.exit).sort();
    const stats = tm.mcCostStats(raw, sorted, cfgWith(free.cfg));
    expectSame(stats.avg_net_r, free.out.avg_net_r, SUM_TOL);
    // o caminho gravado termina no preço de saída de cada replay
    const risk = raw.entry - raw.stop;
    for (let i = 0; i < raw.replays; i++) {
      const last = (raw.paths as Float32Array)[i * raw.pathLen + raw.len[i] - 1];
      expect(Math.abs(last - (raw.exit[i] - raw.entry) / risk)).toBeLessThan(1e-5);
      expect((raw.paths as Float32Array)[i * raw.pathLen]).toBe(0);
    }
    // o custo só pode piorar o R; os percentis seguem a ordem dos preços de saída
    const paid = tm.mcCostStats(raw, sorted, DEFAULTS);
    expect(paid.avg_net_r).toBeLessThan(stats.avg_net_r);
    expect(paid.p5).toBeLessThanOrEqual(paid.p50);
    expect(paid.p50).toBeLessThanOrEqual(paid.p95);
    expect(paid.max_dd_r).toBeLessThanOrEqual(0);
  });
});

describe("size", () => {
  it("parse_rules", () => {
    for (const c of fx.size_risk.rules) expectSame(attempt(() => size.parseRules(c.info, "BTCUSDT")), c.out);
  });
  it("check_percent_price", () => {
    const rules = size.parseRules(fx.size_risk.rules[0].info, "BTCUSDT");
    for (const c of fx.size_risk.percent_price) expectSame(size.checkPercentPrice(rules, c.avg, c.entry, c.stop), c.out);
  });
  for (const c of fx.size_risk.orders) {
    it(`size_order: ${c.name}`, () => {
      expectSame(attempt(() => size.sizeOrder(c.plan, cfgWith(c.cfg), c.rules, c.avg)), c.out);
    });
  }
});

describe("risk", () => {
  for (const c of fx.size_risk.checks) {
    it(`run_checks: ${c.name}`, () => {
      expectSame(risk.runChecks(c.plan, c.order, cfgWith(c.cfg), c.state, c.now, c.tm), c.out);
    });
  }
});

describe("backtest", () => {
  const b = fx.backtest;
  it("summarize", () => {
    for (const c of b.summarize) expectSame(backtest.summarize(c.rs), c.out);
  });
  it("sessions_for", () => {
    expect(backtest.sessionsFor(b.random.bars, b.sessions.anchor, b.sessions.flat).map((s) => s.s)).toEqual(b.sessions.random);
    expect(backtest.sessionsFor(b.wild.bars, "00:00", 8).map((s) => s.s)).toEqual(b.sessions.wild);
  });
  it("vantagem plantada: treino e teste", () => {
    expectSame(backtest.evaluate(b.planted.bars, DEFAULTS, b.planted.combos, 0.7, 240, 8, 1.0), b.planted.out);
  });
  it("grade padrão (96 combinações) em 120 dias aleatórios", () => {
    const combos = backtest.grid(
      backtest.DEFAULT_GRID.anchors,
      backtest.DEFAULT_GRID.ranges,
      backtest.DEFAULT_GRID.stops,
      backtest.DEFAULT_GRID.targets,
      backtest.DEFAULT_GRID.minRanges,
    );
    expectSame(combos, b.random.combos);
    expect(combos.length).toBe(96);
    expectSame(backtest.evaluate(b.random.bars, DEFAULTS, combos, 0.7, 240, 8, 1.0), b.random.out);
  });
  it("90 dias voláteis com buraco, outros custos e outro corte; e sem custo", () => {
    const w = b.wild;
    expectSame(backtest.evaluate(w.bars, cfgWith(w.cfg), w.combos, w.split, 240, 8, 1.0), w.out);
    // os trades não dependem de custo: o mesmo conjunto dá o resultado com e sem taxa
    const trades = backtest.evaluateTrades(w.bars, DEFAULTS.entry_buffer_pct, w.combos, w.split, 240, 8, 1.0);
    expectSame(
      trades.map((t) => backtest.summarizeCombo(t, cfgWith(w.cfg))),
      w.out,
    );
    expectSame(
      trades.map((t) => backtest.summarizeCombo(t, { fee_pct: 0, slippage_pct: 0 })),
      w.free,
    );
  });
});

describe("research", () => {
  // Único ponto com tolerância: o Python eleva ao quadrado com pow() da libc e o JS com x*x;
  // o último bit do desvio-padrão pode diferir. Só afeta erro-padrão e t do perfil por hora.
  const POW_TOL = 1e-12;
  for (const [name, s] of Object.entries<any>(fx.research.series)) {
    it(`série "${name}": agregação, horário, sazonalidade, Donchian, walk-forward, buy & hold`, () => {
      const bars = s.bars as Bar[];
      const cfg = cfgWith(s.cfg);
      const o = s.out;
      const hourly = research.toHourly(bars);
      const daily = research.toDaily(bars);
      expect([hourly.length, daily.length]).toEqual([o.hourly_n, o.daily_n]);
      expectSame(hourly.slice(0, 3), o.hourly_head);
      expectSame(hourly.slice(-2), o.hourly_tail);
      expectSame(daily.slice(0, 2), o.daily_head);
      expectSame(daily.slice(-2), o.daily_tail);
      const prof = research.hourProfile(hourly);
      expectSame(
        prof.map((r) => [r[0], r[1], r[2]]),
        o.hour_profile.map((r: any) => [r[0], r[1], r[2]]),
        SUM_TOL,
      );
      expectSame(prof, o.hour_profile, POW_TOL);
      const sr = research.seasonReturns(hourly, s.buy, s.sell, cfg);
      expectSame(sr, o.season);
      expectSame(research.summarize(sr, 365), o.season_sum);
      expectSame(research.costRt(cfg), o.cost_rt);
      for (const lb of s.lookbacks as number[]) {
        const dr = research.donchianReturns(daily, lb, cfg);
        expectSame(dr, o.donchian[String(lb)]);
        expectSame(research.summarize(dr, 365), o.donchian_sum[String(lb)]);
      }
      const [oos, chosen] = research.walkForward(
        (p: { lookback: number }) => research.donchianReturns(daily, p.lookback, cfg),
        (s.lookbacks as number[]).map((lookback) => ({ lookback })),
        4,
      );
      expectSame(oos, o.wf_oos);
      expectSame(chosen, o.wf_chosen);
      const bh = research.buyHold(daily);
      expectSame(bh, o.bh);
      expectSame(research.summarize(bh, 365), o.bh_sum);

      // o caminho do painel (retornos crus + custo aplicado depois) dá o mesmo que run_symbol
      const raw = research.researchRaw(bars, s.lookbacks, s.buy, s.sell);
      const r = research.researchAtCost(raw, cfg);
      expectSame({ season: r.season, trend_wf: r.trend_wf, bh: r.bh }, o.run_symbol);
      expectSame(r.season_gross, o.season_gross_sum);
      expectSame(r.bh_oos, o.bh_oos_sum);
      expectSame(r.wf_chosen, o.wf_chosen.map((c: any) => c.lookback));
      for (const d of r.donchian) {
        expectSame(d.net, o.donchian_sum[String(d.lookback)]);
        expect(o.report.some((line: string) => line.includes(`N=${String(d.lookback).padEnd(3)} ${research.fmtSummary(d.net)} | ~${d.entries} entradas`))).toBe(true);
      }
      expect(o.report).toContain("Comprar e segurar: " + research.fmtSummary(r.bh));
      expect(o.report).toContain("   " + research.fmtSummary(r.season));
    });
  }
  it("walk_forward só usa o passado", () => {
    const w = fx.research.wf_toy;
    const [oos, chosen] = research.walkForward((p: { k: number }) => w.series[String(p.k)], [{ k: 5 }, { k: 7 }], 4);
    expectSame(oos, w.oos);
    expectSame(chosen, w.chosen);
  });
  it("summarize", () => {
    for (const c of fx.research.summarize) expectSame(research.summarize(c.rets, c.ppy), c.out);
  });
});
